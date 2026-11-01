import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyAction, createGame, distance, juryTally, livingTanks, projectOrders } from "../src/rules.ts";
import type { Action, GameConfig, GameState, OrderAction, Tank } from "../src/types.ts";
import { publicCause, viewFor } from "../src/view.ts";

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
    const s = ok(board([{ x: 0, y: 0, ap: 1 }, { x: 2, y: 2 }]), { type: "shoot", playerId: "p0", x: 2, y: 2 });
    assert.equal(s.tanks.p1!.hearts, 2);
    assert.equal(s.tanks.p0!.ap, 0);
  });

  it("can't reach tanks outside range", () => {
    const s = board([{ x: 0, y: 0, ap: 1 }, { x: 3, y: 0 }]);
    assert.equal(distance(s.tanks.p0!, s.tanks.p1!), 3);
    assert.match(err(s, { type: "shoot", playerId: "p0", x: 3, y: 0 }), /out of range/);
  });

  it("destroys a tank at 0 hearts and the killer takes its AP", () => {
    const s = ok(board([{ x: 0, y: 0, ap: 1 }, { x: 1, y: 1, hearts: 1, ap: 4 }, { x: 9, y: 9 }]), {
      type: "shoot", playerId: "p0", x: 1, y: 1,
    });
    assert.equal(s.tanks.p1!.alive, false);
    assert.equal(s.tanks.p0!.ap, 4);
    assert.equal(s.phase, "playing");
    assert.match(ok(s, { type: "shoot", playerId: "p0", x: 1, y: 1 }).log.at(-1)!.text, /wreck/, "shooting a wreck just wastes the shot");
  });

  it("ends the game when one tank is left", () => {
    const s = ok(board([{ x: 0, y: 0, ap: 1 }, { x: 1, y: 1, hearts: 1 }]), { type: "shoot", playerId: "p0", x: 1, y: 1 });
    assert.equal(s.phase, "finished");
    assert.equal(s.winnerId, "p0");
    assert.equal(s.nextTickAt, null);
  });

  it("is aimed at a square: an empty one is a miss, your own is off limits", () => {
    const s = board([{ x: 0, y: 0, ap: 2 }, { x: 5, y: 5 }]);
    const missed = ok(s, { type: "shoot", playerId: "p0", x: 1, y: 1 });
    assert.equal(missed.tanks.p0!.ap, 1);
    assert.match(missed.log.at(-1)!.text, /B2 missed/);
    assert.match(err(s, { type: "shoot", playerId: "p0", x: 0, y: 0 }), /own square/);
    assert.match(err(s, { type: "shoot", playerId: "p0", x: -1, y: 0 }), /off the board/);
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

describe("rounds mode", () => {
  const rounds = (tanks: Array<Partial<Tank> & { x: number; y: number }>, config: Partial<GameConfig> = {}) =>
    board(tanks, { mode: "rounds", tickIntervalMs: 30_000, roundIntervalMs: 10_000, ...config });
  const order = (s: GameState, playerId: string, o: OrderAction) => ok(s, { type: "order", playerId, order: o });
  const endRound = (s: GameState, now = 2000) => ok(s, { type: "endRound", now });

  /** End the round (if it hasn't ended yet) and play every step out. */
  function playRound(s: GameState, now = 2000): GameState {
    if (!s.resolving) s = endRound(s, now);
    for (let i = 0; s.resolving && i < 100; i++) s = ok(s, { type: "resolveStep", now: now + i * 1000 });
    assert.equal(s.resolving, null, "the round should finish");
    return s;
  }

  it("turns direct actions into a planned order", () => {
    const s = rounds([{ x: 0, y: 0, ap: 3 }, { x: 1, y: 1 }]);
    assert.match(err(s, { type: "shoot", playerId: "p0", x: 1, y: 1 }), /Plan your orders/);
    const planned = order(s, "p0", { type: "shoot", playerId: "p0", x: 1, y: 1 });
    assert.equal(planned.tanks.p1!.hearts, 3, "nothing happens until the round ends");
    assert.deepEqual(planned.orders.p0, { type: "shoot", playerId: "p0", x: 1, y: 1 });
    assert.match(err(board([{ x: 0, y: 0 }, { x: 1, y: 1 }]), { type: "order", playerId: "p0", order: { type: "upgradeRange", playerId: "p0" } }), /real time/);
  });

  it("allows one order per round: a new one replaces the old, and can be cancelled", () => {
    let s = rounds([{ x: 0, y: 0, ap: 3 }, { x: 5, y: 5 }]);
    s = order(s, "p0", { type: "move", playerId: "p0", dx: 1, dy: 0 });
    s = order(s, "p0", { type: "upgradeRange", playerId: "p0" });
    assert.deepEqual(s.orders.p0, { type: "upgradeRange", playerId: "p0" });
    s = ok(s, { type: "cancelOrder", playerId: "p0" });
    assert.equal(s.orders.p0, undefined);
    assert.match(err(s, { type: "cancelOrder", playerId: "p0" }), /no order/);
  });

  it("checks the order against the board as it is now", () => {
    const s = rounds([{ x: 0, y: 0, ap: 2 }, { x: 3, y: 0 }]);
    assert.match(err(s, { type: "order", playerId: "p0", order: { type: "shoot", playerId: "p0", x: 3, y: 0 } }), /out of range/);
    assert.match(err(s, { type: "order", playerId: "p0", order: { type: "upgradeRange", playerId: "p0" } }), /3 AP/);
    const planned = order(s, "p0", { type: "move", playerId: "p0", dx: 1, dy: 0 });
    assert.deepEqual(projectOrders(planned, "p0").tanks.p0, { ...planned.tanks.p0!, x: 1, ap: 1 });
  });

  it("can't plan for someone else", () => {
    const s = order(rounds([{ x: 0, y: 0, ap: 1 }, { x: 5, y: 5, ap: 1 }]), "p0", { type: "move", playerId: "p1", dx: 1, dy: 0 });
    assert.equal(s.orders.p0!.playerId, "p0");
    assert.equal(s.orders.p1, undefined);
  });

  it("runs rounds on their own clock, separate from the AP ticks", () => {
    let s = rounds([{ x: 0, y: 0, ap: 1 }, { x: 5, y: 5, ap: 3 }]);
    assert.equal(s.nextRoundAt, 1000 + 10_000, "rounds are 10s");
    assert.equal(s.nextTickAt, 1000 + 30_000, "AP comes every 30s");
    s = order(s, "p0", { type: "move", playerId: "p0", dx: 1, dy: 0 });
    s = order(s, "p1", { type: "upgradeRange", playerId: "p1" });
    s = endRound(s, 11_000);
    assert.ok(s.resolving);
    assert.equal(s.round, 1);
    assert.equal(s.resolving.turnOrder.length, 2);
    assert.equal(s.nextRoundAt, null, "the round clock waits while the round plays out");
    assert.equal(s.nextTickAt, 31_000, "the AP clock doesn't");
    assert.deepEqual(s.orders, {});
    s = ok(s, { type: "resolveStep", now: 11_000 });
    assert.ok(s.resolving!.done, "the first order happened");
    assert.match(err(s, { type: "resolveStep", now: 11_100 }), /Not yet/, "steps are spaced out");
    s = playRound(s, 12_000);
    assert.equal(s.tanks.p0!.x, 1);
    assert.equal(s.tanks.p1!.range, 3);
    assert.equal(s.tick, 0, "no AP for finishing a round");
    assert.equal(s.tanks.p0!.ap, 0);
    assert.ok(s.nextRoundAt! > 12_000, "the next round's planning has started");
    s = tick(s, 31_000);
    assert.equal(s.tanks.p0!.ap, 1, "AP arrives on its own tick");
    assert.match(err(board([{ x: 0, y: 0 }, { x: 5, y: 5 }]), { type: "endRound", now: 0 }), /No round/);
  });

  it("plays players in a random order, which can decide who shoots first", () => {
    // Two tanks on 1 heart each, both planning to shoot the other: whoever goes first wins.
    const winners = new Set<string>();
    for (let seed = 0; seed < 20; seed++) {
      let s = rounds([{ x: 0, y: 0, ap: 1, hearts: 1 }, { x: 1, y: 0, ap: 1, hearts: 1 }, { x: 9, y: 9 }]);
      s.rng = seed;
      s = order(s, "p0", { type: "shoot", playerId: "p0", x: 1, y: 0 });
      s = order(s, "p1", { type: "shoot", playerId: "p1", x: 0, y: 0 });
      s = playRound(s);
      const alive = ["p0", "p1"].filter((id) => s.tanks[id]!.alive);
      assert.equal(alive.length, 1, "the second shooter was destroyed before acting");
      winners.add(alive[0]!);
    }
    assert.deepEqual([...winners].sort(), ["p0", "p1"]);
  });

  it("misses if the target has left the square by the time the shot fires", () => {
    // p0 aims at p1's square; p1 plans to drive off it. Who goes first decides it.
    const seen = new Set<string>();
    for (let seed = 0; seed < 20; seed++) {
      let s = rounds([{ x: 0, y: 0, ap: 1 }, { x: 2, y: 0, ap: 1 }, { x: 9, y: 9 }]);
      s.rng = seed;
      s = order(s, "p0", { type: "shoot", playerId: "p0", x: 2, y: 0 });
      s = order(s, "p1", { type: "move", playerId: "p1", dx: 1, dy: 0 });
      s = endRound(s);
      const first = s.resolving!.turnOrder[0]!;
      seen.add(first);
      s = playRound(s);
      if (first === "p1") {
        assert.equal(s.tanks.p1!.hearts, 3, "p1 got away");
        assert.equal(s.tanks.p0!.ap, 0, "a miss still costs the AP");
        assert.ok(s.log.some((e) => /missed/.test(e.text)));
      } else {
        assert.equal(s.tanks.p1!.hearts, 2, "hit before it could move");
        assert.equal(s.tanks.p1!.x, 3);
      }
    }
    assert.equal(seen.size, 2, "both turn orders came up");
  });

  it("starts the next round straight away when nobody planned anything", () => {
    const s = endRound(rounds([{ x: 0, y: 0 }, { x: 5, y: 5 }]), 11_000);
    assert.equal(s.resolving, null);
    assert.equal(s.round, 1);
    assert.equal(s.nextRoundAt, 21_000);
  });

  it("keeps everyone's orders secret from the others", () => {
    let s = rounds([{ x: 0, y: 0, ap: 1 }, { x: 1, y: 1, ap: 1 }]);
    s = order(s, "p0", { type: "shoot", playerId: "p0", x: 1, y: 1 });
    s = order(s, "p1", { type: "shoot", playerId: "p1", x: 0, y: 0 });
    assert.deepEqual(Object.keys(viewFor(s, "p0").orders), ["p0"]);
    const resolving = viewFor(endRound(s), "p0").resolving!;
    assert.equal(resolving.turnOrder.length, 2, "the turn order is public");
    assert.ok(resolving.queue.every((o) => o.playerId === "p0"));
    assert.equal(publicCause({ type: "order", playerId: "p0", order: { type: "upgradeRange", playerId: "p0" } }), null);
    assert.equal(publicCause({ type: "cancelOrder", playerId: "p0" }), null);
  });
});

describe("defense and parry", () => {
  /** p0 (3 AP) shoots at p1's square (1,1). */
  const shoot = (s: GameState) => ok(s, { type: "shoot", playerId: "p0", x: 1, y: 1 });
  /** p1 has raised a defense or readied a parry. */
  const guarded = (guard: "defend" | "parry", config: Partial<GameConfig> = {}) =>
    ok(board([{ x: 0, y: 0, ap: 3 }, { x: 1, y: 1, ap: 2 }, { x: 9, y: 9 }], config), { type: guard, playerId: "p1" });

  it("defense costs 1 AP and blocks every shot until the tick, nothing more", () => {
    let s = guarded("defend");
    assert.equal(s.tanks.p1!.ap, 1);
    assert.equal(s.tanks.p1!.guard, "defense");
    s = shoot(s);
    s = shoot(s);
    assert.equal(s.tanks.p1!.hearts, 3, "no damage");
    assert.equal(s.tanks.p0!.ap, 1, "just the two shots");
    assert.equal(s.tanks.p0!.stunned, false);
    assert.match(s.log.at(-1)!.text, /defense blocked/);
  });

  it("parry costs 2 AP, blocks the shot, takes 1 AP and stuns the shooter by default", () => {
    let s = guarded("parry");
    assert.equal(s.tanks.p1!.ap, 0);
    assert.equal(s.tanks.p1!.guard, "parry");
    s = shoot(s);
    assert.equal(s.tanks.p1!.hearts, 3, "no damage");
    assert.equal(s.tanks.p0!.ap, 3 - 1 - 1, "the shot plus the stolen AP");
    assert.equal(s.tanks.p1!.ap, 1);
    assert.equal(s.tanks.p0!.stunned, true);
    assert.equal(s.tanks.p0!.hearts, 3, "no counter-hit unless the rules ask for one");
    assert.match(err(s, { type: "upgradeRange", playerId: "p0" }), /stunned/);
    assert.match(s.log.at(-1)!.text, /parried/);
  });

  it("lets the rules tune the parry: AP taken, stun, and a counter-hit that can destroy the shooter", () => {
    const tuned = shoot(guarded("parry", { parrySteal: 2, parryStuns: false }));
    assert.equal(tuned.tanks.p0!.ap, 0);
    assert.equal(tuned.tanks.p0!.stunned, false);
    let s = guarded("parry", { parryDamage: 1 });
    s.tanks.p0!.hearts = 1;
    s = shoot(s);
    assert.equal(s.tanks.p0!.alive, false);
    assert.equal(s.tanks.p1!.ap, 0 + 1 + 1, "stolen AP, then the killer's loot");
  });

  it("can't stack guards or buy one without the AP, and they wear off at the tick", () => {
    let s = board([{ x: 0, y: 0, ap: 2 }, { x: 1, y: 1, ap: 1 }]);
    assert.match(err(s, { type: "parry", playerId: "p1" }), /2 AP/);
    s = ok(s, { type: "defend", playerId: "p0" });
    assert.match(err(s, { type: "parry", playerId: "p0" }), /already braced/);
    s = tick(s);
    assert.equal(s.tanks.p0!.guard, null);
    assert.equal(ok(s, { type: "shoot", playerId: "p1", x: 0, y: 0 }).tanks.p0!.hearts, 2, "a hit lands again after the tick");
  });

  it("in rounds mode goes up before anyone acts, whatever the turn order, and lasts the round", () => {
    for (let seed = 0; seed < 10; seed++) {
      let s = board([{ x: 0, y: 0, ap: 2 }, { x: 1, y: 1, ap: 1 }], { mode: "rounds" });
      s.rng = seed;
      s = ok(s, { type: "order", playerId: "p0", order: { type: "shoot", playerId: "p0", x: 1, y: 1 } });
      s = ok(s, { type: "order", playerId: "p1", order: { type: "defend", playerId: "p1" } });
      s = ok(s, { type: "endRound", now: 3000 });
      assert.equal(s.tanks.p1!.guard, "defense", "raised as the round begins");
      assert.deepEqual(s.resolving!.turnOrder, ["p0"], "a guard isn't a turn of its own");
      for (let i = 0; s.resolving && i < 10; i++) s = ok(s, { type: "resolveStep", now: 3000 + i * 1000 });
      assert.equal(s.tanks.p1!.hearts, 3);
      assert.equal(s.tanks.p1!.guard, null, "gone for the next round");
    }
  });

  it("in rounds mode a stunned shooter sits the next round out, then recovers", () => {
    let s = board([{ x: 0, y: 0, ap: 5 }, { x: 1, y: 1, ap: 2 }], { mode: "rounds" });
    const play = (state: GameState, now: number) => {
      state = ok(state, { type: "endRound", now });
      for (let i = 0; state.resolving && i < 10; i++) state = ok(state, { type: "resolveStep", now: now + i * 1000 });
      return state;
    };
    s = ok(s, { type: "order", playerId: "p0", order: { type: "shoot", playerId: "p0", x: 1, y: 1 } });
    s = ok(s, { type: "order", playerId: "p1", order: { type: "parry", playerId: "p1" } });
    s = play(s, 3000);
    assert.equal(s.tanks.p0!.stunned, true, "still stunned after the round it was parried in");
    assert.match(err(s, { type: "order", playerId: "p0", order: { type: "upgradeRange", playerId: "p0" } }), /stunned/);
    s = play(s, 20_000);
    assert.ok(s.log.some((e) => /sits round 2 out/.test(e.text)));
    assert.equal(s.tanks.p0!.stunned, false, "recovered once it had sat a round out");
    ok(s, { type: "order", playerId: "p0", order: { type: "upgradeRange", playerId: "p0" } });
  });
});

describe("healing", () => {
  it("repairs 1 heart for 3 AP, up to the starting hearts", () => {
    let s = board([{ x: 0, y: 0, ap: 7, hearts: 1 }, { x: 5, y: 5 }]);
    s = ok(s, { type: "heal", playerId: "p0" });
    assert.equal(s.tanks.p0!.hearts, 2);
    assert.equal(s.tanks.p0!.ap, 4);
    s = ok(s, { type: "heal", playerId: "p0" });
    assert.match(err(s, { type: "heal", playerId: "p0" }), /up to 3/);
    assert.match(err(board([{ x: 0, y: 0, ap: 2, hearts: 1 }, { x: 5, y: 5 }]), { type: "heal", playerId: "p0" }), /3 AP/);
  });

  it("follows the rules' cost and switch, and can be planned in rounds", () => {
    const cheap = board([{ x: 0, y: 0, ap: 1, hearts: 1 }, { x: 5, y: 5 }], { healCost: 1 });
    assert.equal(ok(cheap, { type: "heal", playerId: "p0" }).tanks.p0!.hearts, 2);
    const off = board([{ x: 0, y: 0, ap: 9, hearts: 1 }, { x: 5, y: 5 }], { allowHeal: false });
    assert.match(err(off, { type: "heal", playerId: "p0" }), /disabled/);
    const rounds = board([{ x: 0, y: 0, ap: 3, hearts: 1 }, { x: 5, y: 5 }], { mode: "rounds" });
    ok(rounds, { type: "order", playerId: "p0", order: { type: "heal", playerId: "p0" } });
  });
});

describe("kicking", () => {
  it("lets the host remove a player from the lobby", () => {
    const s = ok(lobby(["Ana", "Bia", "Caio"]), { type: "kick", playerId: "p0", targetId: "p1" });
    assert.deepEqual(s.order, ["p0", "p2"]);
    assert.equal(s.tanks.p1, undefined);
    assert.match(s.log.at(-1)!.text, /Bia was removed/);
  });

  it("is only for the host, not on themselves, and only in the lobby", () => {
    const s = lobby(["Ana", "Bia"]);
    assert.match(err(s, { type: "kick", playerId: "p1", targetId: "p0" }), /host/);
    assert.match(err(s, { type: "kick", playerId: "p0", targetId: "p0" }), /yourself/);
    assert.match(err(s, { type: "kick", playerId: "p0", targetId: "nobody" }), /isn't in/);
    const started = ok(s, { type: "start", playerId: "p0", now: 0 });
    assert.match(err(started, { type: "kick", playerId: "p0", targetId: "p1" }), /lobby/);
  });
});

describe("changing the rules in the lobby", () => {
  it("lets the host change some rules and keeps the rest", () => {
    const s = ok(lobby(["Ana", "Bia"]), { type: "configure", playerId: "p0", config: { mode: "rounds", startingHearts: 5 } });
    assert.equal(s.config.mode, "rounds");
    assert.equal(s.config.startingHearts, 5);
    assert.equal(s.config.startingRange, 2, "untouched rules stay");
    const started = ok(s, { type: "start", playerId: "p0", now: 0 });
    assert.ok(Object.values(started.tanks).every((t) => t.hearts === 5));
  });

  it("clamps silly values and ignores unknown or mistyped ones", () => {
    const s = ok(lobby(["Ana", "Bia"]), {
      type: "configure", playerId: "p0",
      config: { startingHearts: 999, width: 2, debug: "yes" as unknown as boolean, mode: "chaos" as "rounds", nonsense: 1 } as Partial<GameConfig>,
    });
    assert.equal(s.config.startingHearts, 20);
    assert.equal(s.config.width, 5);
    assert.equal(s.config.debug, false);
    assert.equal(s.config.mode, "realtime");
    assert.equal("nonsense" in s.config, false);
  });

  it("is only for the host, and only before the game starts", () => {
    const s = lobby(["Ana", "Bia"]);
    assert.match(err(s, { type: "configure", playerId: "p1", config: { startingHearts: 1 } }), /host/);
    const started = ok(s, { type: "start", playerId: "p0", now: 0 });
    assert.match(err(started, { type: "configure", playerId: "p0", config: { startingHearts: 1 } }), /lobby/);
  });
});

describe("rematch", () => {
  const finished = () => ok(board([{ x: 0, y: 0, ap: 3 }, { x: 1, y: 1, hearts: 1 }]), { type: "shoot", playerId: "p0", x: 1, y: 1 });

  it("puts everyone back in the lobby with fresh tanks, keeping players and rules", () => {
    const s = ok(finished(), { type: "rematch", playerId: "p0" });
    assert.equal(s.phase, "lobby");
    assert.equal(s.winnerId, null);
    assert.equal(s.tick, 0);
    assert.deepEqual(s.order, ["p0", "p1"]);
    assert.ok(Object.values(s.tanks).every((t) => t.alive && t.ap === 0 && t.x === -1));
    assert.equal(s.config.width, 10, "a board size chosen by hand is kept");
    const again = ok(s, { type: "start", playerId: "p0", now: 5000 });
    assert.equal(again.phase, "playing");
    assert.ok(Object.values(again.tanks).every((t) => t.hearts === 3 && t.x >= 0));
  });

  it("lets new players join before the rematch, and re-sizes an automatic board", () => {
    let s = ok(lobby(["Ana", "Bia"]), { type: "start", playerId: "p0", now: 0 });
    assert.equal(s.config.width, 8);
    s.tanks.p1!.hearts = 1;
    s.tanks.p0!.ap = 1;
    Object.assign(s.tanks.p1!, { x: s.tanks.p0!.x === 0 ? 1 : s.tanks.p0!.x - 1, y: s.tanks.p0!.y });
    s = ok(s, { type: "shoot", playerId: "p0", x: s.tanks.p1!.x, y: s.tanks.p1!.y });
    s = ok(s, { type: "rematch", playerId: "p0" });
    assert.equal(s.config.width, 0);
    for (let i = 2; i < 6; i++) s = ok(s, { type: "join", playerId: `p${i}`, name: `New${i}` });
    s = ok(s, { type: "start", playerId: "p0", now: 0 });
    assert.equal(s.config.width, 10, "sized for six tanks now");
  });

  it("is only for the host, once the game is over", () => {
    assert.match(err(finished(), { type: "rematch", playerId: "p1" }), /host/);
    assert.match(err(board([{ x: 0, y: 0 }, { x: 5, y: 5 }]), { type: "rematch", playerId: "p0" }), /isn't over/);
  });
});

describe("purity", () => {
  it("never mutates the input state", () => {
    const s = board([{ x: 0, y: 0, ap: 1 }, { x: 1, y: 1 }]);
    const snapshot = structuredClone(s);
    applyAction(s, { type: "shoot", playerId: "p0", x: 1, y: 1 });
    applyAction(s, { type: "tick", now: 5000 });
    assert.deepEqual(s, snapshot);
  });
});
