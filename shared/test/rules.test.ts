import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyAction, createGame, distance, juryTally, livingTanks } from "../src/rules.ts";
import type { Action, GameConfig, GameState, Tank } from "../src/types.ts";

// --- helpers ---------------------------------------------------------------------------------

function ok(state: GameState, action: Action): GameState {
  const r = applyAction(state, action);
  if (!r.ok) assert.fail(`expected ${action.type} to succeed, got: ${r.error}`);
  return r.state;
}

function err(state: GameState, action: Action): string {
  const r = applyAction(state, action);
  assert.equal(r.ok, false, `expected ${action.type} to fail`);
  return (r as { error: string }).error;
}

function lobby(names: string[], config: Partial<GameConfig> = {}): GameState {
  const r = createGame({ id: "g1", hostId: "p0", hostName: names[0]!, config, seed: 42, now: 0 });
  assert.ok(r.ok);
  let s = r.state;
  names.slice(1).forEach((name, i) => (s = ok(s, { type: "join", playerId: `p${i + 1}`, name })));
  return s;
}

/** A started game with tanks placed exactly where the test wants them. */
function board(
  tanks: Array<Partial<Tank> & { x: number; y: number }>,
  config: Partial<GameConfig> = {},
): GameState {
  let s = lobby(tanks.map((_, i) => `T${i}`), { width: 10, height: 10, ...config });
  s = ok(s, { type: "start", playerId: "p0", now: 1000 });
  tanks.forEach((t, i) => Object.assign(s.tanks[`p${i}`]!, t));
  return s;
}

const tick = (s: GameState, now = 2000) => ok(s, { type: "tick", now });

// --- tests -----------------------------------------------------------------------------------

describe("lobby", () => {
  it("lets players join with unique names", () => {
    const s = lobby(["Ana", "Bia"]);
    assert.deepEqual(s.order, ["p0", "p1"]);
    assert.match(err(s, { type: "join", playerId: "p9", name: "ana" }), /taken/);
    assert.match(err(s, { type: "join", playerId: "p9", name: "   " }), /name/);
  });

  it("only lets the host start, with at least 2 players", () => {
    assert.match(err(lobby(["Solo"]), { type: "start", playerId: "p0", now: 0 }), /at least 2/);
    const s = lobby(["Ana", "Bia"]);
    assert.match(err(s, { type: "start", playerId: "p1", now: 0 }), /host/);
  });

  it("hands the host role on when the host leaves", () => {
    const s = ok(lobby(["Ana", "Bia", "Caio"]), { type: "leave", playerId: "p0" });
    assert.equal(s.hostId, "p1");
    assert.deepEqual(s.order, ["p1", "p2"]);
  });

  it("places every tank on its own square with starting stats", () => {
    const s = ok(lobby(["A", "B", "C", "D", "E", "F"]), { type: "start", playerId: "p0", now: 0 });
    assert.equal(s.phase, "playing");
    assert.ok(s.config.width >= 8);
    const squares = new Set(Object.values(s.tanks).map((t) => `${t.x},${t.y}`));
    assert.equal(squares.size, 6);
    for (const t of Object.values(s.tanks)) {
      assert.ok(t.x >= 0 && t.x < s.config.width && t.y >= 0 && t.y < s.config.height);
      assert.equal(t.hearts, 3);
      assert.equal(t.range, 2);
      assert.equal(t.ap, 0);
    }
  });

  it("is deterministic for the same seed", () => {
    const a = ok(lobby(["A", "B", "C"]), { type: "start", playerId: "p0", now: 0 });
    const b = ok(lobby(["A", "B", "C"]), { type: "start", playerId: "p0", now: 0 });
    assert.deepEqual(
      Object.values(a.tanks).map((t) => [t.x, t.y]),
      Object.values(b.tanks).map((t) => [t.x, t.y]),
    );
  });
});

