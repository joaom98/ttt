import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/app.ts";
import { GameStore } from "../src/store.ts";
import type { StateMessage } from "../../shared/src/view.ts";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
let clock = 1_000_000;
const store = new GameStore({ dataDir: null, now: () => clock });
const server = createApp(store, rootDir, () => clock);
let base = "";

before(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

async function api(path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, body === undefined ? {} : {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

describe("game API", () => {
  let gameId = "";
  let host = { playerId: "", token: "" };
  let guest = { playerId: "", token: "" };

  it("creates a game and lists it as an open lobby", async () => {
    const r = await api("/api/games", { name: "Ana", preset: "quick" });
    assert.equal(r.status, 200);
    ({ gameId } = r.json);
    host = r.json;
    assert.match(gameId, /^[A-Z2-9]{5}$/);
    const list = await api("/api/games");
    assert.equal(list.json.lobbies[0].id, gameId);
  });

  it("lets a second player join (game codes are case-insensitive)", async () => {
    const r = await api(`/api/games/${gameId.toLowerCase()}/join`, { name: "Bia" });
    assert.equal(r.status, 200);
    guest = r.json;
    assert.equal((await api(`/api/games/${gameId}/join`, { name: "bia" })).status, 400);
  });

  it("rejects actions without a valid token", async () => {
    const r = await api(`/api/games/${gameId}/actions`, { token: "nope", action: { type: "start" } });
    assert.equal(r.status, 403);
  });

  it("starts the game and applies actions as the token's owner, not the claimed player", async () => {
    assert.equal((await api(`/api/games/${gameId}/actions`, { token: guest.token, action: { type: "start" } })).status, 400);
    assert.equal((await api(`/api/games/${gameId}/actions`, { token: host.token, action: { type: "start" } })).status, 200);
    const state = store.get(gameId)!;
    assert.equal(state.phase, "playing");
    assert.equal(state.nextTickAt, clock + 30_000);
    // Guest tries to spoof the host's id — the server ignores it and uses the guest.
    const r = await api(`/api/games/${gameId}/actions`, {
      token: guest.token, action: { type: "upgradeRange", playerId: host.playerId },
    });
    assert.match(r.json.error, /3 AP/);
  });

  it("ticks on schedule and via the debug endpoint", async () => {
    clock += 30_000;
    store.runDueTicks();
    assert.equal(store.get(gameId)!.tick, 1);
    assert.equal((await api(`/api/games/${gameId}/debug/tick`, { token: guest.token })).status, 403);
    assert.equal((await api(`/api/games/${gameId}/debug/tick`, { token: host.token })).status, 200);
    assert.equal(store.get(gameId)!.tick, 2);
  });

  it("streams state over server-sent events", async () => {
    const res = await fetch(`${base}/api/games/${gameId}/events?token=${host.token}`);
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    const reader = res.body!.getReader();
    const readMessage = async (): Promise<StateMessage> => {
      let buf = "";
      for (;;) {
        const { value } = await reader.read();
        buf += new TextDecoder().decode(value);
        const m = buf.match(/data: (.*)\n\n/);
        if (m) return JSON.parse(m[1]!);
      }
    };
    const first = await readMessage();
    assert.equal(first.you, host.playerId);
    assert.equal(first.state.tick, 2);
    await api(`/api/games/${gameId}/debug/tick`, { token: host.token });
    const second = await readMessage();
    assert.equal(second.state.tick, 3);
    await reader.cancel();
  });
});

describe("static files", () => {
  it("serves the client and strips TypeScript types", async () => {
    const html = await fetch(`${base}/`);
    assert.match(await html.text(), /<title>/);
    const ts = await fetch(`${base}/shared/src/config.ts`);
    assert.match(ts.headers.get("content-type")!, /javascript/);
    const js = await ts.text();
    assert.doesNotMatch(js, /: GameConfig/);
  });

  it("refuses paths outside the public folders", async () => {
    assert.equal((await fetch(`${base}/server/src/store.ts`)).status, 404);
    assert.equal((await fetch(`${base}/client/../package.json`)).status, 404);
    assert.equal((await fetch(`${base}/%2e%2e/package.json`)).status, 404);
    assert.equal((await fetch(`${base}/shared/test/rules.test.ts`)).status, 404);
  });
});
