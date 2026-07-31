// MTG Tabletop — a bookkeeping server for playing regular Magic: The Gathering
// with friends online. It does NOT enforce game rules, mana, or the stack —
// it just syncs zones, life totals, taps, counters, and tokens between
// everyone's browser in real time. You still call your own plays.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { nanoid } = require('nanoid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 5e6, // decklists / card batches can be sizeable
});

app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Card art cache — proxies and caches Scryfall's card images on disk so
// repeat games (and every player at the same table) reuse one local copy
// instead of re-fetching from Scryfall every time. Scryfall's own API docs
// say hotlinking their images "isn't recommended" since the URLs can change,
// and they encourage caching data locally — this does that, and also means
// games keep working even if Scryfall is briefly slow or unreachable.
// (Their 10 req/sec rate limit only applies to api.scryfall.com, not the
// image CDN, so this app was never at real risk of being throttled — this
// is just good practice, not a fix for a real problem.)
// ---------------------------------------------------------------------------
const CARD_ART_CACHE_DIR = path.join(__dirname, 'card-art-cache');
fs.mkdirSync(CARD_ART_CACHE_DIR, { recursive: true });

app.get('/card-art', async (req, res) => {
  const src = req.query.src;
  if (!src || typeof src !== 'string') return res.status(400).send('Missing src');
  let parsed;
  try {
    parsed = new URL(src);
  } catch {
    return res.status(400).send('Bad src URL');
  }
  // This isn't a general-purpose proxy — only ever fetch from Scryfall's own
  // card-art CDN, the one source this app trusts.
  if (parsed.hostname !== 'cards.scryfall.io') return res.status(400).send('Unsupported host');

  const hash = crypto.createHash('sha1').update(src).digest('hex');
  const ext = path.extname(parsed.pathname) || '.jpg';
  const filePath = path.join(CARD_ART_CACHE_DIR, hash + ext);

  if (fs.existsSync(filePath)) {
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    return res.sendFile(filePath);
  }

  try {
    // Scryfall's CDN rejects requests with no real User-Agent (Node's default
    // fetch doesn't send a normal browser-like one) — confirmed that's what
    // was happening here: our server reached them fine, but they responded
    // 400 to the bare request. A descriptive User-Agent is also just good
    // practice per Scryfall's own API guidelines.
    const upstream = await fetch(src, {
      headers: {
        'User-Agent': 'mtg-tabletop-selfhosted/1.0 (+https://scryfall.com/docs/api/bulk-data)',
        Accept: 'image/*',
      },
    });
    if (!upstream.ok) return res.status(upstream.status).send('Upstream fetch failed');
    const buffer = Buffer.from(await upstream.arrayBuffer());
    fs.writeFile(filePath, buffer, (err) => {
      if (err) console.error('Failed to write card art cache file:', filePath, err);
    });
    res.set('Content-Type', upstream.headers.get('content-type') || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(buffer);
  } catch (err) {
    console.error('card-art proxy fetch failed for', src, err);
    res.status(502).send('Fetch failed');
  }
});

// ---------------------------------------------------------------------------
// Local card database — a SQLite snapshot built from a Scryfall bulk-data
// dump (see scripts/import-cards.js) so deck import can resolve card names
// instantly and offline instead of hitting the live Scryfall API every time.
// Entirely optional: if cards.sqlite doesn't exist (nobody's run the import
// script yet), every lookup just falls through to the live API below, same
// as this app always worked before.
// ---------------------------------------------------------------------------
const CARD_DB_PATH = path.join(__dirname, 'cards.sqlite');
let cardDb = null;
let lookupCardStmt = null;
let lookupRulingsStmt = null;
if (fs.existsSync(CARD_DB_PATH)) {
  try {
    const { DatabaseSync } = require('node:sqlite');
    cardDb = new DatabaseSync(CARD_DB_PATH, { readOnly: true });
    // Matches on the full name, or the front-face name of a combined
    // "Front // Back" name — decklists usually just say "Delver of Secrets",
    // not "Delver of Secrets // Insectile Aberration". Prefers a paper
    // (non-digital) printing, then the most recently released one.
    lookupCardStmt = cardDb.prepare(`
      SELECT * FROM cards
      WHERE name = ? COLLATE NOCASE OR name LIKE (? || ' // %') COLLATE NOCASE
      ORDER BY digital ASC, released_at DESC
      LIMIT 1
    `);
    console.log(`Local card database loaded: ${CARD_DB_PATH}`);
    // Rulings (see scripts/import-rulings.js) are an optional add-on table —
    // the app works fine without it, "View Rulings" just always comes back
    // empty. A card's `oracle_id` is shared by every printing of it (and by
    // both faces of a double-faced card), so one lookup covers the whole
    // card regardless of which printing/face you're looking at.
    try {
      lookupRulingsStmt = cardDb.prepare('SELECT source, published_at, comment FROM rulings WHERE oracle_id = ? ORDER BY published_at');
      console.log('Rulings table found — card previews can show official rulings.');
    } catch {
      lookupRulingsStmt = null;
      console.log('No rulings table found (run "npm run import-rulings" to add one) — "View Rulings" will show no results.');
    }
  } catch (err) {
    console.error('Failed to open local card database, falling back to live Scryfall lookups only:', err.message);
    cardDb = null;
    lookupCardStmt = null;
  }
} else {
  console.log('No local card database found (cards.sqlite) — deck import will use the live Scryfall API. Run "npm run import-cards" with a Scryfall bulk-data file to build one.');
}

// Wraps a Scryfall image URL so the browser fetches it through our own
// /card-art cache instead of hotlinking cards.scryfall.io directly.
function cachedImageUrl(url) {
  return url ? `/card-art?src=${encodeURIComponent(url)}` : null;
}

// Normalizes either a local DB row or a live Scryfall API card object into
// the flat shape set_library already expects (name/id/image/manaCost/
// typeLine/power/toughness), plus a `back` object for genuine two-sided
// cards (transform/modal-DFC — layouts where the second face has its own
// distinct art, not split/adventure/flip cards which are a single image).
// `name`/`typeLine`/`power`/`toughness` here are always the FRONT face's —
// for a plain single-faced card that's just the card itself.
function dbRowToCard(row) {
  const faces = row.card_faces ? JSON.parse(row.card_faces) : null;
  const face0 = faces && faces[0];
  const face1 = faces && faces[1];
  const backImage = cachedImageUrl(row.image_back_normal);
  return {
    name: (face0 && face0.name) || row.name,
    id: row.id,
    oracleId: row.oracle_id || null,
    layout: row.layout || null,
    image: cachedImageUrl(row.image_normal),
    manaCost: row.mana_cost || '',
    typeLine: (face0 && face0.type_line) || row.type_line || '',
    power: row.power ?? null,
    toughness: row.toughness ?? null,
    back: backImage && face1
      ? {
          name: face1.name,
          image: backImage,
          typeLine: face1.type_line || '',
          power: face1.power ?? null,
          toughness: face1.toughness ?? null,
        }
      : null,
  };
}
function scryfallApiCardToCard(card) {
  const face0 = card.card_faces && card.card_faces[0];
  const face1 = card.card_faces && card.card_faces[1];
  const image = (card.image_uris && (card.image_uris.normal || card.image_uris.large))
    || (face0 && face0.image_uris && (face0.image_uris.normal || face0.image_uris.large))
    || null;
  const backImageRaw = (face1 && face1.image_uris && (face1.image_uris.normal || face1.image_uris.large)) || null;
  const backImage = cachedImageUrl(backImageRaw);
  return {
    name: (face0 && face0.name) || card.name,
    id: card.id,
    oracleId: card.oracle_id || null,
    layout: card.layout || null,
    image: cachedImageUrl(image),
    manaCost: card.mana_cost || (face0 && face0.mana_cost) || '',
    typeLine: (face0 && face0.type_line) || card.type_line || '',
    power: card.power ?? (face0 && face0.power) ?? null,
    toughness: card.toughness ?? (face0 && face0.toughness) ?? null,
    back: backImage && face1
      ? {
          name: face1.name,
          image: backImage,
          typeLine: face1.type_line || '',
          power: face1.power ?? null,
          toughness: face1.toughness ?? null,
        }
      : null,
  };
}

// Looks up names not found in the local DB against the live Scryfall API —
// covers cards released after the bulk-data snapshot was taken, or the
// no-local-DB-at-all case. Batches in groups of 75 per Scryfall's collection
// endpoint limit.
async function resolveNamesFromLiveScryfall(names) {
  const found = new Map(); // lowercase name -> scryfall card
  const notFound = [];
  for (let i = 0; i < names.length; i += 75) {
    const batch = names.slice(i, i + 75);
    let data;
    try {
      const resp = await fetch('https://api.scryfall.com/cards/collection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifiers: batch.map((name) => ({ name })) }),
      });
      data = await resp.json();
    } catch (err) {
      console.error('Live Scryfall lookup failed:', err.message);
      batch.forEach((name) => notFound.push(name));
      continue;
    }
    (data.data || []).forEach((card) => {
      found.set(card.name.toLowerCase(), card);
      const front = card.name.split(' // ')[0].toLowerCase();
      if (!found.has(front)) found.set(front, card);
    });
    (data.not_found || []).forEach((nf) => notFound.push(nf.name));
  }
  return { found, notFound };
}

