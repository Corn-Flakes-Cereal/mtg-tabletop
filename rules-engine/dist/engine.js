"use strict";
// Pure state-machine module: MTG turn structure + APNAP priority passing.
// Deliberately does NOT know what any card or ability actually does — a stack
// object is just a controller + a text label. Resolving it just pops it and
// logs that it resolved; what actually happens is still on the players, the
// same way the bookkeeping app (one level up) leaves all card effects to you.
// That's the scope of this experiment: automate the parts of Magic's rules
// that are pure structure/procedure (whose turn/step it is, who has
// priority, when the stack resolves) without trying to model rules text.
//
// Kept framework-free and side-effect-free (besides mutating the RoomState
// object passed in) so it can be unit-tested directly, without sockets.
//
// This is also the piece of the app where TypeScript actually earns its
// keep over the plain-JS version: Phase/CombatStep are closed unions, so a
// typo like 'delcare_attackers' is a compile error, not a silent runtime
// bug; PlayerId is a distinct type from a plain string so a stack object's
// controllerId can't accidentally be assigned a room code; and
// noUncheckedIndexedAccess (see tsconfig) forces every array/record lookup
// to be null-checked, which is exactly the class of bug ("what if
// structureIndex ever points past the end of TURN_STRUCTURE") that's easy
// to miss in JS and impossible to ignore here.
Object.defineProperty(exports, "__esModule", { value: true });
exports.TURN_STRUCTURE = void 0;
exports.asPlayerId = asPlayerId;
exports.createRoom = createRoom;
exports.addPlayer = addPlayer;
exports.setDisconnected = setDisconnected;
exports.activePlayerId = activePlayerId;
exports.startGame = startGame;
exports.passPriority = passPriority;
exports.addToStack = addToStack;
exports.viewFor = viewFor;
const nanoid_1 = require("nanoid");
// The steps/phases of a single MTG turn, in order. `priority: false` steps
// (untap, cleanup) are turbo'd through automatically — nobody gets a window
// to act during them under normal circumstances, so the engine just logs
// what happens and immediately advances.
exports.TURN_STRUCTURE = [
    { phase: 'untap', step: null, priority: false, label: 'Untap' },
    { phase: 'upkeep', step: null, priority: true, label: 'Upkeep' },
    { phase: 'draw', step: null, priority: true, label: 'Draw' },
    { phase: 'main1', step: null, priority: true, label: 'Main Phase 1' },
    { phase: 'combat', step: 'begin', priority: true, label: 'Beginning of Combat' },
    { phase: 'combat', step: 'declare_attackers', priority: true, label: 'Declare Attackers' },
    { phase: 'combat', step: 'declare_blockers', priority: true, label: 'Declare Blockers' },
    { phase: 'combat', step: 'combat_damage', priority: true, label: 'Combat Damage' },
    { phase: 'combat', step: 'end', priority: true, label: 'End of Combat' },
    { phase: 'main2', step: null, priority: true, label: 'Main Phase 2' },
    { phase: 'end', step: null, priority: true, label: 'End Step' },
    { phase: 'cleanup', step: null, priority: false, label: 'Cleanup' },
];
function asPlayerId(id) {
    return id;
}
function createRoom(code) {
    return {
        code,
        playerOrder: [],
        players: {},
        started: false,
        turnNumber: 0,
        activePlayerIndex: 0,
        structureIndex: 0,
        priorityPlayerId: null,
        passed: [],
        stack: [],
        log: [],
    };
}
function log(state, text) {
    state.log.push({ ts: Date.now(), text });
    if (state.log.length > 300)
        state.log.shift();
}
function playerName(state, id) {
    if (!id)
        return '?';
    return state.players[id]?.name ?? '?';
}
function addPlayer(state, playerId, name) {
    const existing = state.players[playerId];
    if (!existing) {
        state.players[playerId] = { name: name || 'Player', connected: true };
        state.playerOrder.push(playerId);
        log(state, `${name || 'Player'} joined the table.`);
    }
    else {
        existing.connected = true;
        existing.name = name || existing.name;
        log(state, `${existing.name} reconnected.`);
    }
}
function setDisconnected(state, playerId) {
    const existing = state.players[playerId];
    if (existing) {
        existing.connected = false;
        log(state, `${existing.name} disconnected.`);
    }
}
// TURN_STRUCTURE is a fixed, non-empty array and structureIndex is always
// kept in [0, TURN_STRUCTURE.length) by advanceStep()'s wraparound — but with
// noUncheckedIndexedAccess on, the compiler can't know that invariant, so it
// correctly types the lookup as `StepDef | undefined`. Centralizing the "yes,
// this is really always in range" assertion here (with the reasoning written
// down) beats sprinkling `!` all over the file.
function currentStepDef(state) {
    const def = exports.TURN_STRUCTURE[state.structureIndex];
    if (!def)
        throw new Error(`Invariant violated: structureIndex ${state.structureIndex} out of range`);
    return def;
}
// Same invariant story: activePlayerIndex is only ever advanced modulo
// playerOrder.length, so it's always in range once at least one player has
// joined. Callers are expected to only call this once the game has started
// (i.e. playerOrder is non-empty).
function activePlayerId(state) {
    const id = state.playerOrder[state.activePlayerIndex];
    if (!id)
        throw new Error('Invariant violated: no active player (has the game started?)');
    return id;
}
function enterStep(state) {
    const stepDef = currentStepDef(state);
    state.passed = [];
    const apId = activePlayerId(state);
    const apName = playerName(state, apId);
    log(state, `Turn ${state.turnNumber} — ${apName}'s ${stepDef.label}.`);
    if (stepDef.phase === 'untap') {
        log(state, `${apName} untaps all permanents. (bookkeeping only — this engine doesn't track permanents yet)`);
        advanceStep(state);
        return;
    }
    if (stepDef.phase === 'draw') {
        log(state, `${apName} draws for turn. (bookkeeping only — no cards tracked here yet)`);
    }
    if (stepDef.phase === 'cleanup') {
        log(state, `${apName} discards to hand size; "until end of turn" effects end. (bookkeeping only)`);
        advanceStep(state);
        return;
    }
    state.priorityPlayerId = apId;
}
function advanceStep(state) {
    state.structureIndex++;
    if (state.structureIndex >= exports.TURN_STRUCTURE.length) {
        state.structureIndex = 0;
        state.turnNumber++;
        state.activePlayerIndex = (state.activePlayerIndex + 1) % state.playerOrder.length;
    }
    enterStep(state);
}
function startGame(state) {
    if (state.started)
        return { ok: false, error: 'Game already started.' };
    if (state.playerOrder.length < 1)
        return { ok: false, error: 'Need at least 1 player to start.' };
    state.started = true;
    state.turnNumber = 1;
    state.activePlayerIndex = 0;
    state.structureIndex = 0;
    log(state, `Game started. ${playerName(state, activePlayerId(state))} takes the first turn.`);
    enterStep(state);
    return { ok: true };
}
// A player with priority may pass. Once every player has passed in a row
// (with nothing else happening in between), one of two things happens:
// the top of the stack resolves (if it's non-empty), or play moves to the
// next step/phase (if the stack is empty) — exactly the real priority rule.
function passPriority(state, playerId) {
    if (!state.started)
        return { ok: false, error: 'Game has not started yet.' };
    if (state.priorityPlayerId !== playerId)
        return { ok: false, error: "It's not your priority." };
    const name = playerName(state, playerId);
    log(state, `${name} passes priority.`);
    if (!state.passed.includes(playerId))
        state.passed.push(playerId);
    if (state.passed.length >= state.playerOrder.length) {
        const top = state.stack.pop();
        if (top) {
            const ctrlName = playerName(state, top.controllerId);
            log(state, `"${top.label}" (${ctrlName}'s) resolves.`);
            state.passed = [];
            state.priorityPlayerId = activePlayerId(state);
        }
        else {
            advanceStep(state);
        }
        return { ok: true };
    }
    const idx = state.playerOrder.indexOf(playerId);
    const nextIdx = (idx + 1) % state.playerOrder.length;
    const nextPlayer = state.playerOrder[nextIdx];
    if (!nextPlayer)
        throw new Error('Invariant violated: empty playerOrder during priority pass');
    state.priorityPlayerId = nextPlayer;
    return { ok: true };
}
// Puts a labeled placeholder object on the stack — this engine doesn't know
// or care if it's a spell, an activated ability, or a triggered ability; it
// has no rules-text model at all. Whoever adds it keeps priority afterward
// (the real rule: acting doesn't pass priority), and everyone else needs to
// pass again before it can resolve.
function addToStack(state, playerId, label) {
    if (!state.started)
        return { ok: false, error: 'Game has not started yet.' };
    if (state.priorityPlayerId !== playerId)
        return { ok: false, error: "It's not your priority." };
    const trimmed = (label || '').trim();
    if (!trimmed)
        return { ok: false, error: 'Give the stack object a label.' };
    const obj = { id: (0, nanoid_1.nanoid)(), controllerId: playerId, label: trimmed };
    state.stack.push(obj);
    log(state, `${playerName(state, playerId)} puts "${obj.label}" on the stack.`);
    state.passed = [];
    return { ok: true };
}
function viewFor(state) {
    const stepDef = currentStepDef(state);
    return {
        code: state.code,
        playerOrder: state.playerOrder,
        players: state.players,
        started: state.started,
        turnNumber: state.turnNumber,
        activePlayerId: state.playerOrder.length ? activePlayerId(state) : null,
        phase: stepDef.phase,
        step: stepDef.step,
        stepLabel: stepDef.label,
        priorityPlayerId: state.priorityPlayerId,
        passed: state.passed,
        stack: state.stack,
        log: state.log,
    };
}
//# sourceMappingURL=engine.js.map