// Small seeded PRNG (mulberry32). The generator state lives in GameState.rng so the
// rules reducer stays a pure function: same state + same action => same result.

export function nextRandom(seed: number): [value: number, nextSeed: number] {
  const nextSeed = (seed + 0x6d2b79f5) | 0;
  let t = nextSeed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return [value, nextSeed];
}

/** Mutable helper for use inside a reducer step that already works on a cloned state. */
export class Rng {
  seed: number;
  constructor(seed: number) {
    this.seed = seed;
  }
  next(): number {
    const [v, s] = nextRandom(this.seed);
    this.seed = s;
    return v;
  }
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [items[i], items[j]] = [items[j] as T, items[i] as T];
    }
    return items;
  }
}