// ---------------------------------------------------------------------------
// In-memory game state
// ---------------------------------------------------------------------------
// rooms[code] = {
//   code,
//   players: { [playerId]: playerState },
//   playerOrder: [playerId, ...],
//   sockets: { [playerId]: socketId },   // current live socket for a player
//   log: [{ id, text, ts }],
//   pinned: false,      // true = "keep this table alive" was pressed, never auto-expires
//   emptySince: null,   // timestamp when the last connected player left, or null if someone's connected
// }

const rooms = {};

// How long an unpinned, fully-disconnected table sticks around before its
// state is wiped, and how often we sweep for expired ones.
const EMPTY_ROOM_TIMEOUT_MS = 15 * 60 * 1000;
const ROOM_SWEEP_INTERVAL_MS = 30 * 1000;

function isRoomEmpty(room) {
  return room.playerOrder.every((pid) => !room.players[pid]?.connected);
}

// Call after any disconnect/leave — starts (or leaves running) the empty-room
// clock. Only actually starts the clock the first time the room goes empty,
// so a second player leaving right after the first doesn't reset the timer.
function markEmptyIfNeeded(room) {
  if (isRoomEmpty(room) && room.emptySince == null) {
    room.emptySince = Date.now();
  }
}

const ZONES = ['library', 'hand', 'battlefield', 'graveyard', 'exile'];