describe("moving", () => {
  it("costs 1 AP per square, diagonals allowed", () => {
    const s = ok(board([{ x: 0, y: 0, ap: 2 }, { x: 9, y: 9 }]), { type: "move", playerId: "p0", dx: 1, dy: 1 });
    assert.deepEqual([s.tanks.p0!.x, s.tanks.p0!.y, s.tanks.p0!.ap], [1, 1, 1]);
  });

  it("can't leave the board, overlap a tank, jump, or go without AP", () => {
    const s = board([{ x: 0, y: 0, ap: 5 }, { x: 1, y: 0 }]);
    assert.match(err(s, { type: "move", playerId: "p0", dx: -1, dy: 0 }), /off the board/);
    assert.match(err(s, { type: "move", playerId: "p0", dx: 1, dy: 0 }), /occupied/);
    assert.match(err(s, { type: "move", playerId: "p0", dx: 0, dy: 2 }), /one square/);
    s.tanks.p0!.ap = 0;
    assert.match(err(s, { type: "move", playerId: "p0", dx: 0, dy: 1 }), /AP/);
  });

  it("picks up hearts lying on the board", () => {
    const s = board([{ x: 0, y: 0, ap: 1 }, { x: 9, y: 9 }]);
    s.pickups.push({ x: 0, y: 1 });
    const after = ok(s, { type: "move", playerId: "p0", dx: 0, dy: 1 });
    assert.equal(after.tanks.p0!.hearts, 4);
    assert.equal(after.pickups.length, 0);
  });
});

describe("shooting", () => {
  it("removes a heart from a tank in range", () => {
    const s = ok(board([{ x: 0, y: 0, ap: 1 }, { x: 2, y: 2 }]), { type: "shoot", playerId: "p0", targetId: "p1" });
    assert.equal(s.tanks.p1!.hearts, 2);
    assert.equal(s.tanks.p0!.ap, 0);
  });

  it("can't reach tanks outside range", () => {
    const s = board([{ x: 0, y: 0, ap: 1 }, { x: 3, y: 0 }]);
    assert.equal(distance(s.tanks.p0!, s.tanks.p1!), 3);
    assert.match(err(s, { type: "shoot", playerId: "p0", targetId: "p1" }), /out of range/);
  });

  it("destroys a tank at 0 hearts and the killer takes its AP", () => {
    const s = ok(board([{ x: 0, y: 0, ap: 1 }, { x: 1, y: 1, hearts: 1, ap: 4 }, { x: 9, y: 9 }]), {
      type: "shoot", playerId: "p0", targetId: "p1",
    });
    assert.equal(s.tanks.p1!.alive, false);
    assert.equal(s.tanks.p0!.ap, 4);
    assert.equal(s.phase, "playing");
    assert.match(err(s, { type: "shoot", playerId: "p0", targetId: "p1" }), /already destroyed/);
  });

  it("ends the game when one tank is left", () => {
    const s = ok(board([{ x: 0, y: 0, ap: 1 }, { x: 1, y: 1, hearts: 1 }]), { type: "shoot", playerId: "p0", targetId: "p1" });
    assert.equal(s.phase, "finished");
    assert.equal(s.winnerId, "p0");
    assert.equal(s.nextTickAt, null);
  });

  it("dead tanks can't act", () => {
    const s = board([{ x: 0, y: 0, ap: 3, alive: false }, { x: 1, y: 1 }, { x: 5, y: 5 }]);
    assert.match(err(s, { type: "move", playerId: "p0", dx: 1, dy: 0 }), /destroyed/);
  });
});

describe("giving", () => {
  it("transfers 1 AP to a living tank in range", () => {
    const s = ok(board([{ x: 0, y: 0, ap: 2 }, { x: 2, y: 0 }]), { type: "giveAP", playerId: "p0", targetId: "p1" });
    assert.deepEqual([s.tanks.p0!.ap, s.tanks.p1!.ap], [1, 1]);
  });

  it("gives hearts but never your last one", () => {
    const s = ok(board([{ x: 0, y: 0 }, { x: 1, y: 0 }]), { type: "giveHeart", playerId: "p0", targetId: "p1" });
    assert.deepEqual([s.tanks.p0!.hearts, s.tanks.p1!.hearts], [2, 4]);
    const poor = board([{ x: 0, y: 0, hearts: 1 }, { x: 1, y: 0 }]);
    assert.match(err(poor, { type: "giveHeart", playerId: "p0", targetId: "p1" }), /at least 2/);
  });

  it("revives a dead tank with a heart", () => {
    const s = ok(board([{ x: 0, y: 0 }, { x: 1, y: 0, alive: false, hearts: 0 }, { x: 9, y: 9 }]), {
      type: "giveHeart", playerId: "p0", targetId: "p1",
    });
    assert.equal(s.tanks.p1!.alive, true);
    assert.equal(s.tanks.p1!.hearts, 1);
  });

  it("respects config switches", () => {
    const s = board([{ x: 0, y: 0 }, { x: 1, y: 0, alive: false, hearts: 0 }, { x: 9, y: 9 }], { heartRevives: false });
    assert.match(err(s, { type: "giveHeart", playerId: "p0", targetId: "p1" }), /destroyed/);
    const s2 = board([{ x: 0, y: 0 }, { x: 1, y: 0 }], { allowGiveHeart: false });
    assert.match(err(s2, { type: "giveHeart", playerId: "p0", targetId: "p1" }), /disabled/);
  });
});

