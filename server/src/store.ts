// Holds every game in memory, persists each one to a JSON file, runs the tick clock and the bots,
// and notifies subscribers (the event streams) whenever a game changes.

import { randomBytes, randomInt } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_PLAYERS, PRESETS } from "../../shared/src/config.ts";
import { applyAction, createGame } from "../../shared/src/rules.ts";
import type { GameConfig, GameState, PlayerAction } from "../../shared/src/types.ts";
import { BOT_PERSONALITIES, chatFor, type BotPersonality, type ChatMessage, type LobbySummary } from "../../shared/src/view.ts";
import { botName, chooseBotAction } from "./bots.ts";

interface StoredGame {
  state: GameState;
  /** Secret token -> player id. Tokens are how a browser proves which tank it controls. */
  tokens: Record<string, string>;
  /** Player id -> personality for the server-controlled players. */
  bots: Record<string, BotPersonality>;
  chat: ChatMessage[];
}

export const MAX_CHAT_LENGTH = 300;
const MAX_CHAT_HISTORY = 200;
const CHAT_COOLDOWN_MS = 400;
/** Bots "think" for a random time in this range between actions, so they feel like players. */
const BOT_THINK_MS = [1500, 4000] as const;

type Listener = (state: GameState) => void;

export type Outcome<T> = { ok: true; value: T } | { ok: false; error: string; status: number };

const GAME_ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I — easy to read aloud

export interface StoreOptions {
  /** Where game files are saved. null keeps everything in memory (used by tests). */
  dataDir: string | null;
  now?: () => number;
  /** Randomness for bot timing and the wildcard bot (tests pass a fixed sequence). */
  random?: () => number;
}

export class GameStore {
  private games = new Map<string, StoredGame>();
  private listeners = new Map<string, Set<Listener>>();
  private dataDir: string | null;
  private now: () => number;
  private random: () => number;
  /** "gameId:playerId" -> when that bot acts next. In memory only: bots just restart thinking. */
  private botNextAt = new Map<string, number>();
  /** "gameId:playerId" -> when that player last chatted (spam guard). */
  private lastChatAt = new Map<string, number>();

