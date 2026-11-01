// The game rules, as a pure reducer: applyAction(state, action) => new state or an error.
// The server is the only one allowed to commit results; the client calls the same functions
// to preview which actions are legal (highlighting cells, enabling buttons).

import { autoBoardSide, makeConfig, MAX_NAME_LENGTH, MAX_PLAYERS, MIN_PLAYERS, RESOLVE_STEP_MS, TANK_COLORS } from "./config.ts";
import { Rng } from "./rng.ts";
import type { Action, GameConfig, GameState, OrderAction, Position, Result, Tank } from "./types.ts";

const MAX_LOG = 200;
const ORDER_TYPES = new Set<string>(["move", "shoot", "giveAP", "giveHeart", "upgradeRange"]);

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
    orders: {},
    resolving: null,
    winnerId: null,
    autoSize: false,
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

/** Is this a tank action (one that can be queued as an order)? */
export function isOrder(action: { type: string }): action is OrderAction {
  return ORDER_TYPES.has(action.type);
}

/**
 * Rounds mode: the board as a player's planned order would leave it if nobody else did anything.
 * The client draws it as the "ghost" of the plan.
 */
export function projectOrders(state: GameState, playerId: string): GameState {
  const s = structuredClone(state);
  const order = state.orders[playerId];
  if (order) perform(s, order, () => {});
  return s;
}

// ---------------------------------------------------------------------------------------------
// Reducer

type Log = (text: string, at?: number) => void;

