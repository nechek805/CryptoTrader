import { SeedSchema } from '@crypto/contracts';

/** Versioned Mulberry32; reproducible research randomness, never for secrets or IDs. */
export class SeededRandom {
  readonly algorithm = 'mulberry32.v1';
  readonly seed: number;
  #state: number;
  constructor(seed: number) {
    this.seed = SeedSchema.parse(seed);
    this.#state = this.seed;
  }
  nextUint32(): number {
    let value = (this.#state = (this.#state + 0x6d2b79f5) >>> 0);
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return (value ^ (value >>> 14)) >>> 0;
  }
  next(): number {
    return this.nextUint32() / 0x100000000;
  }
  nextInt(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive < 1 || maxExclusive > 0x100000000) {
      throw new RangeError('Random integer bound must be 1–2^32');
    }
    const ceiling = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
    let value: number;
    do {
      value = this.nextUint32();
    } while (value >= ceiling);
    return value % maxExclusive;
  }
}
