import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { botName, chooseBotAction } from "../src/bots.ts";
import { applyAction, canApply, createGame } from "../../shared/src/rules.ts";
import type { GameState, Tank } from "../../shared/src/types.ts";

/** A started game with tanks a, b, c at the given squares and stats. */
function game(tanks: Record<string, Partial<Tank>>): GameState {
  const ids = Object.keys(tanks);
  let r = createGame({ id: "T", hostId: ids[0]!, hostName: ids[0]!, seed: 1, now: 0, config: { width: 10, height: 10 } });
  for (const id of ids.slice(1)) r = applyAction((r as { state: GameState }).state, { type: "join", playerId: id, name: id });
  r = applyAction((r as { state: GameState }).state, { type: "start", playerId: ids[0]!, now: 0 });
  assert.ok(r.ok);
  const s = r.state;
  for (const [id, overrides] of Object.entries(tanks)) Object.assign(s.tanks[id]!, overrides);
  return s;
}

describe("bots", () => {
  it("hunters shoot the weakest tank in range", () => {
    const s = game({
      bot: { x: 5, y: 5, ap: 1, range: 2 },
      strong: { x: 6, y: 5, hearts: 3 },
      weak: { x: 4, y: 4, hearts: 1 },
    });
    assert.deepEqual(chooseBotAction(s, "bot", "hunter"), { type: "shoot", playerId: "bot", targetId: "weak" });
  });

  it("hunters close in but keep 1 AP for the shot", () => {
    const s = game({ bot: { x: 0, y: 0, ap: 1 }, far: { x: 9, y: 9 } });
    assert.equal(chooseBotAction(s, "bot", "hunter"), null);
    s.tanks.bot!.ap = 2;
    assert.deepEqual(chooseBotAction(s, "bot", "hunter"), { type: "move", playerId: "bot", dx: 1, dy: 1 });
  });

  it("turtles back away from threats they can't hit and upgrade when safe", () => {
    const s = game({ bot: { x: 5, y: 5, ap: 1, range: 1 }, threat: { x: 7, y: 5, range: 2 } });
    const away = chooseBotAction(s, "bot", "turtle");
    assert.equal(away?.type, "move");
    assert.equal((away as { dx: number }).dx, -1);
    s.tanks.threat!.x = 9;
    s.tanks.threat!.y = 9;
    s.tanks.bot!.ap = 4;
    assert.deepEqual(chooseBotAction(s, "bot", "turtle"), { type: "upgradeRange", playerId: "bot" });
  });

  it("turtles always take a kill", () => {
    const s = game({ bot: { x: 5, y: 5, ap: 1 }, prey: { x: 6, y: 6, hearts: 1 } });
    assert.deepEqual(chooseBotAction(s, "bot", "turtle"), { type: "shoot", playerId: "bot", targetId: "prey" });
  });

  it("dead bots vote for the underdog on the jury", () => {
    const s = game({ bot: { alive: false, hearts: 0 }, a: { hearts: 3 }, b: { hearts: 1 } });
    assert.deepEqual(chooseBotAction(s, "bot", "hunter"), { type: "juryVote", playerId: "bot", targetId: "b" });
  });

  it("only ever picks legal actions, whatever the personality", () => {
    const s = game({ bot: { x: 0, y: 0, ap: 3 }, a: { x: 1, y: 1 }, b: { x: 9, y: 9 } });
    let seed = 0;
    const random = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
    for (let i = 0; i < 50; i++) {
      for (const p of ["hunter", "turtle", "wildcard"] as const) {
        const action = chooseBotAction(s, "bot", p, random);
        if (action) assert.ok(canApply(s, action), `${p} chose an illegal ${action.type}`);
      }
    }
  });

  it("picks names that aren't taken", () => {
    const s = game({ Rex: {}, Fang: {} });
    assert.equal(botName(s, "hunter"), "Blitz");
  });
});
