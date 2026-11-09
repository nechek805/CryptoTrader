import { BTC_PLAN_V3, BtcThreeComparisonSchema } from '@crypto/contracts';
import { canonicalHash } from '@crypto/core';
import { D, amount } from './spot-math.js';
import { validateBtcHistory } from './btc-test.js';
import { runBtcThirdRevision, BTC_V3_ENGINE_HASH } from './btc-test-v3.js';
import { compareBtcStrategies, diagnoseBtcTrades } from './btc-comparison.js';

/** The v3 candidate is fixed before this replay; do not search on these observed windows. */
export function compareThreeBtcStrategies(input: unknown) {
  const data = validateBtcHistory(input),
    previous = compareBtcStrategies(data),
    third = runBtcThirdRevision(data),
    compat = runBtcThirdRevision(data, 'FILTERED');
  for (const key of ['decisions', 'trades', 'summary', 'journalHash'] as const)
    if (canonicalHash(compat.report[key]) !== canonicalHash(previous.revised.report[key]))
      throw new Error('V2 strategy compatibility mismatch');
  const arm = (r: typeof third, from = 0, to = data.bars.length) => ({
    reportId: r.id,
    summary: r.report.summary,
    exposureFraction: amount(
      new D(r.report.decisions.slice(from, to).filter((d) => new D(d.btc).gt(0)).length)
        .div(to - from)
        .toDecimalPlaces(12),
    ),
    profitFactor: diagnoseBtcTrades(r.report).profitFactor,
  });
  const windowRuns = previous.comparison.windows.map((w) => ({
    window: w,
    result: runBtcThirdRevision(data, 'QUALITY', { fromIndex: w.fromIndex, toIndex: w.toIndex }),
  }));
  const taken = new Set(third.report.trades.filter((t) => t.side === 'BUY').map((t) => t.index)),
    previousTaken = new Set(
      previous.revised.report.trades.filter((t) => t.side === 'BUY').map((t) => t.index),
    ),
    skippedV2Trades = [];
  let entry: (typeof previous.revised.report.trades)[number] | null = null;
  for (const exit of previous.revised.report.trades) {
    if (exit.side === 'BUY') {
      entry = exit;
      continue;
    }
    if (!entry) throw new Error('Missing v2 entry');
    if (!taken.has(entry.index))
      skippedV2Trades.push({
        entryIndex: entry.index,
        entryAt: new Date(entry.at).toISOString(),
        net: amount(
          new D(exit.quantity)
            .mul(exit.price)
            .minus(exit.fee)
            .minus(new D(entry.quantity).mul(entry.price))
            .minus(entry.fee),
        ),
        reason: third.report.decisions[entry.index - 1]!.reason,
      });
    entry = null;
  }
  const doubled = (r: typeof third) =>
    amount(
      new D(r.report.summary.netPnl).minus(r.report.summary.fees).minus(r.report.summary.slippage),
    );
  const comparison = BtcThreeComparisonSchema.parse({
    ...previous.comparison,
    version: 'btc-comparison.v2',
    engineHash: BTC_V3_ENGINE_HASH,
    third: arm(third),
    v2Attribution: diagnoseBtcTrades(previous.revised.report),
    candidateTrials: 2,
    strategyCount: 3,
    newCandidateTrials: 1,
    planHash: canonicalHash(BTC_PLAN_V3),
    previousComparisonId: previous.id,
    v2Reproduced: true,
    doubleCostSameFills: {
      original: doubled(previous.original),
      revised: doubled(previous.revised),
      third: doubled(third),
    },
    skippedV2Trades,
    additionalV3Entries: third.report.trades.filter(
      (t) => t.side === 'BUY' && !previousTaken.has(t.index),
    ).length,
    windows: windowRuns.map(({ window: w, result }) => ({
      ...w,
      third: arm(result, w.fromIndex, w.toIndex),
    })),
  });
  return {
    id: canonicalHash(comparison),
    comparison,
    original: previous.original,
    revised: previous.revised,
    third,
    evidence: [...previous.evidence, ...windowRuns.map((r) => r.result)],
    previous,
  };
}