describe("range upgrades", () => {
  it("cost 3 AP by default", () => {
    const s = board([{ x: 0, y: 0, ap: 3 }, { x: 9, y: 9 }]);
    const up = ok(s, { type: "upgradeRange", playerId: "p0" });
    assert.deepEqual([up.tanks.p0!.range, up.tanks.p0!.ap], [3, 0]);
    s.tanks.p0!.ap = 2;
    assert.match(err(s, { type: "upgradeRange", playerId: "p0" }), /3 AP/);
  });
});

describe("ticks and the jury", () => {
  it("gives every living tank AP and schedules the next tick", () => {
    const s = tick(board([{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 9, y: 9, alive: false }]), 1000 + 86_400_000);
    assert.equal(s.tick, 1);
    assert.deepEqual(Object.values(s.tanks).map((t) => t.ap), [1, 1, 0]);
    assert.equal(s.nextTickAt, 1000 + 2 * 86_400_000);
  });

  it("catches up instead of scheduling ticks in the past", () => {
    const s = tick(board([{ x: 0, y: 0 }, { x: 5, y: 5 }]), 10 * 86_400_000);
    assert.equal(s.nextTickAt, 11 * 86_400_000);
  });

  it("restarts the clock when a tick is forced early", () => {
    const s = tick(board([{ x: 0, y: 0 }, { x: 5, y: 5 }]), 5000);
    assert.equal(s.nextTickAt, 5000 + 86_400_000);
  });

  it("only dead tanks vote, and only for living tanks", () => {
    const s = board([{ x: 0, y: 0 }, { x: 5, y: 5, alive: false }, { x: 9, y: 9, alive: false }]);
    assert.match(err(s, { type: "juryVote", playerId: "p0", targetId: "p1" }), /Only dead/);
    assert.match(err(s, { type: "juryVote", playerId: "p1", targetId: "p2" }), /living/);
    const voted = ok(s, { type: "juryVote", playerId: "p1", targetId: "p0" });
    assert.deepEqual(juryTally(voted), { p0: 1 });
  });

  it("awards a bonus AP once enough votes land on one tank", () => {
    let s = board(
      [{ x: 0, y: 0 }, { x: 2, y: 2 }, { x: 4, y: 4, alive: false }, { x: 6, y: 6, alive: false }, { x: 8, y: 8, alive: false }],
    );
    for (const voter of ["p2", "p3", "p4"]) s = ok(s, { type: "juryVote", playerId: voter, targetId: "p1" });
    s = tick(s);
    assert.equal(s.tanks.p1!.ap, 2); // 1 from the tick + 1 from the jury
    assert.equal(s.tanks.p0!.ap, 1);
    assert.deepEqual(s.juryVotes, {});
  });

  it("spawns heart pickups on empty squares when enabled", () => {
    const s = tick(board([{ x: 0, y: 0 }, { x: 5, y: 5 }], { heartsSpawnedPerTick: 2 }));
    assert.equal(s.pickups.length, 2);
    for (const p of s.pickups) assert.ok(!livingTanks(s).some((t) => t.x === p.x && t.y === p.y));
  });
});

describe("purity", () => {
  it("never mutates the input state", () => {
    const s = board([{ x: 0, y: 0, ap: 1 }, { x: 1, y: 1 }]);
    const snapshot = structuredClone(s);
    applyAction(s, { type: "shoot", playerId: "p0", targetId: "p1" });
    applyAction(s, { type: "tick", now: 5000 });
    assert.deepEqual(s, snapshot);
  });
});
