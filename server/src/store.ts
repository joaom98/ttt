// Holds every game in memory, persists each one to a JSON file, runs the tick clock and
// notifies subscribers (the event streams) whenever a game changes.

import { randomBytes, randomInt } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PRESETS } from "../../shared/src/config.ts";
import { applyAction, createGame } from "../../shared/src/rules.ts";
import type { GameConfig, GameState, PlayerAction } from "../../shared/src/types.ts";
import type { LobbySummary } from "../../shared/src/view.ts";

interface StoredGame {
  state: GameState;
  /** Secret token -> player id. Tokens are how a browser proves which tank it controls. */
  tokens: Record<string, string>;
}

type Listener = (state: GameState) => void;

export type Outcome<T> = { ok: true; value: T } | { ok: false; error: string; status: number };

const GAME_ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I — easy to read aloud

export interface StoreOptions {
  /** Where game files are saved. null keeps everything in memory (used by tests). */
  dataDir: string | null;
  now?: () => number;
}

export class GameStore {
  private games = new Map<string, StoredGame>();
  private listeners = new Map<string, Set<Listener>>();
  private dataDir: string | null;
  private now: () => number;

  constructor(opts: StoreOptions) {
    this.dataDir = opts.dataDir;
    this.now = opts.now ?? Date.now;
    if (this.dataDir) {
      mkdirSync(this.dataDir, { recursive: true });
      this.loadAll();
    }
  }

  // --- queries -------------------------------------------------------------------------------

  get(gameId: string): GameState | undefined {
    return this.games.get(gameId.toUpperCase())?.state;
  }

  playerForToken(gameId: string, token: string | null | undefined): string | null {
    if (!token) return null;
    return this.games.get(gameId.toUpperCase())?.tokens[token] ?? null;
  }

  openLobbies(): LobbySummary[] {
    return [...this.games.values()]
      .filter((g) => g.state.phase === "lobby")
      .map(({ state }) => ({
        id: state.id,
        hostName: state.tanks[state.hostId]?.name ?? "?",
        players: state.order.length,
        tickIntervalMs: state.config.tickIntervalMs,
        createdAt: state.createdAt,
      }))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  // --- commands ------------------------------------------------------------------------------

  create(hostName: string, preset: string | undefined, config: Partial<GameConfig> | undefined) {
    const base = preset && PRESETS[preset] ? PRESETS[preset].config : {};
    const id = this.newGameId();
    const playerId = newId();
    const result = createGame({
      id, hostId: playerId, hostName, config: { ...base, ...config }, seed: randomInt(2 ** 31), now: this.now(),
    });
    if (!result.ok) return fail(result.error);
    const token = newToken();
    this.games.set(id, { state: result.state, tokens: { [token]: playerId } });
    this.commit(id);
    return { ok: true as const, value: { gameId: id, playerId, token } };
  }

  join(gameId: string, name: string): Outcome<{ playerId: string; token: string }> {
    const game = this.games.get(gameId.toUpperCase());
    if (!game) return fail("Game not found.", 404);
    const playerId = newId();
    const result = applyAction(game.state, { type: "join", playerId, name });
    if (!result.ok) return fail(result.error);
    const token = newToken();
    game.state = result.state;
    game.tokens[token] = playerId;
    this.commit(game.state.id);
    return { ok: true, value: { playerId, token } };
  }

  /** Apply a player's action. The player id always comes from the token, never the client. */
  act(gameId: string, token: string, action: PlayerAction): Outcome<GameState> {
    const game = this.games.get(gameId.toUpperCase());
    if (!game) return fail("Game not found.", 404);
    const playerId = game.tokens[token];
    if (!playerId) return fail("You are not a player in this game.", 403);
    if (action.type === "join") return fail("Use the join endpoint.");
    const stamped = { ...action, playerId, ...(action.type === "start" ? { now: this.now() } : {}) } as PlayerAction;
    const result = applyAction(game.state, stamped);
    if (!result.ok) return fail(result.error);
    game.state = result.state;
    if (action.type === "leave") {
      delete game.tokens[token];
      if (game.state.order.length === 0) {
        this.remove(game.state.id);
        return { ok: true, value: game.state };
      }
    }
    this.commit(game.state.id);
    return { ok: true, value: game.state };
  }

  /** Debug helper: the host of a debug game can trigger the next tick immediately. */
  forceTick(gameId: string, token: string): Outcome<GameState> {
    const game = this.games.get(gameId.toUpperCase());
    if (!game) return fail("Game not found.", 404);
    if (game.tokens[token] !== game.state.hostId) return fail("Only the host can do that.", 403);
    if (!game.state.config.debug) return fail("Debug mode is off for this game.", 403);
    const result = applyAction(game.state, { type: "tick", now: this.now() });
    if (!result.ok) return fail(result.error);
    game.state = result.state;
    this.commit(game.state.id);
    return { ok: true, value: game.state };
  }

  /** Run any ticks that are due. Called every second by the server. */
  runDueTicks(): void {
    const now = this.now();
    for (const game of this.games.values()) {
      if (game.state.phase !== "playing" || game.state.nextTickAt === null) continue;
      if (game.state.nextTickAt > now) continue;
      const result = applyAction(game.state, { type: "tick", now });
      if (result.ok) {
        game.state = result.state;
        this.commit(game.state.id);
      }
    }
  }

  subscribe(gameId: string, listener: Listener): () => void {
    const id = gameId.toUpperCase();
    let set = this.listeners.get(id);
    if (!set) this.listeners.set(id, (set = new Set()));
    set.add(listener);
    return () => set.delete(listener);
  }

  // --- internals -----------------------------------------------------------------------------

  private commit(gameId: string): void {
    const game = this.games.get(gameId);
    if (!game) return;
    this.save(game);
    for (const listener of this.listeners.get(gameId) ?? []) listener(game.state);
  }

  private remove(gameId: string): void {
    this.games.delete(gameId);
    if (this.dataDir) {
      try {
        unlinkSync(join(this.dataDir, `${gameId}.json`));
      } catch {
        // already gone
      }
    }
  }

  private save(game: StoredGame): void {
    if (!this.dataDir) return;
    const file = join(this.dataDir, `${game.state.id}.json`);
    writeFileSync(`${file}.tmp`, JSON.stringify(game));
    renameSync(`${file}.tmp`, file);
  }

  private loadAll(): void {
    if (!this.dataDir) return;
    for (const name of readdirSync(this.dataDir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const game = JSON.parse(readFileSync(join(this.dataDir, name), "utf8")) as StoredGame;
        this.games.set(game.state.id, game);
      } catch (e) {
        console.warn(`Skipping unreadable game file ${name}:`, e);
      }
    }
    if (this.games.size) console.log(`Loaded ${this.games.size} saved game(s).`);
  }

  private newGameId(): string {
    for (;;) {
      let id = "";
      for (let i = 0; i < 5; i++) id += GAME_ID_ALPHABET[randomInt(GAME_ID_ALPHABET.length)];
      if (!this.games.has(id)) return id;
    }
  }
}

function fail(error: string, status = 400): { ok: false; error: string; status: number } {
  return { ok: false, error, status };
}

function newId(): string {
  return randomBytes(6).toString("base64url");
}

function newToken(): string {
  return randomBytes(24).toString("base64url");
}
