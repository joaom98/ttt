// The game rules, as a pure reducer: applyAction(state, action) => new state or an error.
// The server is the only one allowed to commit results; the client calls the same functions
// to preview which actions are legal (highlighting cells, enabling buttons).

import { autoBoardSide, makeConfig, MAX_NAME_LENGTH, MAX_PLAYERS, MIN_PLAYERS, TANK_COLORS } from "./config.ts";
import { Rng } from "./rng.ts";
import type { Action, GameConfig, GameState, Position, Result, Tank } from "./types.ts";

const MAX_LOG = 200;

export interface CreateGameOptions {
  id: string;
  hostId: string;
  hostName: string;
  config?: Partial<GameConfig>;
  seed: number;
  now: number;
}

export function createGame(opts: CreateGameOptions): Result {
  const state: GameState = {
    id: opts.id,
    phase: "lobby",
    config: makeConfig(opts.config),
    hostId: opts.hostId,
    tanks: {},
    order: [],
    pickups: [],
    tick: 0,
    nextTickAt: null,
    juryVotes: {},
    winnerId: null,
    rng: opts.seed | 0,
    log: [],
    createdAt: opts.now,
  };
  return applyAction(state, { type: "join", playerId: opts.hostId, name: opts.hostName });
}

// ---------------------------------------------------------------------------------------------
// Geometry helpers (exported for the client)

/** Square ("king move") distance — range 2 covers the 5x5 area around a tank. */
export function distance(a: Position, b: Position): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

export function inRange(from: Tank, to: Position): boolean {
  return distance(from, to) <= from.range;
}

export function boardSize(state: GameState): { width: number; height: number } {
  return { width: state.config.width, height: state.config.height };
}

export function tankAt(state: GameState, pos: Position): Tank | undefined {
  return Object.values(state.tanks).find((t) => t.x === pos.x && t.y === pos.y);
}

export function livingTanks(state: GameState): Tank[] {
  return state.order.map((id) => state.tanks[id]).filter((t): t is Tank => !!t && t.alive);
}

export function juryTally(state: GameState): Record<string, number> {
  const tally: Record<string, number> = {};
  for (const target of Object.values(state.juryVotes)) tally[target] = (tally[target] ?? 0) + 1;
  return tally;
}

/** Check an action without committing it (for UI previews). */
export function canApply(state: GameState, action: Action): boolean {
  return applyAction(state, action).ok;
}

// ---------------------------------------------------------------------------------------------
// Reducer

