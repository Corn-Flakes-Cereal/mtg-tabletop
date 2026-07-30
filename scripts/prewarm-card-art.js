// Pre-downloads every card image referenced by the local card database into
// card-art-cache/, so gameplay never has to hit Scryfall for art at all
// (except for a genuinely new card released after your bulk-data snapshot).
// This is the same disk cache the /card-art route in server.js already
// fills in lazily on first use — this script just does it for everything
// up front, using the exact same filename scheme (sha1 of the URL + its
// extension), so the two are fully interchangeable: whatever this script
// downloads, the running server will find already on disk and serve
// instantly, and vice versa.
//
// Resumable by construction: it skips any URL whose file already exists, so
// if you Ctrl+C partway through (or it's interrupted for any reason), just
// run it again later and it'll pick up wherever it left off — no separate
// "resume" flag or state file needed.
//
// Usage:
//   npm run prewarm-art
//   npm run prewarm-art -- --concurrency=16
//
// This has to run somewhere with real internet access to cards.scryfall.io.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const PROJECT_ROOT = path.join(__dirname, '..');
const DB_PATH = path.join(PROJECT_ROOT, 'cards.sqlite');
const CARD_ART_CACHE_DIR = path.join(PROJECT_ROOT, 'card-art-cache');

const CONCURRENCY = (() => {
  const arg = process.argv.find((a) => a.startsWith('--concurrency='));
  const n = arg ? parseInt(arg.split('=')[1], 10) : 10;
  return Number.isFinite(n) && n > 0 ? n : 10;
})();
const MAX_RETRIES = 3;

const USER_AGENT_HEADERS = {
  // Same headers as server.js's /card-art route — Scryfall's CDN rejects
  // requests with no real User-Agent.
  'User-Agent': 'mtg-tabletop-selfhosted/1.0 (+https://scryfall.com/docs/api/bulk-data)',
  Accept: 'image/*',
};

function filePathFor(url) {
  const parsed = new URL(url);
  const hash = crypto.createHash('sha1').update(url).digest('hex');
  const ext = path.extname(parsed.pathname) || '.jpg';
  return path.join(CARD_ART_CACHE_DIR, hash + ext);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function downloadOne(url) {
  const filePath = filePathFor(url);
  if (fs.existsSync(filePath)) return 'skipped';

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { headers: USER_AGENT_HEADERS });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(filePath, buffer);
      return 'downloaded';
    } catch (err) {
      if (attempt === MAX_RETRIES - 1) return { failed: err.message };
      await sleep(400 * (attempt + 1));
    }
  }
}

// Simple bounded-concurrency worker pool — pulls the next URL off the
// shared queue as each worker frees up, rather than firing everything at
// once (117k simultaneous requests would be neither polite nor useful).
async function runPool(urls, concurrency, onProgress) {
  let index = 0;
  const counts = { downloaded: 0, skipped: 0, failed: 0 };
  const failures = [];

  async function worker() {
    while (index < urls.length) {
      const url = urls[index++];
      const result = await downloadOne(url);
      if (result === 'downloaded') counts.downloaded++;
      else if (result === 'skipped') counts.skipped++;
      else {
        counts.failed++;
        failures.push({ url, error: result.failed });
      }
      onProgress(counts);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  return { counts, failures };
}

async function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`No card database found at ${DB_PATH}. Run "npm run import-cards" first.`);
    process.exit(1);
  }
  fs.mkdirSync(CARD_ART_CACHE_DIR, { recursive: true });

  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const fronts = db.prepare('SELECT DISTINCT image_normal AS url FROM cards WHERE image_normal IS NOT NULL').all();
  const backs = db.prepare('SELECT DISTINCT image_back_normal AS url FROM cards WHERE image_back_normal IS NOT NULL').all();
  db.close();

  const urls = [...new Set([...fronts.map((r) => r.url), ...backs.map((r) => r.url)])];
  console.log(`Found ${urls.length} distinct card images referenced by the local database.`);
  console.log(`Downloading with concurrency=${CONCURRENCY} into ${CARD_ART_CACHE_DIR}`);
  console.log('Safe to interrupt (Ctrl+C) and resume later — already-downloaded files are skipped.\n');

  const startedAt = Date.now();
  let lastPrint = 0;

  const { counts, failures } = await runPool(urls, CONCURRENCY, (counts) => {
    const done = counts.downloaded + counts.skipped + counts.failed;
    const now = Date.now();
    // Print progress at most every ~2 seconds (or on the last item) rather
    // than on every single completion — this can be tens of thousands of
    // updates over a long run.
    if (now - lastPrint < 2000 && done < urls.length) return;
    lastPrint = now;

    const elapsedSec = (now - startedAt) / 1000;
    const rate = done / Math.max(elapsedSec, 0.001); // items/sec
    const remaining = urls.length - done;
    const etaSec = rate > 0 ? remaining / rate : 0;
    const pct = ((done / urls.length) * 100).toFixed(1);
    console.log(
      `${done}/${urls.length} (${pct}%) — downloaded ${counts.downloaded}, already cached ${counts.skipped}, failed ${counts.failed}` +
        ` — ${rate.toFixed(1)}/s, ETA ${formatDuration(etaSec)}`
    );
  });

  const totalSec = (Date.now() - startedAt) / 1000;
  console.log(`\nDone in ${formatDuration(totalSec)}.`);
  console.log(`Downloaded: ${counts.downloaded}, already cached: ${counts.skipped}, failed: ${counts.failed}.`);
  if (failures.length) {
    console.log(`\n${failures.length} image(s) failed after ${MAX_RETRIES} attempts each:`);
    failures.slice(0, 20).forEach((f) => console.log(`  ${f.url} — ${f.error}`));
    if (failures.length > 20) console.log(`  ...and ${failures.length - 20} more.`);
    console.log('\nJust run this script again later to retry only the ones that failed — everything already downloaded is skipped automatically.');
  }
}

function formatDuration(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '?';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

main().catch((err) => {
  console.error('Prewarm failed:', err);
  process.exit(1);
});
