# MTG Tabletop

A simple online table for playing **regular Magic: The Gathering** with friends over the internet — real cards, real rules, you and your friends still make every call. This app is just the bookkeeping layer: zones, life totals, taps, counters, and tokens, synced live in everyone's browser.

**What it does:** rooms/table codes, decklist import via Scryfall (real card images and text), separate library/hand/battlefield/graveyard/exile per player, drag-and-drop, tap (double-click), counters and tokens (right-click a card), life & poison tracking, shared chat/log, and reconnect-safe (refreshing your browser won't lose your board).

**What it deliberately doesn't do:** enforce rules, track mana, resolve the stack, or check legality. It's the same idea as Cockatrice or playing with paper proxies over a video call — you still declare your own plays.

## Running it

Requires [Node.js](https://nodejs.org) 18+ installed.

```bash
npm install
npm start
```

Then open `http://localhost:3000` in your browser. Whoever hosts creates a table and shares the 5-character code with friends.

## Playing with friends who aren't on your network

The above only works for people on the same network as the host (e.g. same house/Wi-Fi). To play with remote friends, either:

1. **Quick option — ngrok:** run `npx ngrok http 3000` in a second terminal alongside the app, then share the `https://...ngrok-free.app` URL it gives you instead of `localhost:3000`.
2. **Proper option — deploy it:** the app is a single small Node server, so it deploys as-is to services like Render, Railway, or Fly.io (all have free tiers). Push this folder to a GitHub repo and connect it, or check that service's CLI deploy docs. Once deployed, share the public URL instead of localhost.

## How to play

1. Enter your name, then **Create Table** (or **Join Table** with a code a friend gave you).
2. Paste your decklist (one card per line, e.g. `4 Lightning Bolt`, `23 Mountain`) and hit **Import Deck & Sit Down**. Set/collector info in parentheses is ignored automatically. If a card name isn't found, you'll see a note — check the spelling.
3. Your library, hand, battlefield, graveyard, and exile are separate zones. Drag cards between them. Your hand and library contents are private; everything else is visible to everyone.
4. **Double-click** a battlefield card to tap/untap it. **Right-click** any card for more actions: flip face-down, add +1/+1 or custom counters, or move it to any zone.
5. Use **Draw 1** / **Shuffle** / **Mulligan→7** for your library, the **+Token** button to make tokens (name + P/T + a color/type note), and the +/− buttons to track life and poison.
6. The panel on the right is a shared chat and also auto-logs actions (draws, zone changes, life changes) so everyone can follow along.

## Notes on decklist format

Any of these work per line:
```
4 Lightning Bolt
4x Lightning Bolt
1 Sol Ring (LEA) 233
Lightning Bolt
```
Lines starting with `//`, or headers like `Deck`/`Sideboard`, are ignored.

## Project structure

```
server.js        Node/Express + Socket.io backend — holds all game state in memory
public/
  index.html      Page structure (landing, deck import, table screens)
  style.css       Styling
  app.js          All client logic: sockets, Scryfall lookups, drag-and-drop, rendering
package.json
```

State lives in server memory only — restarting the server clears all tables. There's no database; this is meant for casual one-off game nights, not a persistent service.

## Natural next additions

- Saved decks (so you don't re-paste your list every time)
- A dice roller / coin flip
- Viewing/scrying the top card(s) of your library without drawing
- Card search/preview panel (hover a card for a full-size image)
- Support for more than 2 players' battlefields laid out more compactly
