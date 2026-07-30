// One-time (or "run again whenever you refresh your bulk data") importer:
// streams a Scryfall bulk-data file (the big all-cards-*.jsonl / .json dump
// you download from https://scryfall.com/docs/api/bulk-data) into a local
// cards.sqlite database, so deck import can look cards up instantly and
// offline instead of hitting the live Scryfall API every time.
//
// Uses Node's built-in `node:sqlite` (stable enough for this, no native
// module to compile — that matters because better-sqlite3 needs a network
// connection to fetch a prebuilt binary or the Node headers to compile from
// source, which isn't always available) — no extra npm dependency at all.
// Requires Node >= 22.5.0.
//
// Usage:
//   npm run import-cards -- /path/to/all-cards-XXXXXXXX.jsonl
//   (or just `npm run import-cards` if the file is a *.jsonl in the project
//   root — it'll find it automatically)
//
// Keeps EVERY English-language printing of every card (not deduped to one
// printing per name) — deliberately, so custom decks can later pick a
// specific art/printing instead of always getting whatever Scryfall
// considers "the" version.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { DatabaseSync } = require('node:sqlite');

const PROJECT_ROOT = path.join(__dirname, '..');
const DB_PATH = path.join(PROJECT_ROOT, 'cards.sqlite');

// --append: skip wiping/recreating the DB, just open the existing one and
// insert more rows into it. Used to import a huge bulk file in pieces
// (see chunked-import.sh) when a single pass would run long enough to hit
// an external time limit — each chunk still commits durably on its own, so
// nothing is lost if a later chunk doesn't run yet.
const APPEND = process.argv.includes('--append');
const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));

function findInputFile() {
  const argPath = positional[0];
  if (argPath) return path.resolve(argPath);
  let candidates = fs.readdirSync(PROJECT_ROOT).filter((f) => /\.jsonl?$/i.test(f) && f !== 'package.json' && f !== 'package-lock.json');
  // Scryfall's bulk-data downloads all land in the project root with their
  // own descriptive prefixes (all-cards-*, rulings-*, etc) — if there's more
  // than one .jsonl file sitting around (e.g. you've also downloaded
  // rulings for scripts/import-rulings.js), prefer one that's actually the
  // card dump rather than immediately giving up.
  if (candidates.length > 1) {
    const cardLike = candidates.filter((f) => /all[-_]?cards|default[-_]?cards|oracle[-_]?cards/i.test(f));
    if (cardLike.length === 1) candidates = cardLike;
  }
  if (candidates.length === 0) {
    console.error('No bulk-data file given and none found automatically. Usage: node scripts/import-cards.js /path/to/all-cards-*.jsonl');
    process.exit(1);
  }
  if (candidates.length > 1) {
    console.error(`Found multiple candidate files, please specify one explicitly: ${candidates.join(', ')}`);
    process.exit(1);
  }
  return path.join(PROJECT_ROOT, candidates[0]);
}

function json(value) {
  return value === undefined ? null : JSON.stringify(value);
}

