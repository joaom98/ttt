// Core data types shared by the server (authoritative) and the client (rendering + previews).
// Everything here is plain JSON so it can be sent over the wire and saved to disk as-is.

/**
 * "realtime": act whenever you have AP.
 * "rounds": each tick, plan one hidden order; when the tick ends the orders resolve one player at
 * a time, in a random order, so reaction speed doesn't matter.
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
  /** Real time between ticks. The original game used 24h; use seconds for local testing. */
  tickIntervalMs: number;
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
  /** Debug mode lets the host force a tick and is shown in the UI. Turn off for real games. */
  debug: boolean;
}

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
  /** Braced for a hit until the next tick: shots do no damage and the shooter loses 1 AP to us. */
  parrying: boolean;
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
  /** Epoch ms of the next scheduled tick (null outside the "playing" phase). */
  nextTickAt: number | null;
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
  | { type: "shoot"; playerId: string; targetId: string }
  | { type: "giveAP"; playerId: string; targetId: string }
  | { type: "giveHeart"; playerId: string; targetId: string }
  | { type: "upgradeRange"; playerId: string }
  | { type: "parry"; playerId: string };

export interface Resolution {
  /** The shuffled order players act in this round (only players who planned something). */
  turnOrder: string[];
  /** Orders still to play out, in turn order (one per player). */
  queue: OrderAction[];
  /** Epoch ms when the next step may run. */
  nextAt: number;
  /** The order carried out by the latest step (null if it was skipped), so clients can animate it. */
  done: OrderAction | null;
}

export type Action =
  | { type: "join"; playerId: string; name: string }
  | { type: "leave"; playerId: string }
  | { type: "start"; playerId: string; now: number }
  | { type: "rematch"; playerId: string }
  | { type: "configure"; playerId: string; config: Partial<GameConfig> }
  | OrderAction
  | { type: "juryVote"; playerId: string; targetId: string }
  | { type: "order"; playerId: string; order: OrderAction }
  | { type: "cancelOrder"; playerId: string }
  | { type: "tick"; now: number }
  | { type: "resolveStep"; now: number };

/** Actions a player can send. Ticks and resolution steps are only ever issued by the server. */
export type PlayerAction = Exclude<Action, { type: "tick" } | { type: "resolveStep" }>;

export type Result = { ok: true; state: GameState } | { ok: false; error: string };
