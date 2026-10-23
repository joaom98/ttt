import type { GameConfig } from "./types.ts";

const SECOND = 1000;
const HOUR = 60 * 60 * SECOND;

/** Rules as close to the original Halfbrick prototype as we know them. */
export const DEFAULT_CONFIG: GameConfig = {
  width: 0,
  height: 0,
  startingHearts: 3,
  startingRange: 2,
  startingAP: 0,
  apPerTick: 1,
  upgradeRangeCost: 3,
  tickIntervalMs: 24 * HOUR,
  juryVotesNeeded: 3,
  heartsSpawnedPerTick: 0,
  allowGiveHeart: true,
  heartRevives: true,
  killerTakesAP: true,
  debug: false,
};

/** Named starting points shown in the "create game" screen. Tweak freely while iterating. */
export const PRESETS: Record<string, { label: string; config: Partial<GameConfig> }> = {
  classic: { label: "Classic — 1 AP every 24h", config: {} },
  evening: { label: "Evening — 1 AP every 10 min", config: { tickIntervalMs: 10 * 60 * SECOND } },
  quick: {
    label: "Quick — 1 AP every 30s (debug on)",
    config: { tickIntervalMs: 30 * SECOND, startingAP: 1, debug: true },
  },
};

export const TANK_COLORS = [
  "#e6194b", "#3cb44b", "#ffe119", "#4363d8", "#f58231", "#911eb4",
  "#46f0f0", "#f032e6", "#bcf60c", "#fabebe", "#008080", "#e6beff",
  "#9a6324", "#fffac8", "#800000", "#aaffc3", "#808000", "#ffd8b1",
];

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 24;
export const MAX_NAME_LENGTH = 20;

/** Board side used when width/height are 0: roughly 16 squares of space per tank, at least 8x8. */
export function autoBoardSide(playerCount: number): number {
  return Math.max(8, Math.ceil(Math.sqrt(playerCount * 16)));
}

/** Merge user overrides onto the defaults, clamping anything numeric to sane bounds. */
export function makeConfig(overrides: Partial<GameConfig> = {}): GameConfig {
  const c: GameConfig = { ...DEFAULT_CONFIG };
  for (const key of Object.keys(DEFAULT_CONFIG) as (keyof GameConfig)[]) {
    const v = overrides[key];
    if (v === undefined || typeof v !== typeof DEFAULT_CONFIG[key]) continue;
    (c as unknown as Record<string, unknown>)[key] = v;
  }
  const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.floor(n)));
  c.width = c.width === 0 ? 0 : clamp(c.width, 5, 60);
  c.height = c.height === 0 ? 0 : clamp(c.height, 5, 60);
  c.startingHearts = clamp(c.startingHearts, 1, 20);
  c.startingRange = clamp(c.startingRange, 1, 20);
  c.startingAP = clamp(c.startingAP, 0, 100);
  c.apPerTick = clamp(c.apPerTick, 0, 100);
  c.upgradeRangeCost = clamp(c.upgradeRangeCost, 0, 100);
  c.tickIntervalMs = clamp(c.tickIntervalMs, 5 * SECOND, 7 * 24 * HOUR);
  c.juryVotesNeeded = clamp(c.juryVotesNeeded, 1, 100);
  c.heartsSpawnedPerTick = clamp(c.heartsSpawnedPerTick, 0, 20);
  return c;
}
