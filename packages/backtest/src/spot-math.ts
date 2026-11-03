import { Decimal } from 'decimal.js';
import { DecimalStringSchema, utcNanoseconds } from '@crypto/contracts';
import type { UtcTimestamp } from '@crypto/contracts';
import { fromEpoch } from '@crypto/core';
export const D = Decimal.clone({ precision: 256, rounding: Decimal.ROUND_HALF_EVEN });
export const amount = (v: Decimal.Value) => DecimalStringSchema.parse(new D(v).toFixed());
export const grid = (v: Decimal.Value, step: Decimal.Value, up = false) =>
  amount(
    new D(v)
      .div(step)
      .toDecimalPlaces(0, up ? Decimal.ROUND_CEIL : Decimal.ROUND_FLOOR)
      .mul(step),
  );
export const plusMs = (at: UtcTimestamp, ms: number) =>
  fromEpoch(utcNanoseconds(at) + BigInt(ms) * 1000000n, 'nanoseconds');
