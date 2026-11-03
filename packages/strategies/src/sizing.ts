import { Decimal } from 'decimal.js';
import {
  MarketSizingQuerySchema,
  MarketSizingResultSchema,
  DecimalStringSchema,
} from '@crypto/contracts';
import { deepFreeze, isDecimalMultipleOf } from '@crypto/core';
const D = Decimal.clone({ precision: 256, rounding: Decimal.ROUND_HALF_EVEN });
/** Fixed absolute owned-asset target. Scores, prices, recent PnL and volatility never resize it. */
export function sizeMarketTarget(input: unknown) {
  const q = MarketSizingQuerySchema.parse(input);
  if (!isDecimalMultipleOf(q.fixedQuantity, q.quantityStep))
    throw new Error('Fixed quantity is off the known lot grid');
  const target = new D(q.target === 'LONG' ? q.fixedQuantity : 0),
    difference = target.minus(q.heldQuantity),
    quantity = DecimalStringSchema.parse(
      difference.abs().div(q.quantityStep).floor().mul(q.quantityStep).toFixed(),
    ),
    result = MarketSizingResultSchema.parse({
      policy: 'FIXED_TARGET_QUANTITY_NO_LEVERAGE_V1',
      side: new D(quantity).isZero() ? 'NONE' : difference.gt(0) ? 'BUY' : 'SELL',
      quantity,
      targetQuantity: target.toFixed(),
      heldQuantity: q.heldQuantity,
    });
  deepFreeze(result);
  return result;
}
