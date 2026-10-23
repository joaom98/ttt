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

/** A chat line. `to` is null for the public channel, otherwise the one player who can read it. */
export interface ChatMessage {
  id: number;
  at: number;
  from: string;
  to: string | null;
  text: string;
}

export const BOT_PERSONALITIES = ["hunter", "turtle", "wildcard"] as const;
export type BotPersonality = (typeof BOT_PERSONALITIES)[number];

/** Message the server pushes over the event stream. */
export interface StateMessage {
  state: GameState;
  /** Server clock when the message was sent, so clients can correct countdowns for clock skew. */
  serverNow: number;
  you: string | null;
  /** Public messages plus the private ones the viewer sent or received, oldest first. */
  chat: ChatMessage[];
  /** Which players are server-controlled bots, and how they play. */
  bots: Record<string, BotPersonality>;
}

/** Chat lines a given player is allowed to read. */
export function chatFor(chat: ChatMessage[], viewerId: string | null): ChatMessage[] {
  return chat.filter((m) => m.to === null || (viewerId !== null && (m.from === viewerId || m.to === viewerId)));
}

/** Summary row for the open-lobbies list. */
export interface LobbySummary {
  id: string;
  hostName: string;
  players: number;
  tickIntervalMs: number;
  createdAt: number;
}
