// Rule-based bot players for solo playtesting. A bot is an ordinary player in the game state; the
// store asks chooseBotAction what it wants to do every few seconds and applies it like any other
// action, so bots can never do anything a human couldn't.

import { canApply, distance, livingTanks } from "../../shared/src/rules.ts";
import type { GameState, PlayerAction, Position, Tank } from "../../shared/src/types.ts";
import type { BotPersonality } from "../../shared/src/view.ts";

export const BOT_NAMES: Record<BotPersonality, string[]> = {
  hunter: ["Rex", "Fang", "Blitz", "Viper", "Havoc"],
  turtle: ["Shelly", "Bunker", "Moss", "Pebble", "Atlas"],
  wildcard: ["Dice", "Jinx", "Loki", "Pinball", "Gizmo"],
};

export const BOT_DESCRIPTIONS: Record<BotPersonality, string> = {
  hunter: "Hunter: closes in and shoots the weakest tank it can reach",
  turtle: "Turtle: saves AP, upgrades range, heals, defends, parries or backs off, and only goes for easy kills",
  wildcard: "Wildcard: does something random — including gifts",
};

const DIRS: [number, number][] = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];

/** A free name for a new bot of this personality. */
export function botName(state: GameState, personality: BotPersonality): string {
  const taken = new Set(Object.values(state.tanks).map((t) => t.name.toLowerCase()));
  const names = BOT_NAMES[personality];
  for (let round = 1; ; round++) {
    for (const base of names) {
      const name = round === 1 ? base : `${base} ${round}`;
      if (!taken.has(name.toLowerCase())) return name;
    }
  }
}

/** What the bot wants to do right now, or null to wait. Always returns a legal action. */
export function chooseBotAction(
  s: GameState,
  botId: string,
  personality: BotPersonality,
  random: () => number = Math.random,
): PlayerAction | null {
  if (s.phase !== "playing") return null;
  const me = s.tanks[botId];
  if (!me) return null;
  const legal = (a: PlayerAction | null) => (a && canApply(s, a) ? a : null);
  if (!me.alive) return legal(juryVote(s, me));

  const enemies = livingTanks(s).filter((t) => t.id !== me.id);
  if (!enemies.length || me.ap < 1) return null;
  const inReach = enemies.filter((t) => distance(me, t) <= me.range);
  // Shots go at the square the target is on now.
  const shoot = (t: Tank): PlayerAction => ({ type: "shoot", playerId: me.id, x: t.x, y: t.y });
  const pickup = stepOntoPickup(s, me);

  if (personality === "hunter") {
    // A tank that is visibly defending or parrying would just eat the shot, so pick someone else.
    const open = inReach.filter((t) => !t.guard);
    if (open.length) return legal(shoot(weakest(open)));
    if (inReach.length) return null; // only guarded tanks in reach: wait it out
    if (pickup) return pickup;
    // Close in, but keep 1 AP for the shot once we get there.
    if (me.ap >= 2) return stepToward(s, me, nearest(me, enemies));
    return null;
  }

  if (personality === "turtle") {
    const open = inReach.filter((t) => !t.guard);
    const killable = open.filter((t) => t.hearts === 1);
    if (killable.length) return legal(shoot(weakest(killable)));
    const threats = enemies.filter((t) => distance(t, me) <= t.range);
    if (threats.length && open.length && me.ap >= 2) return legal(shoot(weakest(open)));
    if (threats.length) {
      // Under fire: usually brace for it — a parry when it can afford one, else a defense — otherwise back off.
      const roll = random();
      if (!me.guard && roll >= 0.4) {
        const guard = legal({ type: roll >= 0.7 ? "parry" : "defend", playerId: me.id }) ?? legal({ type: "defend", playerId: me.id });
        if (guard) return guard;
      }
      const away = stepAway(s, me, threats);
      if (away) return away;
    }
    if (me.hearts < s.config.startingHearts) {
      const heal = legal({ type: "heal", playerId: me.id });
      if (heal) return heal;
    }
    if (pickup) return pickup;
    if (me.ap >= s.config.upgradeRangeCost + 1) return legal({ type: "upgradeRange", playerId: me.id });
    return null;
  }

  // Wildcard: often hesitates, otherwise picks any legal action at random.
  if (random() < 0.4) return null;
  const options = allActions(s, me).filter((a) => canApply(s, a));
  return options.length ? options[Math.floor(random() * options.length)]! : null;
}

// ---------------------------------------------------------------------------------------------

/** Dead bots back the underdog: the living tank with the fewest hearts. */
function juryVote(s: GameState, me: Tank): PlayerAction | null {
  const target = weakestOrNull(livingTanks(s));
  if (!target || s.juryVotes[me.id] === target.id) return null;
  return { type: "juryVote", playerId: me.id, targetId: target.id };
}

function weakestOrNull(tanks: Tank[]): Tank | null {
  return [...tanks].sort((a, b) => a.hearts - b.hearts || b.ap - a.ap)[0] ?? null;
}

function weakest(tanks: Tank[]): Tank {
  return weakestOrNull(tanks)!;
}

function nearest(me: Tank, tanks: Tank[]): Tank {
  return [...tanks].sort((a, b) => distance(me, a) - distance(me, b))[0]!;
}

function moves(s: GameState, me: Tank): (PlayerAction & { type: "move" })[] {
  return DIRS.map(([dx, dy]) => ({ type: "move" as const, playerId: me.id, dx, dy })).filter((a) => canApply(s, a));
}

function stepOntoPickup(s: GameState, me: Tank): PlayerAction | null {
  return moves(s, me).find((m) => s.pickups.some((p) => p.x === me.x + m.dx && p.y === me.y + m.dy)) ?? null;
}

function stepToward(s: GameState, me: Tank, target: Position): PlayerAction | null {
  let best: PlayerAction | null = null;
  let bestDist = distance(me, target);
  for (const m of moves(s, me)) {
    const d = distance({ x: me.x + m.dx, y: me.y + m.dy }, target);
    if (d < bestDist) [best, bestDist] = [m, d];
  }
  return best;
}

function stepAway(s: GameState, me: Tank, threats: Tank[]): PlayerAction | null {
  const closest = (p: Position) => Math.min(...threats.map((t) => distance(p, t)));
  let best: PlayerAction | null = null;
  let bestDist = closest(me);
  for (const m of moves(s, me)) {
    const d = closest({ x: me.x + m.dx, y: me.y + m.dy });
    if (d > bestDist) [best, bestDist] = [m, d];
  }
  return best;
}

function allActions(s: GameState, me: Tank): PlayerAction[] {
  const actions: PlayerAction[] = [
    ...moves(s, me),
    { type: "upgradeRange", playerId: me.id },
    { type: "defend", playerId: me.id },
    { type: "parry", playerId: me.id },
    { type: "heal", playerId: me.id },
  ];
  // Wildcards fire at random squares in range — sometimes at a tank, mostly at nothing.
  for (let y = me.y - me.range; y <= me.y + me.range; y++) {
    for (let x = me.x - me.range; x <= me.x + me.range; x++) actions.push({ type: "shoot", playerId: me.id, x, y });
  }
  for (const t of Object.values(s.tanks)) {
    if (t.id === me.id) continue;
    actions.push(
      { type: "giveAP", playerId: me.id, targetId: t.id },
      { type: "giveHeart", playerId: me.id, targetId: t.id },
    );
  }
  return actions;
}
