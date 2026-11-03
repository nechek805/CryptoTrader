import { TimeUnitSchema, UtcTimestampSchema, utcNanoseconds } from '@crypto/contracts';
import type { TimeUnit, UtcTimestamp } from '@crypto/contracts';

const nanosecondsPerUnit: Record<TimeUnit, bigint> = {
  seconds: 1_000_000_000n,
  milliseconds: 1_000_000n,
  microseconds: 1_000n,
  nanoseconds: 1n,
};

export function utc(value: string): UtcTimestamp {
  return UtcTimestampSchema.parse(value);
}

export function toEpoch(value: UtcTimestamp, unit: TimeUnit): bigint {
  const nanos = utcNanoseconds(value);
  const divisor = nanosecondsPerUnit[TimeUnitSchema.parse(unit)];
  if (nanos % divisor !== 0n) throw new RangeError('Conversion would lose timestamp precision');
  return nanos / divisor;
}

export function fromEpoch(value: bigint, unit: TimeUnit): UtcTimestamp {
  if (typeof value !== 'bigint' || value < 0n)
    throw new TypeError('Epoch must be a nonnegative bigint');
  const nanos = value * nanosecondsPerUnit[TimeUnitSchema.parse(unit)];
  const milliseconds = (nanos / 1_000_000_000n) * 1000n;
  if (milliseconds > 253402300799000n) throw new RangeError('Epoch exceeds year 9999');
  const seconds = new Date(Number(milliseconds)).toISOString().slice(0, 19);
  return utc(`${seconds}.${(nanos % 1_000_000_000n).toString().padStart(9, '0')}Z`);
}

export function compareTimes(left: UtcTimestamp, right: UtcTimestamp): -1 | 0 | 1 {
  const a = utc(left),
    b = utc(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface Clock {
  now(): UtcTimestamp;
}

/** Deterministic, manually advanced clock. No wall time or timers influence it. */
export class SyntheticClock implements Clock {
  #current: UtcTimestamp;
  constructor(initial: string) {
    this.#current = utc(initial);
  }
  now(): UtcTimestamp {
    return this.#current;
  }
  advanceTo(value: string): UtcTimestamp {
    const next = utc(value);
    if (compareTimes(next, this.#current) < 0) throw new RangeError('Clock cannot move backwards');
    this.#current = next;
    return this.#current;
  }
  advanceBy(value: bigint, unit: TimeUnit): UtcTimestamp {
    if (typeof value !== 'bigint' || value < 0n)
      throw new RangeError('Clock increment must be a nonnegative bigint');
    return this.advanceTo(
      fromEpoch(
        toEpoch(this.#current, 'nanoseconds') +
          value * nanosecondsPerUnit[TimeUnitSchema.parse(unit)],
        'nanoseconds',
      ),
    );
  }
}
export { SyntheticClock as MockClock };