// Battlefield card x/y are in the client's fixed "board space" (see BOARD_W/
// BOARD_H in public/app.js) — the server just stores whatever numbers the
// client sends; these are only the fallback used when a card lands on the
// battlefield without explicit coordinates (e.g. a freshly created token).
const BOARD_CENTER_X = 500;
const BOARD_CENTER_Y = 320;

function newPlayerState(name) {
  return {
    name,
    life: 20,
    poison: 0,
    library: [],
    hand: [],
    battlefield: [],
    graveyard: [],
    exile: [],
    connected: true,
  };
}

function makeRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
  let code;
  do {
    code = Array.from({ length: 5 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  } while (rooms[code]);
  return code;
}

function getRoom(code) {
  return rooms[code.toUpperCase()];
}

function log(room, text) {
  const entry = { id: nanoid(), text, ts: Date.now() };
  room.log.push(entry);
  if (room.log.length > 300) room.log.shift();
  return entry;
}

function findCard(zoneArr, uid) {
  return zoneArr.findIndex((c) => c.uid === uid);
}

// Finds a card by uid no matter which zone it's currently sitting in for that
// player — needed for transform_card, since modal-DFC "play as the other
// face" now makes sense to offer from hand (not just the battlefield, unlike
// a genuine transform flip).
function findCardAnyZone(player, uid) {
  for (const zone of ZONES) {
    const card = player[zone].find((c) => c.uid === uid);
    if (card) return card;
  }
  return null;
}

// Build the state a specific player is allowed to see: their own hand/library
// contents in full, but only counts for opponents' hidden zones.
function viewFor(room, viewerId) {
  const players = {};
  for (const pid of room.playerOrder) {
    const p = room.players[pid];
    if (!p) continue;
    const isSelf = pid === viewerId;
    players[pid] = {
      name: p.name,
      life: p.life,
      poison: p.poison,
      connected: p.connected,
      battlefield: p.battlefield, // always public
      graveyard: p.graveyard, // public zone in real MTG
      exile: p.exile, // public zone in real MTG
      hand: isSelf ? p.hand : new Array(p.hand.length).fill(null),
      handCount: p.hand.length,
      library: isSelf ? p.library : [],
      libraryCount: p.library.length,
    };
  }
  return {
    code: room.code,
    playerOrder: room.playerOrder,
    players,
    log: room.log.slice(-100),
    you: viewerId,
    pinned: !!room.pinned,
    format: room.format,
  };
}

function broadcastRoom(code) {
  const room = getRoom(code);
  if (!room) return;
  for (const pid of room.playerOrder) {
    const socketId = room.sockets[pid];
    if (socketId) {
      io.to(socketId).emit('state', viewFor(room, pid));
    }
  }
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ---------------------------------------------------------------------------
// Formats — picked by the table creator, used to (a) flag (not block) cards
// in a pasted decklist that aren't legal in that format, and (b) constrain
// what the "Random Deck" button pulls from the local card database. Keys
// match Scryfall's own `legalities` object keys exactly, so a card's
// legalities blob can be checked with `legalities[key] === 'legal'` directly.
// ---------------------------------------------------------------------------
const FORMATS = [
  { key: 'standard', label: 'Standard' },
  { key: 'pioneer', label: 'Pioneer' },
  { key: 'modern', label: 'Modern' },
  { key: 'legacy', label: 'Legacy' },
  { key: 'vintage', label: 'Vintage' },
  { key: 'pauper', label: 'Pauper' },
  { key: 'commander', label: 'Commander' },
  { key: 'casual', label: 'Casual (no restrictions)' },
];
const FORMAT_KEYS = new Set(FORMATS.map((f) => f.key));

const BASIC_LAND_BY_COLOR = { W: 'Plains', U: 'Island', B: 'Swamp', R: 'Mountain', G: 'Forest' };
const ALL_COLORS = ['W', 'U', 'B', 'R', 'G'];

// True if every color in a card's `colors`/`color_identity` JSON array
// (whichever column is passed in) is within `allowed`. Colorless cards
// (an empty array) always pass, so artifacts fit any color combination.
function colorsSubsetOf(jsonArrayStr, allowed) {
  let arr;
  try {
    arr = JSON.parse(jsonArrayStr || '[]') || [];
  } catch {
    arr = [];
  }
  return arr.every((c) => allowed.includes(c));
}

// Distinct-by-name candidate pool for random deck generation, filtered to a
// format's legal cards (or unfiltered if `format` is falsy — used for
// "casual"), plus an extra caller-supplied WHERE fragment (e.g. excluding
// lands, or requiring "Legendary Creature" for commander candidates).
function cardPool(format, extraWhereSql) {
  let sql = `SELECT name, colors, color_identity, type_line FROM cards WHERE ${extraWhereSql}`;
  const params = [];
  if (format) {
    sql += ' AND legalities LIKE ?';
    params.push(`%"${format}":"legal"%`);
  }
  sql += ' GROUP BY name';
  return cardDb.prepare(sql).all(...params);
}

function buildLandList(colors, totalLands) {
  const useColors = colors.length ? colors : ALL_COLORS;
  const base = Math.floor(totalLands / useColors.length);
  let remainder = totalLands - base * useColors.length;
  return useColors
    .map((c) => ({ name: BASIC_LAND_BY_COLOR[c], qty: base + (remainder-- > 0 ? 1 : 0) }))
    .filter((l) => l.qty > 0);
}

// Fills nonland deck slots from a shuffled name pool, 1-4 copies each
// (Magic's usual "up to 4 non-basic copies" limit), until `totalNeeded`
// slots are filled or the pool runs out (then tops up existing entries
// toward 4 copies rather than leaving the deck short).
function buildSpellList(names, totalNeeded) {
  const shuffled = shuffle(names.slice());
  const list = [];
  let total = 0;
  for (const name of shuffled) {
    if (total >= totalNeeded) break;
    const qty = Math.min(totalNeeded - total, 1 + Math.floor(Math.random() * 4));
    list.push({ name, qty });
    total += qty;
  }
  let i = 0;
  while (total < totalNeeded && list.length) {
    const entry = list[i % list.length];
    if (entry.qty < 4) {
      entry.qty++;
      total++;
    }
    i++;
    if (i > list.length * 4 + 20) break; // safety valve — pool truly exhausted
  }
  return list;
}

// A 60-card constructed deck (also used for "casual", which just skips the
// legality filter): 1-2 random colors, spells from cards legal in that
// color pair (widening to the whole legal pool if that's too narrow), plus
// a basic-land manabase for the chosen colors.
function buildConstructedDeck(format) {
  const key = format === 'casual' ? null : format;
  const pool = cardPool(key, "type_line NOT LIKE '%Land%'");
  if (!pool.length) return null;

  const n = Math.random() < 0.5 ? 1 : 2;
  const colors = shuffle(ALL_COLORS.slice()).slice(0, n);
  let candidates = pool.filter((c) => colorsSubsetOf(c.colors, colors));
  if (candidates.length < 30) candidates = pool; // color pair too narrow for this format's pool — widen instead of failing

  const spells = buildSpellList(candidates.map((c) => c.name), 43);
  const lands = buildLandList(colors, 17);

  return [...spells, ...lands].map((e) => `${e.qty} ${e.name}`).join('\n');
}

// A 100-card Commander deck: a random legendary creature legal in
// Commander, then 99 singleton cards within its color identity (widening
// past color identity if the pool's too narrow to hit 99), padded out with
// basics if the spell pool still comes up short.
function buildCommanderDeck() {
  const commanderPool = cardPool('commander', "type_line LIKE '%Legendary%' AND type_line LIKE '%Creature%'");
  if (!commanderPool.length) return null;
  const commander = commanderPool[Math.floor(Math.random() * commanderPool.length)];
  let identity;
  try {
    identity = JSON.parse(commander.color_identity || '[]') || [];
  } catch {
    identity = [];
  }

  const nonlandPool = cardPool('commander', "type_line NOT LIKE '%Land%'").filter((c) => c.name !== commander.name);
  let candidates = nonlandPool.filter((c) => colorsSubsetOf(c.color_identity, identity));
  if (candidates.length < 50) candidates = nonlandPool; // very narrow identity (e.g. mono-color) — widen instead of failing

  const spellNames = shuffle(candidates.map((c) => c.name)).slice(0, 62); // singleton, 1 copy each
  const lands = buildLandList(identity, Math.max(99 - spellNames.length, 0));

  return [`1 ${commander.name}`, ...spellNames.map((n) => `1 ${n}`), ...lands.map((l) => `${l.qty} ${l.name}`)].join('\n');
}

io.on('connection', (socket) => {
  let currentCode = null;
  let currentPlayerId = null;

  // DEV ONLY — lists every in-memory table so a local dev session can
  // quick-join without typing a code. Not meant to ship in a public deploy
  // (it leaks table codes/player names to anyone connected).
  socket.on('list_tables', (payload, cb) => {
    const tables = Object.values(rooms).map((r) => {
      const removeInSeconds = !r.pinned && r.emptySince != null
        ? Math.max(0, Math.ceil((EMPTY_ROOM_TIMEOUT_MS - (Date.now() - r.emptySince)) / 1000))
        : null;
      return {
        code: r.code,
        players: r.playerOrder.map((pid) => ({
          name: r.players[pid]?.name || '?',
          connected: !!r.players[pid]?.connected,
        })),
        pinned: !!r.pinned,
        removeInSeconds,
        format: r.format,
      };
    });
    cb && cb({ ok: true, tables });
  });

  // Lets the client build its format dropdown from the server's own list,
  // so the two never drift out of sync.
  socket.on('list_formats', (payload, cb) => {
    cb && cb({ ok: true, formats: FORMATS });
  });

  socket.on('create_room', ({ name, playerId, format }, cb) => {
    const code = makeRoomCode();
    rooms[code] = {
      code,
      players: {},
      playerOrder: [],
      sockets: {},
      log: [],
      pinned: false,
      emptySince: null,
      format: FORMAT_KEYS.has(format) ? format : 'casual',
    };
    cb && cb({ ok: true, code });
  });

  socket.on('join_room', ({ code, name, playerId }, cb) => {
    const room = getRoom(code || '');
    if (!room) {
      cb && cb({ ok: false, error: 'No table found with that code.' });
      return;
    }
    currentCode = room.code;
    currentPlayerId = playerId;
    socket.join(room.code);

    if (!room.players[playerId]) {
      room.players[playerId] = newPlayerState(name || 'Player');
      room.playerOrder.push(playerId);
      log(room, `${name || 'Player'} joined the table.`);
    } else {
      room.players[playerId].connected = true;
      room.players[playerId].name = name || room.players[playerId].name;
      log(room, `${room.players[playerId].name} reconnected.`);
    }
    room.sockets[playerId] = socket.id;
    room.emptySince = null; // someone's here again — cancel any pending expiry

    cb && cb({ ok: true, code: room.code, playerId });
    broadcastRoom(room.code);
  });

  // Toggle "keep this table alive indefinitely" — exempts the room from the
  // empty-table timeout below no matter how long everyone's disconnected.
  socket.on(
    'pin_table',
    withRoom((room) => {
      room.pinned = !room.pinned;
      log(room, `Table ${room.pinned ? 'pinned — will stay open indefinitely.' : 'unpinned.'}`);
    })
  );

  // Resolves a decklist's card names into full card data (name/image/mana
  // cost/type/power/toughness) — local SQLite snapshot first (instant,
  // offline), live Scryfall API as a fallback for anything not found there
  // (a card released after the snapshot was taken, or no local DB at all).
  // Doesn't need withRoom — this is a stateless lookup, not a room mutation.
  //
  // `format`, if given, doesn't block anything — this app doesn't enforce
  // rules — it just flags names that aren't legal in that format so the
  // client can show a heads-up warning next to the normal import result.
  socket.on('resolve_deck', async ({ names, format } = {}, cb) => {
    if (!Array.isArray(names)) {
      cb && cb({ ok: false, error: 'Expected a names array.' });
      return;
    }
    const checkFormat = FORMAT_KEYS.has(format) && format !== 'casual' ? format : null;
    const resolved = new Map(); // lowercase name -> card data
    const misses = [];
    const illegal = [];

    for (const name of names) {
      if (lookupCardStmt) {
        const row = lookupCardStmt.get(name, name);
        if (row) {
          resolved.set(name.toLowerCase(), dbRowToCard(row));
          if (checkFormat) {
            try {
              const legalities = JSON.parse(row.legalities || '{}');
              if (legalities[checkFormat] !== 'legal') illegal.push(row.name);
            } catch {}
          }
          continue;
        }
      }
      misses.push(name);
    }

    let notFound = [];
    if (misses.length) {
      const { found, notFound: liveNotFound } = await resolveNamesFromLiveScryfall(misses);
      found.forEach((card, key) => {
        resolved.set(key, scryfallApiCardToCard(card));
        if (checkFormat && card.legalities && card.legalities[checkFormat] !== 'legal') illegal.push(card.name);
      });
      notFound = liveNotFound;
    }

    cb && cb({ ok: true, resolved: Object.fromEntries(resolved), notFound, illegal });
  });

  // Builds a random decklist (as plain text, same shape as a pasted
  // decklist) legal in the given format, pulled from the local card
  // database. Doesn't touch room state — the client loads the returned
  // text into the decklist textarea same as it would anything typed by
  // hand, so Import still goes through the normal resolve_deck/set_library
  // path.
  socket.on('generate_random_deck', ({ format } = {}, cb) => {
    if (!cardDb) {
      cb && cb({ ok: false, error: 'No local card database — random deck generation needs cards.sqlite.' });
      return;
    }
    const key = FORMAT_KEYS.has(format) ? format : 'casual';
    try {
      const decklist = key === 'commander' ? buildCommanderDeck() : buildConstructedDeck(key);
      if (!decklist) {
        cb && cb({ ok: false, error: 'Could not find enough legal cards to build a deck for that format.' });
        return;
      }
      cb && cb({ ok: true, decklist, format: key });
    } catch (err) {
      console.error('generate_random_deck failed:', err);
      cb && cb({ ok: false, error: err.message });
    }
  });

  // Official rulings for a card, keyed by oracle_id (shared across every
  // printing and both faces of a double-faced card, so this one lookup
  // covers whichever printing/face the player actually drew). Comes only
  // from the local database (see scripts/import-rulings.js) — no live
  // Scryfall fallback for this one, since it's a nice-to-have rather than
  // something gameplay depends on. Empty results (no rulings table, no
  // oracleId, or just no rulings for that card) are all a normal, silent
  // empty list — not an error.
  socket.on('get_rulings', ({ oracleId } = {}, cb) => {
    if (!oracleId || !lookupRulingsStmt) {
      cb && cb({ ok: true, rulings: [] });
      return;
    }
    const rulings = lookupRulingsStmt.all(oracleId);
    cb && cb({ ok: true, rulings });
  });

  function withRoom(fn) {
    return (payload = {}, cb) => {
      const room = getRoom(currentCode || payload.code || '');
      if (!room || !currentPlayerId) {
        cb && cb({ ok: false, error: 'Not in a room.' });
        return;
      }
      const player = room.players[currentPlayerId];
      if (!player) {
        cb && cb({ ok: false, error: 'Unknown player.' });
        return;
      }
      try {
        const result = fn(room, player, payload, cb);
        broadcastRoom(room.code);
        // Always ack unless the handler already sent its own callback response.
        if (cb && !result?.__acked) cb({ ok: true, ...(result || {}) });
      } catch (err) {
        console.error(err);
        cb && cb({ ok: false, error: err.message });
      }
    };
  }

  // Replace a player's library with cards resolved via resolve_deck.
  socket.on(
    'set_library',
    withRoom((room, player, { cards }) => {
      player.library = shuffle(
        cards.map((c) => ({
          uid: nanoid(),
          name: c.name,
          scryfallId: c.id || null,
          oracleId: c.oracleId || null,
          layout: c.layout || null,
          image: c.image || null,
          manaCost: c.manaCost || '',
          typeLine: c.typeLine || '',
          power: c.power ?? null,
          toughness: c.toughness ?? null,
          tapped: false,
          faceDown: false,
          counters: {},
          x: BOARD_CENTER_X,
          y: BOARD_CENTER_Y,
          isToken: false,
          // Transform support (front/back cards like Delver of Secrets):
          // `front` is the permanent original data for this face, `back` is
          // the other face's data (or null for a normal single-faced card).
          // The top-level name/image/typeLine/power/toughness above always
          // reflect whichever face is currently showing — transform_card
          // swaps them in place — so nothing else in the app needs to know
          // about front/back at all, it just sees those fields change.
          front: { name: c.name, image: c.image || null, typeLine: c.typeLine || '', power: c.power ?? null, toughness: c.toughness ?? null },
          back: c.back || null,
          transformed: false,
        }))
      );
      player.hand = [];
      player.battlefield = [];
      player.graveyard = [];
      player.exile = [];
      log(room, `${player.name} loaded a ${player.library.length}-card deck.`);
    })
  );

  socket.on(
    'shuffle_library',
    withRoom((room, player) => {
      shuffle(player.library);
      log(room, `${player.name} shuffled their library.`);
    })
  );

  socket.on(
    'draw_card',
    withRoom((room, player, { count }) => {
      const n = Math.max(1, Math.min(count || 1, 40));
      let drawn = 0;
      for (let i = 0; i < n; i++) {
        const card = player.library.shift();
        if (!card) break;
        player.hand.push(card);
        drawn++;
      }
      log(room, `${player.name} drew ${drawn} card${drawn === 1 ? '' : 's'}.`);
    })
  );

  socket.on(
    'mulligan_hand',
    withRoom((room, player) => {
      player.library.push(...player.hand);
      player.hand = [];
      shuffle(player.library);
      const n = Math.min(7, player.library.length);
      for (let i = 0; i < n; i++) player.hand.push(player.library.shift());
      log(room, `${player.name} mulliganed back to a fresh 7.`);
    })
  );

  // Move a card between zones (own zones, or opponents' public zones like
  // battlefield/graveyard/exile for things like combat damage bookkeeping).
  socket.on(
    'move_card',
    withRoom((room, player, { uid, ownerId, fromZone, toZone, x, y, faceDown }) => {
      const targetOwner = room.players[ownerId] || player;
      if (!ZONES.includes(fromZone) || !ZONES.includes(toZone)) return;
      const fromArr = targetOwner[fromZone];
      const idx = findCard(fromArr, uid);
      if (idx === -1) return;
      const [card] = fromArr.splice(idx, 1);
      // Untap on a genuine zone change (leaving/entering a zone resets tap
      // status, same as real Magic) — but NOT when fromZone === toZone,
      // which covers repositioning a card on the same battlefield (dragging
      // it around) and the "turn face up/down" context-menu action. Neither
      // of those should untap a card that was deliberately tapped.
      if (fromZone !== toZone) card.tapped = false;
      if (typeof faceDown === 'boolean') card.faceDown = faceDown;
      if (toZone === 'battlefield') {
        // Preserve the card's existing position if the client didn't send new
        // coordinates (e.g. the "flip face down" context-menu action moves a
        // card from battlefield to battlefield with no x/y — it shouldn't
        // reset the card back to the center of the board).
        card.x = x ?? card.x ?? BOARD_CENTER_X;
        card.y = y ?? card.y ?? BOARD_CENTER_Y;
      }
      targetOwner[toZone].push(card);
      if (fromZone !== toZone) {
        log(room, `${player.name} moved ${card.faceDown ? 'a card' : card.name} from ${fromZone} to ${toZone}.`);
      }
    })
  );

  // Hands a battlefield card to another player's battlefield outright — for
  // control-changing effects (Mind Control, Threaten, etc.). This app
  // doesn't model owner vs. controller as separate concepts (that's a real
  // rules distinction this bookkeeping tool has no reason to enforce): once
  // control changes, the card is simply added to the new controller's
  // battlefield array like any of their own cards, tap state and counters
  // intact. If it dies or the effect ends, whoever's playing moves it back
  // (or to whichever zone the table agrees on) with the normal zone-move
  // actions, same as everything else here.
  socket.on(
    'give_control',
    withRoom((room, player, { uid, fromOwnerId, toOwnerId }) => {
      const from = room.players[fromOwnerId];
      const to = room.players[toOwnerId];
      if (!from || !to || fromOwnerId === toOwnerId) return;
      const idx = findCard(from.battlefield, uid);
      if (idx === -1) return;
      const [card] = from.battlefield.splice(idx, 1);
      to.battlefield.push(card);
      log(room, `${player.name} gave control of ${card.faceDown ? 'a card' : card.name} to ${to.name}.`);
    })
  );

  socket.on(
    'reorder_battlefield',
    withRoom((room, player, { uid, x, y }) => {
      const card = player.battlefield.find((c) => c.uid === uid);
      if (card) {
        card.x = x;
        card.y = y;
      }
    })
  );

  socket.on(
    'tap_card',
    withRoom((room, player, { ownerId, uid }) => {
      // Unlike most bookkeeping actions here, tapping is restricted to your
      // own cards — tap state tracks whether *you've* used a permanent, so
      // letting another player toggle it either hides real information from
      // you or fakes an action you never took.
      if (ownerId && ownerId !== currentPlayerId) return;
      const card = player.battlefield.find((c) => c.uid === uid);
      if (card) card.tapped = !card.tapped;
    })
  );

  // Flips a double-faced card (e.g. Delver of Secrets // Insectile
  // Aberration) to its other side — a no-op for any card without a `back`
  // (plain single-faced cards, tokens, split/adventure cards where both
  // halves share one image). Same "anyone can act on any visible card"
  // model as tap_card/set_counter — this is bookkeeping, not rules
  // enforcement, so it doesn't check ownership.
  socket.on(
    'transform_card',
    withRoom((room, player, { ownerId, uid }) => {
      const owner = room.players[ownerId] || player;
      const card = findCardAnyZone(owner, uid);
      if (!card || !card.back) return;
      card.transformed = !card.transformed;
      const active = card.transformed ? card.back : card.front;
      card.name = active.name;
      card.image = active.image;
      card.typeLine = active.typeLine;
      card.power = active.power;
      card.toughness = active.toughness;
    })
  );

  socket.on(
    'set_counter',
    withRoom((room, player, { ownerId, uid, key, delta }) => {
      const owner = room.players[ownerId] || player;
      const card = owner.battlefield.find((c) => c.uid === uid);
      if (!card) return;
      card.counters[key] = (card.counters[key] || 0) + delta;
      if (card.counters[key] <= 0) delete card.counters[key];
    })
  );

  socket.on(
    'create_token',
    withRoom((room, player, { name, power, toughness, color, image }) => {
      const token = {
        uid: nanoid(),
        name: name || 'Token',
        scryfallId: null,
        oracleId: null,
        layout: null,
        image: image || null,
        manaCost: '',
        typeLine: `Token Creature — ${color || ''}`.trim(),
        power: power ?? null,
        toughness: toughness ?? null,
        tapped: false,
        faceDown: false,
        counters: {},
        x: BOARD_CENTER_X,
        y: BOARD_CENTER_Y,
        isToken: true,
        front: null,
        back: null, // tokens are never double-faced
        transformed: false,
      };
      player.battlefield.push(token);
      log(room, `${player.name} created a token: ${token.name}.`);
    })
  );

  socket.on(
    'update_life',
    withRoom((room, player, { delta }) => {
      player.life += delta;
      log(room, `${player.name}'s life total: ${player.life} (${delta > 0 ? '+' : ''}${delta}).`);
    })
  );

  socket.on(
    'update_poison',
    withRoom((room, player, { delta }) => {
      player.poison = Math.max(0, player.poison + delta);
      log(room, `${player.name}'s poison counters: ${player.poison}.`);
    })
  );

  socket.on(
    'chat_message',
    withRoom((room, player, { text }) => {
      if (!text || !text.trim()) return;
      log(room, `${player.name}: ${text.trim().slice(0, 500)}`);
    })
  );

  // Explicit "Leave Table" — same bookkeeping as a disconnect, but intentional,
  // so we log it distinctly and let the client bail out to the landing screen
  // without waiting for a socket-level disconnect.
  socket.on('leave_room', () => {
    if (currentCode && currentPlayerId) {
      const room = getRoom(currentCode);
      if (room && room.players[currentPlayerId]) {
        room.players[currentPlayerId].connected = false;
        log(room, `${room.players[currentPlayerId].name} left the table.`);
        if (room.sockets[currentPlayerId] === socket.id) delete room.sockets[currentPlayerId];
        markEmptyIfNeeded(room);
        broadcastRoom(room.code);
      }
      socket.leave(currentCode);
    }
    currentCode = null;
    currentPlayerId = null;
  });

  socket.on('disconnect', () => {
    if (currentCode && currentPlayerId) {
      const room = getRoom(currentCode);
      if (room && room.players[currentPlayerId]) {
        room.players[currentPlayerId].connected = false;
        log(room, `${room.players[currentPlayerId].name} disconnected.`);
        markEmptyIfNeeded(room);
        broadcastRoom(room.code);
      }
    }
  });
});

// Periodic sweep: wipe any unpinned table that's been fully disconnected for
// longer than EMPTY_ROOM_TIMEOUT_MS. Pinned tables are exempt no matter how
// long they sit empty.
setInterval(() => {
  const now = Date.now();
  for (const code of Object.keys(rooms)) {
    const room = rooms[code];
    if (!room.pinned && room.emptySince != null && now - room.emptySince >= EMPTY_ROOM_TIMEOUT_MS) {
      delete rooms[code];
    }
  }
}, ROOM_SWEEP_INTERVAL_MS);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`MTG Tabletop running at http://localhost:${PORT}`);
});
