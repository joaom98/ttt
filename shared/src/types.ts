// Core data types shared by the server (authoritative) and the client (rendering + previews).
// Everything here is plain JSON so it can be sent over the wire and saved to disk as-is.

/**
 * "realtime": act whenever you have AP.
 * "rounds": each round, plan one hidden order; when the round ends the orders resolve one player
 * at a time, in a random order, so reaction speed doesn't matter. Rounds run on their own clock,
 * separate from the AP ticks.
 */
export type Mode = "realtime" | "rounds";

export interface GameConfig {
  mode: Mode;
  /** Board size. 0 means "pick automatically from the player count when the game starts". */
  width: number;
  height: number;
  startingHearts: number;
  startingRange: number;
  startingAP: number;
  /** AP every living tank receives on each tick. */
  apPerTick: number;
  /** AP cost of increasing your range by 1. */
  upgradeRangeCost: number;
  /** Real time between AP ticks. The original game used 24h; use seconds for local testing. */
  tickIntervalMs: number;
  /** Rounds mode: real time players get to plan each round. */
  roundIntervalMs: number;
  /** Votes from dead players a living tank needs in one tick to earn a bonus AP. */
  juryVotesNeeded: number;
  /** Hearts that appear on random empty squares each tick (pick one up by driving onto it). */
  heartsSpawnedPerTick: number;
  /** Can tanks hand one of their hearts to a tank in range? */
  allowGiveHeart: boolean;
  /** Does giving a heart to a dead tank bring it back to life? */
  heartRevives: boolean;
  /** Does the killer collect the victim's remaining AP? */
  killerTakesAP: boolean;
  /** Can tanks spend AP to repair a heart? */
  allowHeal: boolean;
  /** AP cost of healing 1 heart (never above the starting hearts). */
  healCost: number;
  /** AP a parried shooter loses to the defender (on top of the wasted shot). */
  parrySteal: number;
  /** Does a parried shooter also lose its next turn (next round, or until the next tick in real time)? */
  parryStuns: boolean;
  /** Hearts a parried shooter loses to the defender's counter-hit (it can destroy the shooter). */
  parryDamage: number;
  /** Debug mode lets the host force a tick and is shown in the UI. Turn off for real games. */
  debug: boolean;
}

/** "defense" just blocks shots; "parry" also punishes the shooter (see GameConfig.parry*). */
export type Guard = "defense" | "parry";

export interface Tank {
  id: string;
  name: string;
  color: string;
  x: number;
  y: number;
  hearts: number;
  range: number;
  ap: number;
  alive: boolean;
  /** Braced for a hit (for this round, or until the next tick in real time): shots do no damage. */
  guard: Guard | null;
  /** Parried while attacking: loses its next turn (next round, or until the next tick in real time). */
  stunned: boolean;
}

export interface Position {
  x: number;
  y: number;
}

export type Phase = "lobby" | "playing" | "finished";

export interface LogEntry {
  tick: number;
  at: number;
  text: string;
}

export interface GameState {
  id: string;
  phase: Phase;
  config: GameConfig;
  hostId: string;
  /** Tanks keyed by player id. Dead tanks stay on the board as wrecks (they can be revived). */
  tanks: Record<string, Tank>;
  /** Join order — stable ordering for UI lists. */
  order: string[];
  /** Heart pickups lying on the board. */
  pickups: Position[];
  /** Number of ticks that have happened since the game started. */
  tick: number;
  /** Epoch ms of the next scheduled AP tick (null outside the "playing" phase). */
  nextTickAt: number | null;
  /** Rounds mode: rounds started so far. */
  round: number;
  /** Rounds mode: epoch ms when the current round's planning ends (null while it plays out). */
  nextRoundAt: number | null;
  /** Jury votes for the current tick: dead voter id -> living target id. */
  juryVotes: Record<string, string>;
  /** Rounds mode: each player's one planned order for this round (secret — see view.ts). */
  orders: Record<string, OrderAction>;
  /** Rounds mode: the round being played out, step by step. Null while planning. */
  resolving: Resolution | null;
  winnerId: string | null;
  /** The board size was picked from the player count at the start, so a rematch picks it again. */
  autoSize: boolean;
  /** Seeded RNG state so the reducer stays pure and replayable. */
  rng: number;
  log: LogEntry[];
  createdAt: number;
}

/** The things a tank does with its AP. In rounds mode these are queued as orders. */
export type OrderAction =
  | { type: "move"; playerId: string; dx: number; dy: number }
  /** Shots are aimed at a square: if no tank is there when it fires, it misses. */
  | { type: "shoot"; playerId: string; x: number; y: number }
  | { type: "giveAP"; playerId: string; targetId: string }
  | { type: "giveHeart"; playerId: string; targetId: string }
  | { type: "upgradeRange"; playerId: string }
  | { type: "defend"; playerId: string }
  | { type: "parry"; playerId: string }
  | { type: "heal"; playerId: string };

export interface Resolution {
  /** The shuffled order players act in this round (only players who planned something). */
  turnOrder: string[];
  /** Orders still to play out, in turn order (one per player). */
  queue: OrderAction[];
  /** Epoch ms when the next step may run. */
  nextAt: number;
  /** The order carried out by the latest step (null if it was skipped), so clients can animate it. */
  done: OrderAction | null;
  /** Tanks stunned when the round began: they sit it out, and recover once it has played out. */
  sittingOut: string[];
}

export type Action =
  | { type: "join"; playerId: string; name: string }
  | { type: "leave"; playerId: string }
  | { type: "kick"; playerId: string; targetId: string }
  | { type: "start"; playerId: string; now: number }
  | { type: "rematch"; playerId: string }
  | { type: "configure"; playerId: string; config: Partial<GameConfig> }
  | OrderAction
  | { type: "juryVote"; playerId: string; targetId: string }
  | { type: "order"; playerId: string; order: OrderAction }
  | { type: "cancelOrder"; playerId: string }
  | { type: "tick"; now: number }
  | { type: "endRound"; now: number }
  | { type: "resolveStep"; now: number };

/** Actions a player can send. The clocks (ticks, rounds, resolution steps) are only ever run by the server. */
export type PlayerAction = Exclude<Action, { type: "tick" } | { type: "endRound" } | { type: "resolveStep" }>;

export type Result = { ok: true; state: GameState } | { ok: false; error: string };
