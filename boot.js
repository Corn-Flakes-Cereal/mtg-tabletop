// Startup wrapper for hosted deployments. cards.sqlite (~250MB) is
// deliberately gitignored — it's generated data, not source — so it won't
// exist yet on a fresh deploy. If CARDS_DB_URL is set (e.g. pointing at a
// GitHub Release asset you uploaded it to) and the file isn't already on
// disk, this fetches it once before the real server starts. Locally, you
// don't need this at all — cards.sqlite is already sitting next to
// server.js, so this is a no-op and server.js starts immediately.
//
// Deliberately kept separate from server.js rather than folded into it:
// server.js's existing startup is synchronous top-to-bottom (opens the DB,
// registers routes, starts listening), and a network download has to be
// async — bolting that on in-place would mean restructuring code that
// already works. Isolating the "maybe fetch a file first" step here means
// server.js needed zero changes.

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const CARD_DB_PATH = path.join(__dirname, 'cards.sqlite');
const CARDS_DB_URL = process.env.CARDS_DB_URL;

function download(url, dest, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    client
      .get(url, (res) => {
        // GitHub Release assets (and most CDNs) redirect the actual download
        // to a signed storage URL — has to be followed manually since we're
        // using the raw http(s) module rather than a fetch() that does it
        // for us.
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) {
            reject(new Error('Too many redirects while downloading cards.sqlite'));
            return;
          }
          download(res.headers.location, dest, redirectsLeft - 1).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`Download failed: HTTP ${res.statusCode} for ${url}`));
          res.resume();
          return;
        }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
        file.on('error', reject);
      })
      .on('error', reject);
  });
}

async function main() {
  if (!fs.existsSync(CARD_DB_PATH)) {
    if (CARDS_DB_URL) {
      console.log('cards.sqlite not found locally — downloading from CARDS_DB_URL...');
      const tmpPath = `${CARD_DB_PATH}.downloading`;
      try {
        await download(CARDS_DB_URL, tmpPath);
        fs.renameSync(tmpPath, CARD_DB_PATH);
        const { size } = fs.statSync(CARD_DB_PATH);
        console.log(`cards.sqlite downloaded successfully (${(size / 1024 / 1024).toFixed(1)} MB).`);
      } catch (err) {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        console.error('Failed to download cards.sqlite:', err.message);
        console.error('Continuing without a local card database — deck import will fall back to live Scryfall lookups.');
      }
    } else {
      console.log('cards.sqlite not found and CARDS_DB_URL is not set — deck import will use the live Scryfall API instead of the local database.');
    }
  }
  require('./server.js');
}

main();