export function applyAction(prev: GameState, action: Action): Result {
  const s = structuredClone(prev);
  const fail = (error: string): Result => ({ ok: false, error });
  const rng = new Rng(s.rng);
  const log = (text: string, at = Date.now()) => {
    s.log.push({ tick: s.tick, at, text });
    if (s.log.length > MAX_LOG) s.log.splice(0, s.log.length - MAX_LOG);
  };

  // --- Lobby actions -------------------------------------------------------------------------
  if (action.type === "join") {
    if (s.phase !== "lobby") return fail("The game has already started.");
    if (s.tanks[action.playerId]) return fail("You have already joined.");
    if (s.order.length >= MAX_PLAYERS) return fail("The game is full.");
    const name = action.name.trim().slice(0, MAX_NAME_LENGTH);
    if (!name) return fail("Pick a name.");
    if (Object.values(s.tanks).some((t) => t.name.toLowerCase() === name.toLowerCase())) {
      return fail("That name is taken.");
    }
    const usedColors = new Set(Object.values(s.tanks).map((t) => t.color));
    const color = TANK_COLORS.find((c) => !usedColors.has(c)) ?? TANK_COLORS[s.order.length % TANK_COLORS.length]!;
    s.tanks[action.playerId] = {
      id: action.playerId, name, color, x: -1, y: -1, hearts: 0, range: 0, ap: 0, alive: true,
    };
    s.order.push(action.playerId);
    log(`${name} joined.`);
    return { ok: true, state: s };
  }

  if (action.type === "leave") {
    if (s.phase !== "lobby") return fail("You can only leave before the game starts.");
    const tank = s.tanks[action.playerId];
    if (!tank) return fail("You are not in this game.");
    delete s.tanks[action.playerId];
    s.order = s.order.filter((id) => id !== action.playerId);
    if (s.hostId === action.playerId && s.order[0]) s.hostId = s.order[0];
    log(`${tank.name} left.`);
    return { ok: true, state: s };
  }

  if (action.type === "start") {
    if (s.phase !== "lobby") return fail("The game has already started.");
    if (action.playerId !== s.hostId) return fail("Only the host can start the game.");
    if (s.order.length < MIN_PLAYERS) return fail(`Need at least ${MIN_PLAYERS} players.`);
    const side = autoBoardSide(s.order.length);
    if (s.config.width === 0) s.config.width = side;
    if (s.config.height === 0) s.config.height = side;
    const spots = placeTanks(s.config.width, s.config.height, s.order.length, rng);
    if (!spots) return fail("The board is too small for this many players.");
    s.order.forEach((id, i) => {
      const t = s.tanks[id]!;
      const spot = spots[i]!;
      t.x = spot.x;
      t.y = spot.y;
      t.hearts = s.config.startingHearts;
      t.range = s.config.startingRange;
      t.ap = s.config.startingAP;
      t.alive = true;
    });
    s.phase = "playing";
    s.tick = 0;
    s.nextTickAt = action.now + s.config.tickIntervalMs;
    s.rng = rng.seed;
    log(`The game has started with ${s.order.length} tanks!`, action.now);
    return { ok: true, state: s };
  }

  // --- Server tick ---------------------------------------------------------------------------
  if (action.type === "tick") {
    if (s.phase !== "playing") return fail("The game is not running.");
    s.tick += 1;
    for (const t of livingTanks(s)) t.ap += s.config.apPerTick;

    const tally = juryTally(s);
    for (const [targetId, votes] of Object.entries(tally)) {
      const target = s.tanks[targetId];
      if (target?.alive && votes >= s.config.juryVotesNeeded) {
        target.ap += 1;
        log(`The jury awarded ${target.name} a bonus AP (${votes} votes).`, action.now);
      }
    }
    s.juryVotes = {};

    for (let i = 0; i < s.config.heartsSpawnedPerTick; i++) {
      const spot = randomEmptySquare(s, rng);
      if (!spot) break;
      s.pickups.push(spot);
      log(`A heart appeared at ${coord(spot)}.`, action.now);
    }

    // On-time ticks keep a steady cadence. Early (forced) ticks restart the clock from now, and
    // so do very late ones (e.g. the server was down), so we never schedule a tick in the past.
    const scheduled = s.nextTickAt ?? action.now;
    let next = scheduled <= action.now ? scheduled + s.config.tickIntervalMs : action.now + s.config.tickIntervalMs;
    if (next <= action.now) next = action.now + s.config.tickIntervalMs;
    s.nextTickAt = next;
    s.rng = rng.seed;
    log(`Tick ${s.tick}: everyone still alive got ${s.config.apPerTick} AP.`, action.now);
    return { ok: true, state: s };
  }

  // --- Player actions during play ------------------------------------------------------------
  if (s.phase !== "playing") return fail("The game is not running.");
  const me = s.tanks[action.playerId];
  if (!me) return fail("You are not in this game.");

  if (action.type === "juryVote") {
    if (me.alive) return fail("Only dead tanks sit on the jury.");
    const target = s.tanks[action.targetId];
    if (!target || !target.alive) return fail("You can only vote for a living tank.");
    s.juryVotes[me.id] = target.id;
    return { ok: true, state: s }; // Votes are secret until the tick — no log entry.
  }

  if (!me.alive) return fail("Your tank has been destroyed. You can still vote on the jury.");

  if (action.type === "move") {
    const { dx, dy } = action;
    if (![-1, 0, 1].includes(dx) || ![-1, 0, 1].includes(dy) || (dx === 0 && dy === 0)) {
      return fail("Tanks move one square at a time (diagonals allowed).");
    }
    if (me.ap < 1) return fail("Not enough AP.");
    const to = { x: me.x + dx, y: me.y + dy };
    if (to.x < 0 || to.y < 0 || to.x >= s.config.width || to.y >= s.config.height) return fail("That's off the board.");
    if (tankAt(s, to)) return fail("That square is occupied.");
    me.ap -= 1;
    me.x = to.x;
    me.y = to.y;
    const pickupIndex = s.pickups.findIndex((p) => p.x === to.x && p.y === to.y);
    if (pickupIndex >= 0) {
      s.pickups.splice(pickupIndex, 1);
      me.hearts += 1;
      log(`${me.name} picked up a heart.`);
    }
    return { ok: true, state: s };
  }

  if (action.type === "upgradeRange") {
    if (me.ap < s.config.upgradeRangeCost) return fail(`Upgrading range costs ${s.config.upgradeRangeCost} AP.`);
    me.ap -= s.config.upgradeRangeCost;
    me.range += 1;
    log(`${me.name} upgraded their range to ${me.range}.`);
    return { ok: true, state: s };
  }

  // Remaining actions all target another tank within range.
  const target = s.tanks[action.targetId];
  if (!target) return fail("No such tank.");
  if (target.id === me.id) return fail("You can't target yourself.");
  if (!inRange(me, target)) return fail(`${target.name} is out of range.`);

  if (action.type === "shoot") {
    if (!target.alive) return fail(`${target.name} is already destroyed.`);
    if (me.ap < 1) return fail("Not enough AP.");
    me.ap -= 1;
    target.hearts -= 1;
    if (target.hearts > 0) {
      log(`${me.name} shot ${target.name} (${target.hearts} ♥ left).`);
    } else {
      target.alive = false;
      target.hearts = 0;
      let loot = "";
      if (s.config.killerTakesAP && target.ap > 0) {
        loot = ` and took their ${target.ap} AP`;
        me.ap += target.ap;
        target.ap = 0;
      }
      // Votes for a dead tank no longer count.
      for (const [voter, votedFor] of Object.entries(s.juryVotes)) {
        if (votedFor === target.id) delete s.juryVotes[voter];
      }
      log(`💥 ${me.name} destroyed ${target.name}${loot}!`);
      checkForWinner(s, log);
    }
    return { ok: true, state: s };
  }

  if (action.type === "giveAP") {
    if (!target.alive) return fail(`${target.name} is destroyed — AP would be wasted.`);
    if (me.ap < 1) return fail("Not enough AP.");
    me.ap -= 1;
    target.ap += 1;
    log(`${me.name} gave 1 AP to ${target.name}.`);
    return { ok: true, state: s };
  }

  if (action.type === "giveHeart") {
    if (!s.config.allowGiveHeart) return fail("Giving hearts is disabled in this game.");
    if (me.hearts < 2) return fail("You need at least 2 hearts to give one away.");
    if (!target.alive && !s.config.heartRevives) return fail(`${target.name} is destroyed.`);
    me.hearts -= 1;
    if (target.alive) {
      target.hearts += 1;
      log(`${me.name} gave a heart to ${target.name}.`);
    } else {
      target.alive = true;
      target.hearts = 1;
      target.ap = 0;
      delete s.juryVotes[target.id];
      log(`❤️ ${me.name} revived ${target.name}!`);
    }
    return { ok: true, state: s };
  }

  const unknown: never = action;
  return fail(`Unknown action ${(unknown as { type: string }).type}`);
}

