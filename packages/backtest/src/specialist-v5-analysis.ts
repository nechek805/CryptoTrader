import {
  BtcAttributionSchema,
  SpecialistV5ReportSchema,
  SpecialistReportSchema,
  SpecialistV5TradeChangeSchema,
} from '@crypto/contracts';
import { D, amount } from './spot-math.js';
export function compareSpecialistV5Trades(before: unknown, after: unknown) {
  const a = SpecialistReportSchema.parse(before),
    b = SpecialistV5ReportSchema.parse(after);
  if (
    a.asset !== b.asset ||
    a.datasetId !== b.datasetId ||
    a.plan.feeMode !== 'STANDARD' ||
    b.plan.feeMode !== 'STANDARD' ||
    a.window.fromIndex !== b.window.fromIndex ||
    a.window.toIndex !== b.window.toIndex
  )
    throw new Error('Trade comparison requires the same asset, history, fees-on and window');
  const pairs = (r: typeof a | typeof b) => {
    let entry: (typeof r.trades)[number] | null = null;
    const result = new Map<number, { at: number; exit: number; net: string; reason: string }>();
    for (const fill of r.trades) {
      if (fill.side === 'BUY') {
        if (entry) throw new Error('Overlapping entries');
        entry = fill;
      } else {
        if (!entry || entry.quantity !== fill.quantity) throw new Error('Unmatched exit');
        result.set(entry.index, {
          at: entry.at,
          exit: fill.index,
          net: amount(
            new D(fill.quantity)
              .mul(fill.price)
              .minus(fill.fee)
              .minus(new D(entry.quantity).mul(entry.price))
              .minus(entry.fee),
          ),
          reason: fill.reason,
        });
        entry = null;
      }
    }
    return result;
  };
  const old = pairs(a),
    next = pairs(b);
  return [...new Set([...old.keys(), ...next.keys()])]
    .sort((x, y) => x - y)
    .map((entryIndex) => {
      const x = old.get(entryIndex),
        y = next.get(entryIndex);
      return SpecialistV5TradeChangeSchema.parse({
        entryIndex,
        entryAt: (x ?? y)!.at,
        v4Exit: x?.exit ?? null,
        v5Exit: y?.exit ?? null,
        v4Net: x?.net ?? null,
        v5Net: y?.net ?? null,
        delta: amount(new D(y?.net ?? 0).minus(x?.net ?? 0)),
        v4Reason: x?.reason ?? null,
        v5Reason: y?.reason ?? null,
      });
    });
}
export function diagnoseSpecialistV5Trades(input: unknown) {
  const report = SpecialistV5ReportSchema.parse(input),
    closed: {
      reason: string;
      holdingHours: number;
      net: string;
      fees: string;
      slippage: string;
    }[] = [];
  let entry: (typeof report.trades)[number] | null = null;
  for (const fill of report.trades) {
    if (fill.side === 'BUY') {
      if (entry) throw new Error('Overlapping spot entries');
      entry = fill;
      continue;
    }
    if (!entry || entry.quantity !== fill.quantity) throw new Error('Unmatched spot exit');
    const net = new D(fill.quantity)
      .mul(fill.price)
      .minus(fill.fee)
      .minus(new D(entry.quantity).mul(entry.price))
      .minus(entry.fee);
    closed.push({
      reason: fill.reason,
      holdingHours: fill.index - entry.index,
      net: amount(net),
      fees: amount(new D(entry.fee).plus(fill.fee)),
      slippage: amount(new D(entry.slippage).plus(fill.slippage)),
    });
    entry = null;
  }
  if (closed.length !== report.summary.closedTrades)
    throw new Error('Closed-trade reconciliation failed');
  const sum = (rows: typeof closed, key: 'net' | 'fees' | 'slippage') =>
    rows.reduce((v, t) => v.plus(t[key]), new D(0));
  const winners = closed.filter((t) => new D(t.net).gt(0)),
    losers = closed.filter((t) => new D(t.net).lte(0));
  const shortHolds = closed.filter((t) => t.holdingHours <= 12),
    closedNet = sum(closed, 'net');
  return BtcAttributionSchema.parse({
    closedNet: amount(closedNet),
    openContribution: amount(new D(report.summary.netPnl).minus(closedNet)),
    beforeFees: amount(new D(report.summary.netPnl).plus(report.summary.fees)),
    beforeFeesAndSlippage: amount(
      new D(report.summary.netPnl).plus(report.summary.fees).plus(report.summary.slippage),
    ),
    totalFriction: amount(new D(report.summary.fees).plus(report.summary.slippage)),
    averageWin: winners.length
      ? amount(sum(winners, 'net').div(winners.length).toDecimalPlaces(12))
      : null,
    averageLoss: losers.length
      ? amount(sum(losers, 'net').div(losers.length).toDecimalPlaces(12))
      : null,
    profitFactor: sum(losers, 'net').lt(0)
      ? amount(sum(winners, 'net').div(sum(losers, 'net').abs()).toDecimalPlaces(12))
      : null,
    shortHoldCount: shortHolds.length,
    shortHoldNet: amount(sum(shortHolds, 'net')),
    groups: [...new Set(closed.map((t) => t.reason))].map((reason) => {
      const rows = closed.filter((t) => t.reason === reason);
      return {
        reason,
        count: rows.length,
        wins: rows.filter((t) => new D(t.net).gt(0)).length,
        net: amount(sum(rows, 'net')),
        fees: amount(sum(rows, 'fees')),
        slippage: amount(sum(rows, 'slippage')),
        averageHours: amount(
          new D(rows.reduce((s, t) => s + t.holdingHours, 0)).div(rows.length).toDecimalPlaces(12),
        ),
      };
    }),
  });
}