async function main() {
  const inputPath = findInputFile();
  console.log(`Reading bulk data from: ${inputPath}`);
  console.log(`Writing to: ${DB_PATH}${APPEND ? ' (appending)' : ''}`);

  if (!APPEND && fs.existsSync(DB_PATH)) {
    fs.unlinkSync(DB_PATH); // fresh import each run — this is a rebuildable cache, not hand-edited data
  }

  const db = new DatabaseSync(DB_PATH);
  if (!APPEND) db.exec(`
    CREATE TABLE cards (
      id TEXT PRIMARY KEY,
      oracle_id TEXT,
      name TEXT NOT NULL,
      set_code TEXT,
      set_name TEXT,
      collector_number TEXT,
      released_at TEXT,
      layout TEXT,
      mana_cost TEXT,
      cmc REAL,
      type_line TEXT,
      oracle_text TEXT,
      power TEXT,
      toughness TEXT,
      loyalty TEXT,
      defense TEXT,
      colors TEXT,
      color_identity TEXT,
      keywords TEXT,
      rarity TEXT,
      digital INTEGER,
      promo INTEGER,
      games TEXT,
      image_small TEXT,
      image_normal TEXT,
      image_large TEXT,
      image_back_normal TEXT,
      card_faces TEXT,
      legalities TEXT,
      all_parts TEXT,
      scryfall_uri TEXT
    );
    CREATE INDEX idx_cards_name ON cards(name COLLATE NOCASE);
    CREATE INDEX idx_cards_oracle ON cards(oracle_id);
  `);

  const insert = db.prepare(`
    INSERT INTO cards (
      id, oracle_id, name, set_code, set_name, collector_number, released_at, layout,
      mana_cost, cmc, type_line, oracle_text, power, toughness, loyalty, defense,
      colors, color_identity, keywords, rarity, digital, promo, games,
      image_small, image_normal, image_large, image_back_normal,
      card_faces, legalities, all_parts, scryfall_uri
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?
    )
  `);

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
    if (!line || line === '[' || line === ']' || line === ',') continue; // tolerate a plain JSON-array bulk file, not just JSONL
    // Cheap pre-filter before paying for a full JSON.parse — about 4 out of
    // 5 rows in the "all cards" dump aren't English, so skipping the parse
    // for those is a meaningful speedup over 500k+ lines.
    if (!line.includes('"lang":"en"')) continue;

    let trimmed = line.trim().replace(/,$/, ''); // tolerate a trailing comma if this came from a pretty-printed JSON array
    let card;
    try {
      card = JSON.parse(trimmed);
    } catch {
      continue; // skip any malformed line rather than aborting the whole import
    }
    if (card.object !== 'card' || card.lang !== 'en') continue;

    const face0 = card.card_faces && card.card_faces[0];
    const face1 = card.card_faces && card.card_faces[1];
    const imageUris = card.image_uris || (face0 && face0.image_uris) || null;
    const backImageUris = (face1 && face1.image_uris) || null;
    // A small number of very-recently-previewed cards have no scan yet —
    // Scryfall fills image_uris with a placeholder on errors.scryfall.com
    // ("soon.jpg") instead of leaving it null. Treat that the same as no
    // image at all, so the app falls back to a text-label card instead of
    // trying (and failing) to fetch a fake "coming soon" image forever.
    const isRealScryfallImage = (u) => !!u && u.startsWith('https://cards.scryfall.io/');

    insert.run(
      card.id,
      card.oracle_id || null,
      card.name,
      card.set || null,
      card.set_name || null,
      card.collector_number || null,
      card.released_at || null,
      card.layout || null,
      card.mana_cost || (face0 && face0.mana_cost) || '',
      card.cmc ?? null,
      card.type_line || null,
      card.oracle_text || (face0 && face0.oracle_text) || null,
      card.power ?? (face0 && face0.power) ?? null,
      card.toughness ?? (face0 && face0.toughness) ?? null,
      card.loyalty ?? (face0 && face0.loyalty) ?? null,
      card.defense ?? (face0 && face0.defense) ?? null,
      json(card.colors || (face0 && face0.colors)),
      json(card.color_identity),
      json(card.keywords),
      card.rarity || null,
      card.digital ? 1 : 0,
      card.promo ? 1 : 0,
      json(card.games),
      (isRealScryfallImage(imageUris && imageUris.small) && imageUris.small) || null,
      (isRealScryfallImage(imageUris && (imageUris.normal || imageUris.large)) && (imageUris.normal || imageUris.large)) || null,
      (isRealScryfallImage(imageUris && imageUris.large) && imageUris.large) || null,
      (isRealScryfallImage(backImageUris && (backImageUris.normal || backImageUris.large)) && (backImageUris.normal || backImageUris.large)) || null,
      json(card.card_faces),
      json(card.legalities),
      json(card.all_parts),
      card.scryfall_uri || null
    );
    inserted++;

    if (inserted % 20000 === 0) {
      console.log(`  ...${inserted} English cards inserted (${totalLines} lines scanned)`);
    }
  }

  db.exec('COMMIT');
  db.close();

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  const dbSizeMb = (fs.statSync(DB_PATH).size / (1024 * 1024)).toFixed(1);
  console.log('');
  console.log(`Done in ${elapsedSec}s.`);
  console.log(`Scanned ${totalLines} total lines, kept ${inserted} English card printings.`);
  console.log(`Database written to ${DB_PATH} (${dbSizeMb} MB).`);
}

main().catch((err) => {
  console.error('Import failed:', err);
  process.exit(1);
});
