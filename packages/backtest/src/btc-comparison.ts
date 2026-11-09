import {
  BTC_PLAN_V2,
  BtcAttributionSchema,
  BtcComparisonSchema,
  BtcReportSchema,
} from '@crypto/contracts';
import type { BtcReport } from '@crypto/contracts';
import { canonicalHash } from '@crypto/core';
import { D, amount } from './spot-math.js';
import { runBtcTest, validateBtcHistory, HOUR } from './btc-test.js';
import { runBtcRevision, BTC_V2_ENGINE_HASH } from './btc-test-v2.js';

export function diagnoseBtcTrades(input: unknown) {
  const report = BtcReportSchema.parse(input),
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

/** One predeclared candidate. No search, fitting or selection on the temporal-check result. */
export function compareBtcStrategies(input: unknown) {
  const data = validateBtcHistory(input),
    original = runBtcTest(data),
    compat = runBtcRevision(data, 'ORIGINAL');
  if (data.bars.length < 400) throw new Error('Comparison requires at least 400 hourly candles');
  const semantic = (r: BtcReport) =>
    canonicalHash({
      decisions: r.decisions,
      trades: r.trades,
      summary: r.summary,
      journalHash: r.journalHash,
    });
  if (semantic(original.report) !== semantic(compat.report))
    throw new Error('Original strategy compatibility mismatch');
  const revised = runBtcRevision(data),
    split = Math.floor((data.bars.length * 2) / 3);
  const arm = (result: typeof original, from = 0, to = data.bars.length) => ({
    reportId: result.id,
    summary: result.report.summary,
    exposureFraction: amount(
      new D(result.report.decisions.slice(from, to).filter((d) => new D(d.btc).gt(0)).length)
        .div(to - from)
        .toDecimalPlaces(12),
    ),
    profitFactor: diagnoseBtcTrades(result.report).profitFactor,
  });
  const windowRuns = [
    { label: 'DEVELOPMENT' as const, fromIndex: 0, toIndex: split },
    { label: 'TEMPORAL_CHECK' as const, fromIndex: split, toIndex: data.bars.length },
  ].map((w) => {
    const bounds = { fromIndex: w.fromIndex, toIndex: w.toIndex };
    return {
      window: w,
      original: runBtcRevision(data, 'ORIGINAL', bounds),
      revised: runBtcRevision(data, 'FILTERED', bounds),
    };
  });
  const comparison = BtcComparisonSchema.parse({
    version: 'btc-comparison.v1',
    datasetId: canonicalHash(data),
    engineHash: BTC_V2_ENGINE_HASH,
    planHash: canonicalHash(BTC_PLAN_V2),
    candidateTrials: 1,
    interpretation: 'EXPLORATORY_REVISION_PREVIOUSLY_SEEN_HISTORY',
    originalReproduced: true,
    original: arm(original),
    revised: arm(revised),
    attribution: diagnoseBtcTrades(original.report),
    windows: windowRuns.map(({ window: w, original, revised }) => ({
      ...w,
      from: new Date(data.from + w.fromIndex * HOUR).toISOString(),
      to: new Date(data.from + w.toIndex * HOUR).toISOString(),
      original: arm(original, w.fromIndex, w.toIndex),
      revised: arm(revised, w.fromIndex, w.toIndex),
    })),
  });
  return {
    id: canonicalHash(comparison),
    comparison,
    original,
    revised,
    evidence: windowRuns.flatMap((r) => [r.original, r.revised]),
  };
}