export function applyAction(prev: GameState, action: Action): Result {
  const s = structuredClone(prev);
  const fail = (error: string): Result => ({ ok: false, error });
  const ok = (): Result => ({ ok: true, state: s });
  const rng = new Rng(s.rng);
  const log: Log = (text, at = Date.now()) => {
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
    return ok();
  }

  if (action.type === "leave") {
    if (s.phase !== "lobby") return fail("You can only leave before the game starts.");
    const tank = s.tanks[action.playerId];
    if (!tank) return fail("You are not in this game.");
    delete s.tanks[action.playerId];
    s.order = s.order.filter((id) => id !== action.playerId);
    if (s.hostId === action.playerId && s.order[0]) s.hostId = s.order[0];
    log(`${tank.name} left.`);
    return ok();
  }

  if (action.type === "start") {
    if (s.phase !== "lobby") return fail("The game has already started.");
    if (action.playerId !== s.hostId) return fail("Only the host can start the game.");
    if (s.order.length < MIN_PLAYERS) return fail(`Need at least ${MIN_PLAYERS} players.`);
    const side = autoBoardSide(s.order.length);
    s.autoSize = s.config.width === 0 || s.config.height === 0;
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
    s.orders = {};
    s.resolving = null;
    s.rng = rng.seed;
    log(`The game has started with ${s.order.length} tanks!`, action.now);
    return ok();
  }

  if (action.type === "configure") {
    if (s.phase !== "lobby") return fail("The rules can only change in the lobby.");
    if (action.playerId !== s.hostId) return fail("Only the host can change the rules.");
    // Merge over the current rules; makeConfig drops unknown keys and clamps the numbers.
    s.config = makeConfig({ ...s.config, ...action.config });
    return ok();
  }

  if (action.type === "rematch") {
    if (s.phase !== "finished") return fail("The game isn't over yet.");
    if (action.playerId !== s.hostId) return fail("Only the host can start a rematch.");
    // Same players, colours and rules; everything about the last match is wiped. Players can
    // still join or leave in the lobby before the host starts again.
    if (s.autoSize) {
      s.config.width = 0;
      s.config.height = 0;
    }
    for (const t of Object.values(s.tanks)) Object.assign(t, { x: -1, y: -1, hearts: 0, range: 0, ap: 0, alive: true });
    s.phase = "lobby";
    s.pickups = [];
    s.tick = 0;
    s.nextTickAt = null;
    s.juryVotes = {};
    s.orders = {};
    s.resolving = null;
    s.winnerId = null;
    log("Rematch! Everyone is back in the lobby.");
    return ok();
  }

  // --- Server clock --------------------------------------------------------------------------
  if (action.type === "tick") {
    if (s.phase !== "playing") return fail("The game is not running.");
    if (s.config.mode === "rounds") {
      if (s.resolving) return fail("The round is already resolving.");
      beginRound(s, rng, log, action.now);
    } else {
      endTick(s, rng, log, action.now);
    }
    s.rng = rng.seed;
    return ok();
  }

  if (action.type === "resolveStep") {
    const r = s.resolving;
    if (s.phase !== "playing" || !r) return fail("Nothing to resolve.");
    if (action.now < r.nextAt) return fail("Not yet.");
    r.done = null;
    // Orders from tanks destroyed earlier in the round are dropped without a pause.
    while (r.queue[0] && !s.tanks[r.queue[0].playerId]?.alive) r.queue.shift();
    const step = r.queue.shift();
    if (!step) {
      s.resolving = null;
      endTick(s, rng, log, action.now);
    } else {
      const actor = s.tanks[step.playerId]!;
      const error = perform(s, step, (text) => log(text, action.now));
      if (error) log(`${actor.name}'s order was skipped: ${error}`, action.now);
      else r.done = step;
      // If that shot won the game, `resolving` stays as it is (no more steps run once the game is
      // over), so the winning shot is still there to animate.
      r.nextAt = action.now + RESOLVE_STEP_MS;
    }
    s.rng = rng.seed;
    return ok();
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
    return ok(); // Votes are secret until the tick — no log entry.
  }

  if (!me.alive) return fail("Your tank has been destroyed. You can still vote on the jury.");

  if (action.type === "order" || action.type === "cancelOrder") {
    if (s.config.mode !== "rounds") return fail("This game is played in real time — just act.");
    if (s.resolving) return fail("Wait for this round to finish playing out.");
    if (action.type === "cancelOrder") {
      if (!s.orders[me.id]) return fail("You have no order to cancel.");
      delete s.orders[me.id];
      return ok();
    }
    if (!isOrder(action.order)) return fail("That isn't something a tank can do.");
    // One order per round: a new one replaces the old, and is checked against the board as it is now.
    const order = { ...action.order, playerId: me.id } as OrderAction;
    const error = perform(structuredClone(prev), order, () => {});
    if (error) return fail(error);
    s.orders[me.id] = order;
    return ok(); // Plans are secret — no log entry.
  }

  if (s.config.mode === "rounds") return fail("Plan your orders — they play out when the round ends.");
  const error = perform(s, action, log);
  return error ? fail(error) : ok();
}

// ---------------------------------------------------------------------------------------------
// Internals

