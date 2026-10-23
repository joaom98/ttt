// Thin wrapper around the server's HTTP API plus the per-game session stored in localStorage.

import type { GameConfig, PlayerAction } from "../../shared/src/types.ts";
import type { LobbySummary, StateMessage } from "../../shared/src/view.ts";

export interface Session {
  gameId: string;
  playerId: string;
  token: string;
}

const sessionKey = (gameId: string) => `ttt:session:${gameId.toUpperCase()}`;

export function loadSession(gameId: string): Session | null {
  try {
    const raw = localStorage.getItem(sessionKey(gameId));
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export function saveSession(s: Session): void {
  try {
    localStorage.setItem(sessionKey(s.gameId), JSON.stringify(s));
  } catch {
    // Private mode etc. — the player just won't be remembered after a reload.
  }
}

export function clearSession(gameId: string): void {
  try {
    localStorage.removeItem(sessionKey(gameId));
  } catch {
    // ignore
  }
}

export function lastName(): string {
  try {
    return localStorage.getItem("ttt:name") ?? "";
  } catch {
    return "";
  }
}

export function rememberName(name: string): void {
  try {
    localStorage.setItem("ttt:name", name);
  } catch {
    // ignore
  }
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body === undefined ? {} : {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`);
  return json;
}

export const api = {
  lobbies: () => call<{ lobbies: LobbySummary[] }>("/api/games"),
  create: (name: string, preset: string, config: Partial<GameConfig>) =>
    call<{ gameId: string; playerId: string; token: string }>("/api/games", { name, preset, config }),
  join: (gameId: string, name: string) =>
    call<{ playerId: string; token: string }>(`/api/games/${gameId}/join`, { name }),
  act: (session: Session, action: PlayerAction) =>
    call<{ ok: true }>(`/api/games/${session.gameId}/actions`, { token: session.token, action }),
  forceTick: (session: Session) =>
    call<{ ok: true }>(`/api/games/${session.gameId}/debug/tick`, { token: session.token }),
};

/** Live state stream. EventSource reconnects by itself if the connection drops. */
export function subscribe(
  gameId: string,
  token: string | null,
  onMessage: (m: StateMessage) => void,
  onStatus: (connected: boolean) => void,
): () => void {
  const qs = token ? `?token=${encodeURIComponent(token)}` : "";
  const source = new EventSource(`/api/games/${gameId}/events${qs}`);
  source.addEventListener("state", (e) => onMessage(JSON.parse((e as MessageEvent<string>).data) as StateMessage));
  source.onopen = () => onStatus(true);
  source.onerror = () => onStatus(false);
  return () => source.close();
}
