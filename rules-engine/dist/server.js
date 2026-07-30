"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const path_1 = __importDefault(require("path"));
const express_1 = __importDefault(require("express"));
const http_1 = __importDefault(require("http"));
const socket_io_1 = require("socket.io");
const engine_1 = require("./engine");
const app = (0, express_1.default)();
// __dirname is dist/ once compiled (tsconfig outDir), but public/ lives next
// to the TypeScript sources one level up — same relative layout in dev via
// ts-node (where __dirname is the project root, so this still needs '..'
// only for the compiled case)... to keep both `npm run dev` (ts-node,
// __dirname = project root) and `npm start` (node dist/server.js, __dirname
// = dist/) working, resolve relative to whichever actually has a public/
// folder next to it.
const publicDir = require('fs').existsSync(path_1.default.join(__dirname, 'public'))
    ? path_1.default.join(__dirname, 'public')
    : path_1.default.join(__dirname, '..', 'public');
app.use(express_1.default.static(publicDir));
const server = http_1.default.createServer(app);
const io = new socket_io_1.Server(server);
const rooms = new Map();
function makeRoomCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
    let code;
    do {
        code = Array.from({ length: 5 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
    } while (rooms.has(code));
    return code;
}
function getRoom(code) {
    return rooms.get(code.toUpperCase());
}
// Every player gets their own Socket.IO room "tag" (code + playerId) rather
// than just the table code, so a per-player broadcast is possible later if
// hidden information gets added — right now every field of ViewState is
// public, so today this is equivalent to broadcasting once to the table, but
// it costs nothing to wire up correctly from the start.
function roomSocketTag(code, playerId) {
    return `${code}:${playerId}`;
}
function broadcastRoom(room) {
    for (const pid of room.playerOrder) {
        io.to(roomSocketTag(room.code, pid)).emit('state', (0, engine_1.viewFor)(room));
    }
}
io.on('connection', (socket) => {
    let currentCode = null;
    let currentPlayerId = null;
    // Wraps an engine action: looks up the caller's current room, runs the
    // action against it, and only broadcasts the new state if the action
    // actually succeeded (a rejected action, e.g. "not your priority", changed
    // nothing, so there's nothing new to tell anyone).
    function withRoom(fn) {
        return (_args, cb) => {
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
            if (result.ok)
                broadcastRoom(room);
            cb?.(result);
        };
    }
    socket.on('create_room', (_args, cb) => {
        const code = makeRoomCode();
        rooms.set(code, (0, engine_1.createRoom)(code));
        cb?.({ ok: true, code });
    });
    socket.on('join_room', ({ code, name, playerId }, cb) => {
        const room = getRoom(code || '');
        if (!room) {
            cb?.({ ok: false, error: 'No table found with that code.' });
            return;
        }
        const pid = (0, engine_1.asPlayerId)(playerId);
        currentCode = room.code;
        currentPlayerId = pid;
        socket.join(roomSocketTag(room.code, pid));
        (0, engine_1.addPlayer)(room, pid, name || 'Player');
        broadcastRoom(room);
        cb?.({ ok: true, code: room.code });
    });
    socket.on('start_game', withRoom((room) => (0, engine_1.startGame)(room)));
    socket.on('pass_priority', withRoom((room, playerId) => (0, engine_1.passPriority)(room, playerId)));
    socket.on('add_to_stack', (args, cb) => {
        withRoom((room, playerId) => (0, engine_1.addToStack)(room, playerId, args?.label ?? ''))(args, cb);
    });
    socket.on('leave_room', (_args, cb) => {
        if (currentCode && currentPlayerId) {
            const room = getRoom(currentCode);
            if (room) {
                (0, engine_1.setDisconnected)(room, currentPlayerId);
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
                (0, engine_1.setDisconnected)(room, currentPlayerId);
                broadcastRoom(room);
            }
        }
    });
});
const PORT = process.env.PORT ? Number(process.env.PORT) : 3100;
server.listen(PORT, () => {
    console.log(`MTG Rules Engine (experimental) running at http://localhost:${PORT}`);
});
//# sourceMappingURL=server.js.map