// ---------------------------------------------------------------------------------------------
// Internals

function checkForWinner(s: GameState, log: (text: string) => void): void {
  const alive = livingTanks(s);
  if (alive.length > 1) return;
  s.phase = "finished";
  s.nextTickAt = null;
  s.winnerId = alive[0]?.id ?? null;
  log(alive[0] ? `🏆 ${alive[0].name} is the last tank standing!` : "Nobody survived.");
}

/** Spread tanks out: greedily take shuffled squares that keep a 2-square gap, then relax. */
function placeTanks(width: number, height: number, count: number, rng: Rng): Position[] | null {
  const cells: Position[] = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) cells.push({ x, y });
  if (cells.length < count) return null;
  for (const minGap of [3, 2, 1]) {
    const chosen: Position[] = [];
    for (const c of rng.shuffle([...cells])) {
      if (chosen.every((p) => distance(p, c) >= minGap)) chosen.push(c);
      if (chosen.length === count) return chosen;
    }
  }
  return null;
}

function randomEmptySquare(s: GameState, rng: Rng): Position | null {
  const empty: Position[] = [];
  for (let y = 0; y < s.config.height; y++) {
    for (let x = 0; x < s.config.width; x++) {
      const p = { x, y };
      if (!tankAt(s, p) && !s.pickups.some((h) => h.x === x && h.y === y)) empty.push(p);
    }
  }
  return empty.length ? empty[rng.int(empty.length)]! : null;
}

function coord(p: Position): string {
  return `${String.fromCharCode(65 + (p.x % 26))}${p.y + 1}`;
}
