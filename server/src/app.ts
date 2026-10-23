// HTTP layer: a tiny JSON API, a Server-Sent Events stream per game, and static files.
//
//   GET  /api/games                    open lobbies
//   POST /api/games                    { name, preset?, config? }        -> { gameId, playerId, token }
//   GET  /api/games/:id?token=         current state (as that player sees it)
//   POST /api/games/:id/join           { name }                          -> { playerId, token }
//   POST /api/games/:id/actions        { token, action }                 -> { ok } | { error }
//   POST /api/games/:id/debug/tick     { token }                         (host, debug games only)
//   GET  /api/games/:id/events?token=  text/event-stream of StateMessage

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { GameConfig, PlayerAction } from "../../shared/src/types.ts";
import { viewFor, type StateMessage } from "../../shared/src/view.ts";
import { serveStatic } from "./static.ts";
import type { GameStore, Outcome } from "./store.ts";

const MAX_BODY_BYTES = 16 * 1024;
const HEARTBEAT_MS = 25_000;

export function createApp(store: GameStore, rootDir: string, now: () => number = Date.now): Server {
  return createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error(e);
      if (!res.headersSent) sendJson(res, 500, { error: "Something went wrong on the server." });
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean); // e.g. ["api", "games", "ABCDE", "join"]

    if (parts[0] !== "api") return serveStatic(rootDir, url.pathname, res);
    if (parts[1] !== "games") return sendJson(res, 404, { error: "Not found." });

    const gameId = parts[2];
    const sub = parts.slice(3).join("/");

    if (!gameId) {
      if (req.method === "GET") return sendJson(res, 200, { lobbies: store.openLobbies() });
      if (req.method === "POST") {
        const body = await readBody(req);
        const name = typeof body.name === "string" ? body.name : "";
        const preset = typeof body.preset === "string" ? body.preset : undefined;
        const config = isObject(body.config) ? (body.config as Partial<GameConfig>) : undefined;
        return reply(res, store.create(name, preset, config));
      }
    }

    if (gameId && req.method === "GET" && sub === "") {
      const state = store.get(gameId);
      if (!state) return sendJson(res, 404, { error: "Game not found." });
      const you = store.playerForToken(gameId, url.searchParams.get("token"));
      return sendJson(res, 200, message(state, you));
    }

    if (gameId && req.method === "GET" && sub === "events") {
      return stream(gameId, url.searchParams.get("token"), req, res);
    }

    if (gameId && req.method === "POST") {
      const body = await readBody(req);
      const token = typeof body.token === "string" ? body.token : "";
      if (sub === "join") return reply(res, store.join(gameId, typeof body.name === "string" ? body.name : ""));
      if (sub === "actions") {
        if (!isObject(body.action) || typeof (body.action as { type?: unknown }).type !== "string") {
          return sendJson(res, 400, { error: "Missing action." });
        }
        const r = store.act(gameId, token, body.action as PlayerAction);
        return r.ok ? sendJson(res, 200, { ok: true }) : sendJson(res, r.status, { error: r.error });
      }
      if (sub === "debug/tick") {
        const r = store.forceTick(gameId, token);
        return r.ok ? sendJson(res, 200, { ok: true }) : sendJson(res, r.status, { error: r.error });
      }
    }

    sendJson(res, 404, { error: "Not found." });
  }

  function message(state: Parameters<typeof viewFor>[0], you: string | null): StateMessage {
    return { state: viewFor(state, you), serverNow: now(), you };
  }

  function stream(gameId: string, token: string | null, req: IncomingMessage, res: ServerResponse): void {
    const state = store.get(gameId);
    if (!state) return sendJson(res, 404, { error: "Game not found." });
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no", // keep reverse proxies from buffering the stream
    });
    // Resolve the token on every send: it stops matching once the player leaves the lobby.
    const send = (s: typeof state) =>
      res.write(`event: state\ndata: ${JSON.stringify(message(s, store.playerForToken(gameId, token)))}\n\n`);
    send(state);
    const unsubscribe = store.subscribe(gameId, send);
    const heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  }
}

// --- helpers ---------------------------------------------------------------------------------

function reply<T>(res: ServerResponse, r: Outcome<T> | { ok: true; value: T }): void {
  if (r.ok) sendJson(res, 200, r.value);
  else sendJson(res, (r as { status: number }).status, { error: (r as { error: string }).error });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body too large");
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