  constructor(opts: StoreOptions) {
    this.dataDir = opts.dataDir;
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
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

  chatFor(gameId: string, viewerId: string | null): ChatMessage[] {
    return chatFor(this.games.get(gameId.toUpperCase())?.chat ?? [], viewerId);
  }

  botsOf(gameId: string): Record<string, BotPersonality> {
    return this.games.get(gameId.toUpperCase())?.bots ?? {};
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

  create(
    hostName: string,
    preset: string | undefined,
    config: Partial<GameConfig> | undefined,
    bots: BotPersonality[] = [],
  ) {
    const base = preset && PRESETS[preset] ? PRESETS[preset].config : {};
    const id = this.newGameId();
    const playerId = newId();
    const result = createGame({
      id, hostId: playerId, hostName, config: { ...base, ...config }, seed: randomInt(2 ** 31), now: this.now(),
    });
    if (!result.ok) return fail(result.error);
    const token = newToken();
    const game: StoredGame = { state: result.state, tokens: { [token]: playerId }, bots: {}, chat: [] };
    for (const personality of bots.slice(0, MAX_PLAYERS - 1)) this.addBotTo(game, personality);
    this.games.set(id, game);
    this.commit(id);
    return { ok: true as const, value: { gameId: id, playerId, token } };
  }

  /** The host adds a bot to their lobby. */
  addBot(gameId: string, token: string, personality: string): Outcome<GameState> {
    const game = this.hostGame(gameId, token);
    if (!game.ok) return game;
    if (!isPersonality(personality)) return fail("Unknown kind of bot.");
    const r = this.addBotTo(game.value, personality);
    if (!r.ok) return r;
    this.commit(game.value.state.id);
    return { ok: true, value: game.value.state };
  }

  /** The host removes a bot from their lobby. */
  removeBot(gameId: string, token: string, botId: string): Outcome<GameState> {
    const game = this.hostGame(gameId, token);
    if (!game.ok) return game;
    const g = game.value;
    if (!g.bots[botId]) return fail("That player isn't a bot.");
    const result = applyAction(g.state, { type: "leave", playerId: botId });
    if (!result.ok) return fail(result.error);
    g.state = result.state;
    delete g.bots[botId];
    this.commit(g.state.id);
    return { ok: true, value: g.state };
  }

  /** Post a chat line, to everyone (to = null) or privately to one player. */
  say(gameId: string, token: string, text: string, to: string | null): Outcome<ChatMessage> {
    const game = this.games.get(gameId.toUpperCase());
    if (!game) return fail("Game not found.", 404);
    const from = game.tokens[token];
    if (!from) return fail("Only players can chat.", 403);
    const clean = text.trim().slice(0, MAX_CHAT_LENGTH);
    if (!clean) return fail("Type a message first.");
    if (to !== null && (!game.state.tanks[to] || to === from)) return fail("Pick someone else to message.");
    const key = `${game.state.id}:${from}`;
    const now = this.now();
    if (now - (this.lastChatAt.get(key) ?? -Infinity) < CHAT_COOLDOWN_MS) return fail("Slow down a little.", 429);
    this.lastChatAt.set(key, now);
    const message: ChatMessage = { id: (game.chat.at(-1)?.id ?? 0) + 1, at: now, from, to, text: clean };
    game.chat.push(message);
    if (game.chat.length > MAX_CHAT_HISTORY) game.chat.splice(0, game.chat.length - MAX_CHAT_HISTORY);
    this.commit(game.state.id);
    return { ok: true, value: message };
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
      const humans = game.state.order.filter((id) => !game.bots[id]);
      if (humans.length === 0) {
        this.remove(game.state.id);
        return { ok: true, value: game.state };
      }
      // The rules hand the host role to the next player in line — never let that be a bot.
      if (game.bots[game.state.hostId]) game.state = { ...game.state, hostId: humans[0]! };
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

  /** Let every bot whose thinking time is up take one action. Called every second by the server. */
  runBots(): void {
    const now = this.now();
    const [minThink, maxThink] = BOT_THINK_MS;
    const think = () => now + minThink + this.random() * (maxThink - minThink);
    for (const game of this.games.values()) {
      if (game.state.phase !== "playing") continue;
      for (const [botId, personality] of Object.entries(game.bots)) {
        const key = `${game.state.id}:${botId}`;
        const due = this.botNextAt.get(key);
        if (due === undefined) {
          this.botNextAt.set(key, think()); // don't pounce the moment the game starts
          continue;
        }
        if (due > now) continue;
        this.botNextAt.set(key, think());
        const action = chooseBotAction(game.state, botId, personality, this.random);
        if (!action) continue;
        const result = applyAction(game.state, action);
        if (!result.ok) continue;
        game.state = result.state;
        this.commit(game.state.id);
        if (game.state.phase !== "playing") break;
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

  private hostGame(gameId: string, token: string): Outcome<StoredGame> {
    const game = this.games.get(gameId.toUpperCase());
    if (!game) return fail("Game not found.", 404);
    if (!token || game.tokens[token] !== game.state.hostId) return fail("Only the host can do that.", 403);
    return { ok: true, value: game };
  }

  private addBotTo(game: StoredGame, personality: BotPersonality): Outcome<string> {
    const playerId = newId();
    const result = applyAction(game.state, { type: "join", playerId, name: botName(game.state, personality) });
    if (!result.ok) return fail(result.error);
    game.state = result.state;
    game.bots[playerId] = personality;
    return { ok: true, value: playerId };
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
        game.bots ??= {}; // saved before bots and chat existed
        game.chat ??= [];
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

export function isPersonality(v: unknown): v is BotPersonality {
  return (BOT_PERSONALITIES as readonly unknown[]).includes(v);
}

function newId(): string {
  return randomBytes(6).toString("base64url");
}

function newToken(): string {
  return randomBytes(24).toString("base64url");
}
