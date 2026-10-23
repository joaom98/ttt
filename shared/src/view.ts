import type { GameState } from "./types.ts";

/**
 * What a given player is allowed to see. Everything on the board is public (that's the game!),
 * but jury votes stay secret until the tick: each viewer only sees their own vote.
 */
export function viewFor(state: GameState, viewerId: string | null): GameState {
  const ownVote = viewerId ? state.juryVotes[viewerId] : undefined;
  return {
    ...state,
    rng: 0,
    juryVotes: viewerId && ownVote ? { [viewerId]: ownVote } : {},
  };
}

/** Message the server pushes over the event stream. */
export interface StateMessage {
  state: GameState;
  /** Server clock when the message was sent, so clients can correct countdowns for clock skew. */
  serverNow: number;
  you: string | null;
}

/** Summary row for the open-lobbies list. */
export interface LobbySummary {
  id: string;
  hostName: string;
  players: number;
  tickIntervalMs: number;
  createdAt: number;
}
