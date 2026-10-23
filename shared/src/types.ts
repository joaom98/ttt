// Core data types shared by the server (authoritative) and the client (rendering + previews).
// Everything here is plain JSON so it can be sent over the wire and saved to disk as-is.

export interface GameConfig {
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
  winnerId: string | null;
  /** Seeded RNG state so the reducer stays pure and replayable. */
  rng: number;
  log: LogEntry[];
  createdAt: number;
}

export type Action =
  | { type: "join"; playerId: string; name: string }
  | { type: "leave"; playerId: string }
  | { type: "start"; playerId: string; now: number }
  | { type: "move"; playerId: string; dx: number; dy: number }
  | { type: "shoot"; playerId: string; targetId: string }
  | { type: "giveAP"; playerId: string; targetId: string }
  | { type: "giveHeart"; playerId: string; targetId: string }
  | { type: "upgradeRange"; playerId: string }
  | { type: "juryVote"; playerId: string; targetId: string }
  | { type: "tick"; now: number };

/** Actions a player can send. "tick" is only ever issued by the server. */
export type PlayerAction = Exclude<Action, { type: "tick" }>;

export type Result = { ok: true; state: GameState } | { ok: false; error: string };
