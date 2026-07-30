import path from 'path';
import express from 'express';
import http from 'http';
import { Server, Socket } from 'socket.io';

import {
  createRoom,
  addPlayer,
  setDisconnected,
  startGame,
  passPriority,
  addToStack,
  viewFor,
  asPlayerId,
  type RoomState,
  type PlayerId,
  type ActionResult,
} from './engine';

const app = express();
// __dirname is dist/ once compiled (tsconfig outDir), but public/ lives next
// to the TypeScript sources one level up — same relative layout in dev via
// ts-node (where __dirname is the project root, so this still needs '..'
// only for the compiled case)... to keep both `npm run dev` (ts-node,
// __dirname = project root) and `npm start` (node dist/server.js, __dirname
// = dist/) working, resolve relative to whichever actually has a public/
// folder next to it.
const publicDir = require('fs').existsSync(path.join(__dirname, 'public'))
  ? path.join(__dirname, 'public')
  : path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));

const server = http.createServer(app);
const io = new Server(server);

const rooms = new Map<string, RoomState>();

function makeRoomCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
  let code: string;
  do {
    code = Array.from({ length: 5 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function getRoom(code: string): RoomState | undefined {
  return rooms.get(code.toUpperCase());
}

// Every player gets their own Socket.IO room "tag" (code + playerId) rather
// than just the table code, so a per-player broadcast is possible later if
// hidden information gets added — right now every field of ViewState is
// public, so today this is equivalent to broadcasting once to the table, but
// it costs nothing to wire up correctly from the start.
function roomSocketTag(code: string, playerId: PlayerId): string {
  return `${code}:${playerId}`;
}

function broadcastRoom(room: RoomState): void {
  for (const pid of room.playerOrder) {
    io.to(roomSocketTag(room.code, pid)).emit('state', viewFor(room));
  }
}

interface CreateRoomArgs { name?: string; playerId: string }
interface JoinRoomArgs { code: string; name?: string; playerId: string }
interface AddToStackArgs { label: string }
interface RoomOpResult extends ActionResult { code?: string }
type Callback<T> = (res: T) => void;

io.on('connection', (socket: Socket) => {
  let currentCode: string | null = null;
  let currentPlayerId: PlayerId | null = null;

  // Wraps an engine action: looks up the caller's current room, runs the
  // action against it, and only broadcasts the new state if the action
  // actually succeeded (a rejected action, e.g. "not your priority", changed
  // nothing, so there's nothing new to tell anyone).
  function withRoom(fn: (room: RoomState, playerId: PlayerId) => ActionResult) {
    return (_args: unknown, cb?: Callback<ActionResult>) => {
      if (!currentCode || !currentPlayerId) {
        cb?.({ ok: false, error: 'Not seated at a table.' });
        return;
      }
      const room = getRoom(currentCode);
      if (!room) {
        cb?.({ ok: false, error: 'Table no longer exists.' });
        return;
      }
      const result = fn(room, currentPlayerId);
      if (result.ok) broadcastRoom(room);
      cb?.(result);
    };
  }

  socket.on('create_room', (_args: CreateRoomArgs, cb?: Callback<RoomOpResult>) => {
    const code = makeRoomCode();
    rooms.set(code, createRoom(code));
    cb?.({ ok: true, code });
  });

  socket.on('join_room', ({ code, name, playerId }: JoinRoomArgs, cb?: Callback<RoomOpResult>) => {
    const room = getRoom(code || '');
    if (!room) {
      cb?.({ ok: false, error: 'No table found with that code.' });
      return;
    }
    const pid = asPlayerId(playerId);
    currentCode = room.code;
    currentPlayerId = pid;
    socket.join(roomSocketTag(room.code, pid));

    addPlayer(room, pid, name || 'Player');
    broadcastRoom(room);
    cb?.({ ok: true, code: room.code });
  });

  socket.on('start_game', withRoom((room) => startGame(room)));

  socket.on('pass_priority', withRoom((room, playerId) => passPriority(room, playerId)));

  socket.on('add_to_stack', (args: AddToStackArgs, cb?: Callback<ActionResult>) => {
    withRoom((room, playerId) => addToStack(room, playerId, args?.label ?? ''))(args, cb);
  });

  socket.on('leave_room', (_args: unknown, cb?: Callback<ActionResult>) => {
    if (currentCode && currentPlayerId) {
      const room = getRoom(currentCode);
      if (room) {
        setDisconnected(room, currentPlayerId);
        broadcastRoom(room);
      }
      socket.leave(roomSocketTag(currentCode, currentPlayerId));
    }
    currentCode = null;
    currentPlayerId = null;
    cb?.({ ok: true });
  });

  socket.on('disconnect', () => {
    if (currentCode && currentPlayerId) {
      const room = getRoom(currentCode);
      if (room) {
        setDisconnected(room, currentPlayerId);
        broadcastRoom(room);
      }
    }
  });
});

const PORT = process.env.PORT ? Number(process.env.PORT) : 3100;
server.listen(PORT, () => {
  console.log(`MTG Rules Engine (experimental) running at http://localhost:${PORT}`);
});