/** Carry out one tank action on a state that is already a working copy. Returns an error or null. */
function perform(s: GameState, action: OrderAction, log: Log): string | null {
  const me = s.tanks[action.playerId];
  if (!me) return "You are not in this game.";
  if (!me.alive) return `${me.name} has been destroyed.`;

  if (action.type === "move") {
    const { dx, dy } = action;
    if (![-1, 0, 1].includes(dx) || ![-1, 0, 1].includes(dy) || (dx === 0 && dy === 0)) {
      return "Tanks move one square at a time (diagonals allowed).";
    }
    if (me.ap < 1) return "Not enough AP.";
    const to = { x: me.x + dx, y: me.y + dy };
    if (to.x < 0 || to.y < 0 || to.x >= s.config.width || to.y >= s.config.height) return "That's off the board.";
    if (tankAt(s, to)) return "That square is occupied.";
    me.ap -= 1;
    me.x = to.x;
    me.y = to.y;
    const pickupIndex = s.pickups.findIndex((p) => p.x === to.x && p.y === to.y);
    if (pickupIndex >= 0) {
      s.pickups.splice(pickupIndex, 1);
      me.hearts += 1;
      log(`${me.name} picked up a heart.`);
    }
    return null;
  }

  if (action.type === "upgradeRange") {
    if (me.ap < s.config.upgradeRangeCost) return `Upgrading range costs ${s.config.upgradeRangeCost} AP.`;
    me.ap -= s.config.upgradeRangeCost;
    me.range += 1;
    log(`${me.name} upgraded their range to ${me.range}.`);
    return null;
  }

  // Remaining actions all target another tank within range.
  const target = s.tanks[action.targetId];
  if (!target) return "No such tank.";
  if (target.id === me.id) return "You can't target yourself.";
  if (!inRange(me, target)) return `${target.name} is out of range.`;

  if (action.type === "shoot") {
    if (!target.alive) return `${target.name} is already destroyed.`;
    if (me.ap < 1) return "Not enough AP.";
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
    return null;
  }

  if (action.type === "giveAP") {
    if (!target.alive) return `${target.name} is destroyed — AP would be wasted.`;
    if (me.ap < 1) return "Not enough AP.";
    me.ap -= 1;
    target.ap += 1;
    log(`${me.name} gave 1 AP to ${target.name}.`);
    return null;
  }

  if (action.type === "giveHeart") {
    if (!s.config.allowGiveHeart) return "Giving hearts is disabled in this game.";
    if (me.hearts < 2) return "You need at least 2 hearts to give one away.";
    if (!target.alive && !s.config.heartRevives) return `${target.name} is destroyed.`;
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
    return null;
  }

  const unknown: never = action;
  return `Unknown action ${(unknown as { type: string }).type}`;
}

/** Rounds mode: lock in everyone's orders and shuffle who goes first. */
function beginRound(s: GameState, rng: Rng, log: Log, now: number): void {
  const turnOrder = rng.shuffle(livingTanks(s).map((t) => t.id)).filter((id) => s.orders[id]);
  const queue = turnOrder.map((id) => s.orders[id]!);
  s.orders = {};
  if (!queue.length) {
    log("Nobody planned anything this round.", now);
    endTick(s, rng, log, now);
    return;
  }
  s.nextTickAt = null; // the clock restarts once the round has played out
  s.resolving = { turnOrder, queue, nextAt: now, done: null };
  log(`Round ${s.tick + 1} plays out in this order: ${turnOrder.map((id) => s.tanks[id]!.name).join(" → ")}.`, now);
}

/** AP income, the jury's bonus, heart spawns and the next tick's time. */
function endTick(s: GameState, rng: Rng, log: Log, now: number): void {
  s.tick += 1;
  for (const t of livingTanks(s)) t.ap += s.config.apPerTick;

  const tally = juryTally(s);
  for (const [targetId, votes] of Object.entries(tally)) {
    const target = s.tanks[targetId];
    if (target?.alive && votes >= s.config.juryVotesNeeded) {
      target.ap += 1;
      log(`The jury awarded ${target.name} a bonus AP (${votes} votes).`, now);
    }
  }
  s.juryVotes = {};

  for (let i = 0; i < s.config.heartsSpawnedPerTick; i++) {
    const spot = randomEmptySquare(s, rng);
    if (!spot) break;
    s.pickups.push(spot);
    log(`A heart appeared at ${coord(spot)}.`, now);
  }

  // On-time ticks keep a steady cadence. Early (forced) ticks restart the clock from now, and
  // so do very late ones (e.g. the server was down), so we never schedule a tick in the past.
  const scheduled = s.nextTickAt ?? now;
  let next = scheduled <= now ? scheduled + s.config.tickIntervalMs : now + s.config.tickIntervalMs;
  if (next <= now) next = now + s.config.tickIntervalMs;
  s.nextTickAt = next;
  log(`Tick ${s.tick}: everyone still alive got ${s.config.apPerTick} AP.`, now);
}

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
