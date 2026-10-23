import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/app.ts";
import { GameStore } from "../src/store.ts";
import { publicCause, type StateMessage } from "../../shared/src/view.ts";

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
    assert.equal(first.cause, null);
    await api(`/api/games/${gameId}/debug/tick`, { token: host.token });
    const second = await readMessage();
    assert.equal(second.state.tick, 3);
    assert.equal(second.cause?.type, "tick"); // lets the browser animate what just happened
    await reader.cancel();
  });

  it("never reveals a jury vote as the cause of an update", () => {
    assert.equal(publicCause({ type: "juryVote", playerId: "a", targetId: "b" }), null);
    assert.deepEqual(publicCause({ type: "upgradeRange", playerId: "a" }), { type: "upgradeRange", playerId: "a" });
  });
});

describe("chat", () => {
  let gameId = "";
  let ana = { playerId: "", token: "" };
  let bia = { playerId: "", token: "" };
  let caio = { playerId: "", token: "" };

  it("delivers public messages to everyone and private ones only to the two players", async () => {
    ana = (await api("/api/games", { name: "Ana" })).json;
    gameId = (ana as unknown as { gameId: string }).gameId;
    bia = (await api(`/api/games/${gameId}/join`, { name: "Bia" })).json;
    caio = (await api(`/api/games/${gameId}/join`, { name: "Caio" })).json;

    assert.equal((await api(`/api/games/${gameId}/chat`, { token: ana.token, text: "  hi all  " })).status, 200);
    clock += 1000;
    assert.equal((await api(`/api/games/${gameId}/chat`, { token: ana.token, text: "ally?", to: bia.playerId })).status, 200);

    const seenBy = async (token: string) =>
      ((await api(`/api/games/${gameId}?token=${token}`)).json as StateMessage).chat.map((m) => m.text);
    assert.deepEqual(await seenBy(ana.token), ["hi all", "ally?"]);
    assert.deepEqual(await seenBy(bia.token), ["hi all", "ally?"]);
    assert.deepEqual(await seenBy(caio.token), ["hi all"]);
    assert.deepEqual(await seenBy(""), ["hi all"]);
  });

  it("rejects strangers, empty messages, unknown recipients and spam", async () => {
    assert.equal((await api(`/api/games/${gameId}/chat`, { token: "nope", text: "x" })).status, 403);
    clock += 1000;
    assert.equal((await api(`/api/games/${gameId}/chat`, { token: caio.token, text: "   " })).status, 400);
    assert.equal((await api(`/api/games/${gameId}/chat`, { token: caio.token, text: "x", to: "ghost" })).status, 400);
    assert.equal((await api(`/api/games/${gameId}/chat`, { token: caio.token, text: "x", to: caio.playerId })).status, 400);
    assert.equal((await api(`/api/games/${gameId}/chat`, { token: caio.token, text: "one" })).status, 200);
    assert.equal((await api(`/api/games/${gameId}/chat`, { token: caio.token, text: "two" })).status, 429);
  });
});

describe("bots", () => {
  it("lets only the host add and remove bots in the lobby", async () => {
    const host = (await api("/api/games", { name: "Ana", preset: "quick", bots: ["hunter", "nonsense"] })).json;
    const { gameId } = host;
    const guest = (await api(`/api/games/${gameId}/join`, { name: "Bia" })).json;
    const bots = () => store.botsOf(gameId);
    assert.deepEqual(Object.values(bots()), ["hunter"]);

    assert.equal((await api(`/api/games/${gameId}/bots`, { token: guest.token, personality: "turtle" })).status, 403);
    assert.equal((await api(`/api/games/${gameId}/bots`, { token: host.token, personality: "nonsense" })).status, 400);
    assert.equal((await api(`/api/games/${gameId}/bots`, { token: host.token, personality: "turtle" })).status, 200);
    assert.deepEqual(Object.values(bots()).sort(), ["hunter", "turtle"]);

    const turtle = Object.keys(bots()).find((id) => bots()[id] === "turtle")!;
    assert.equal((await api(`/api/games/${gameId}/bots/remove`, { token: host.token, playerId: guest.playerId })).status, 400);
    assert.equal((await api(`/api/games/${gameId}/bots/remove`, { token: host.token, playerId: turtle })).status, 200);
    assert.equal(store.get(gameId)!.order.length, 3);
  });

  it("play on their own once the game starts", async () => {
    const host = (await api("/api/games", { name: "Ana", preset: "quick", bots: ["hunter", "hunter"] })).json;
    const { gameId } = host;
    await api(`/api/games/${gameId}/actions`, { token: host.token, action: { type: "start" } });
    const s = store.get(gameId)!;
    const [a, b] = Object.keys(store.botsOf(gameId)).map((id) => s.tanks[id]!);
    // Park the two hunters next to each other with AP to burn.
    a!.x = 0; a!.y = 0; a!.ap = 5;
    b!.x = 1; b!.y = 0; b!.ap = 5;
    s.tanks[host.playerId]!.x = 7; // far corner of the 8x8 board
    s.tanks[host.playerId]!.y = 7;
    store.runBots(); // first call only schedules their thinking time
    const before = a!.hearts + b!.hearts;
    for (let i = 0; i < 10; i++) {
      clock += 5000;
      store.runBots();
    }
    const after = store.get(gameId)!;
    assert.ok(after.tanks[a!.id]!.hearts + after.tanks[b!.id]!.hearts < before, "the bots should have shot each other");
  });

  it("closes the lobby when the last human leaves", async () => {
    const host = (await api("/api/games", { name: "Ana", bots: ["turtle"] })).json;
    await api(`/api/games/${host.gameId}/actions`, { token: host.token, action: { type: "leave" } });
    assert.equal(store.get(host.gameId), undefined);
  });

  it("never hands the host role to a bot", async () => {
    const host = (await api("/api/games", { name: "Ana", bots: ["turtle"] })).json;
    const guest = (await api(`/api/games/${host.gameId}/join`, { name: "Bia" })).json;
    await api(`/api/games/${host.gameId}/actions`, { token: host.token, action: { type: "leave" } });
    assert.equal(store.get(host.gameId)!.hostId, guest.playerId);
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
