// Imports a Scryfall "Rulings" bulk-data file (https://scryfall.com/docs/api/bulk-data)
// into the same cards.sqlite database used by import-cards.js, as a
// separate `rulings` table keyed by oracle_id — the same id every row in
// the `cards` table already has, so a card can be joined to its rulings
// with a single indexed lookup.
//
// Unlike the "all cards" dump, this file is small (tens of thousands of
// lines, tens of MB) — no chunking/--append dance needed, one pass handles
// the whole thing comfortably.
//
// Usage:
//   npm run import-rulings -- /path/to/rulings-XXXXXXXX.jsonl
//   (or just `npm run import-rulings` if it's the only rulings-*.jsonl
//   sitting in the project root — it'll find it automatically)

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { DatabaseSync } = require('node:sqlite');

const PROJECT_ROOT = path.join(__dirname, '..');
const DB_PATH = path.join(PROJECT_ROOT, 'cards.sqlite');

const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));

function findInputFile() {
  const argPath = positional[0];
  if (argPath) return path.resolve(argPath);
  let candidates = fs.readdirSync(PROJECT_ROOT).filter((f) => /\.jsonl?$/i.test(f) && f !== 'package.json' && f !== 'package-lock.json');
  if (candidates.length > 1) {
    const rulingsLike = candidates.filter((f) => /rulings/i.test(f));
    if (rulingsLike.length === 1) candidates = rulingsLike;
  }
  if (candidates.length === 0) {
    console.error('No rulings file given and none found automatically. Usage: node scripts/import-rulings.js /path/to/rulings-*.jsonl');
    process.exit(1);
  }
  if (candidates.length > 1) {
    console.error(`Found multiple candidate files, please specify one explicitly: ${candidates.join(', ')}`);
    process.exit(1);
  }
  return path.join(PROJECT_ROOT, candidates[0]);
}

async function main() {
  const inputPath = findInputFile();
  if (!fs.existsSync(DB_PATH)) {
    console.error(`No card database found at ${DB_PATH}. Run "npm run import-cards" first — rulings are joined to cards by oracle_id.`);
    process.exit(1);
  }

  console.log(`Reading rulings from: ${inputPath}`);
  console.log(`Writing into: ${DB_PATH}`);

  const db = new DatabaseSync(DB_PATH);
  db.exec('DROP TABLE IF EXISTS rulings'); // rebuildable cache, same philosophy as the cards table itself
  db.exec(`
    CREATE TABLE rulings (
      oracle_id TEXT NOT NULL,
      source TEXT,
      published_at TEXT,
      comment TEXT NOT NULL
    );
    CREATE INDEX idx_rulings_oracle ON rulings(oracle_id);
  `);
  const insert = db.prepare('INSERT INTO rulings (oracle_id, source, published_at, comment) VALUES (?, ?, ?, ?)');

  let totalLines = 0;
  let inserted = 0;
  const startedAt = Date.now();

  db.exec('BEGIN TRANSACTION');
  const rl = readline.createInterface({
    input: fs.createReadStream(inputPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    totalLines++;
    const trimmed = line.trim().replace(/,$/, '');
    if (!trimmed || trimmed === '[' || trimmed === ']') continue;
    let ruling;
    try {
      ruling = JSON.parse(trimmed);
    } catch {
      continue; // skip a malformed line rather than aborting the whole import
    }
    if (ruling.object !== 'ruling' || !ruling.oracle_id || !ruling.comment) continue;

    insert.run(ruling.oracle_id, ruling.source || null, ruling.published_at || null, ruling.comment);
    inserted++;
  }
  db.exec('COMMIT');
  db.close();

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\nDone in ${elapsedSec}s.`);
  console.log(`Scanned ${totalLines} lines, inserted ${inserted} rulings.`);
}

main().catch((err) => {
  console.error('Rulings import failed:', err);
  process.exit(1);
});
