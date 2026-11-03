import { Decimal } from 'decimal.js';
import { DecimalStringSchema } from '@crypto/contracts';
import type { DecimalString } from '@crypto/contracts';

// Private context: external Decimal.set() cannot change financial calculations.
// Inputs have <=80 digits, so 256 significant digits preserves exact +, -, * results.
const ExactDecimal = Decimal.clone({ precision: 256, rounding: Decimal.ROUND_HALF_EVEN });
export function decimal(value: string): DecimalString {
  return DecimalStringSchema.parse(value);
}
const amount = (value: DecimalString) => new ExactDecimal(DecimalStringSchema.parse(value));
const output = (value: Decimal) => decimal(value.toFixed());

export function addDecimal(left: DecimalString, right: DecimalString): DecimalString {
  return output(amount(left).plus(amount(right)));
}
export function subtractDecimal(left: DecimalString, right: DecimalString): DecimalString {
  return output(amount(left).minus(amount(right)));
}
export function multiplyDecimal(left: DecimalString, right: DecimalString): DecimalString {
  return output(amount(left).mul(amount(right)));
}
export function equalDecimal(left: DecimalString, right: DecimalString): boolean {
  return amount(left).eq(amount(right));
}

/** Exact grid validation without rounding a price onto the declared tick. */
export function isDecimalMultipleOf(value: DecimalString, step: DecimalString): boolean {
  const divisor = amount(step);
  if (!divisor.gt(0)) throw new RangeError('Step must be positive');
  return amount(value).mod(divisor).isZero();
}

/** Division/quantization always requires an explicit scale and rounding policy. */
export type RoundingPolicy = 'DOWN' | 'UP' | 'HALF_EVEN';
const roundingModes: Record<RoundingPolicy, Decimal.Rounding> = {
  DOWN: Decimal.ROUND_DOWN,
  UP: Decimal.ROUND_UP,
  HALF_EVEN: Decimal.ROUND_HALF_EVEN,
};
export function divideDecimal(
  left: DecimalString,
  right: DecimalString,
  scale: number,
  rounding: RoundingPolicy,
): DecimalString {
  if (!Number.isInteger(scale) || scale < 0 || scale > 36)
    throw new RangeError('Scale must be 0–36');
  if (!Object.hasOwn(roundingModes, rounding))
    throw new RangeError('Explicit rounding policy required');
  const denominator = amount(right);
  if (denominator.isZero()) throw new RangeError('Division by zero');
  return output(amount(left).div(denominator).toDecimalPlaces(scale, roundingModes[rounding]));
}
