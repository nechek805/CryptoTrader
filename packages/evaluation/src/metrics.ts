import { Decimal } from 'decimal.js';
import {
  PerformanceInputSchema,
  PerformanceMetricsSchema,
  utcNanoseconds,
} from '@crypto/contracts';
import type { PerformanceMetrics, PerformanceInput } from '@crypto/contracts';
import { deepFreeze, fromEpoch } from '@crypto/core';

const D = Decimal.clone({ precision: 256, rounding: Decimal.ROUND_HALF_EVEN });
export const metricAmount = (v: Decimal.Value) => new D(v).toDecimalPlaces(36).toFixed();
const ratio = (a: Decimal.Value, b: Decimal.Value) =>
  new D(b).isZero() ? null : metricAmount(new D(a).div(b));
export const formatEvaluationMetric = (v: string | number | null) =>
  v === null ? 'N/A' : String(v);
const dayNs = 86400000000000n;

export function measurePerformance(input: unknown): PerformanceMetrics {
  const q = PerformanceInputSchema.parse(input),
    curve = q.curve,
    start = utcNanoseconds(q.startAt),
    end = utcNanoseconds(q.endAt);
  if (
    start > end ||
    curve[0]!.at !== q.startAt ||
    curve.at(-1)!.at !== q.endAt ||
    (curve[0]!.equity !== null && !new D(curve[0]!.equity).eq(q.initialEquity)) ||
    q.filledOrders > q.acceptedOrders ||
    q.observedOpportunities > q.declaredOpportunities
  )
    throw new Error('Invalid performance period, initial equity or opportunity counts');
  for (const [i, p] of curve.entries()) {
    if (
      (i > 0 && p.at <= curve[i - 1]!.at) ||
      p.at < q.startAt ||
      p.at > q.endAt ||
      (p.validUntil !== null && p.validUntil < p.at)
    )
      throw new Error('Invalid performance curve clocks');
  }
  if (
    new Set(q.trades.map((t) => t.id)).size !== q.trades.length ||
    new Set(q.fills.map((f) => f.id)).size !== q.fills.length
  )
    throw new Error('Duplicate performance trade/fill');
  for (const t of q.trades)
    if (t.openedAt < q.startAt || t.openedAt > t.closedAt || t.closedAt > q.endAt)
      throw new Error('Trade outside evaluation period');
  for (const f of q.fills)
    if (f.at < q.startAt || f.at > q.endAt) throw new Error('Fill outside evaluation period');
  const terminal = curve.at(-1)!.equity,
    initial = new D(q.initialEquity),
    pnl = terminal === null ? null : new D(terminal).minus(initial),
    fees = q.fills.reduce((s, f) => s.plus(f.fee), new D(0)),
    slippage = q.fills.reduce((s, f) => s.plus(f.slippageCost), new D(0)),
    turnover = q.fills.reduce((s, f) => s.plus(f.notional), new D(0)),
    wins = q.trades.filter((t) => new D(t.netPnl).gt(0)),
    losses = q.trades.filter((t) => new D(t.netPnl).lt(0)),
    winSum = wins.reduce((s, t) => s.plus(t.netPnl), new D(0)),
    lossSum = losses.reduce((s, t) => s.plus(t.netPnl), new D(0));
  let peak = initial,
    observedDD = new D(0),
    absoluteDD = new D(0),
    unknown = false,
    positioned = 0n,
    knownTime = 0n,
    weightedExposure = new D(0);
  const intervals: { left: bigint; right: bigint; knownUntil: bigint }[] = [];
  for (const [i, p] of curve.entries()) {
    if (p.equity === null) unknown = true;
    else {
      peak = D.max(peak, p.equity);
      absoluteDD = D.max(absoluteDD, peak.minus(p.equity));
      observedDD = D.max(observedDD, peak.minus(p.equity).div(peak));
    }
    const left = utcNanoseconds(p.at),
      right = i + 1 < curve.length ? utcNanoseconds(curve[i + 1]!.at) : end;
    if (right <= left) continue;
    if (p.positionOpen) positioned += right - left;
    const validTo =
      p.equity === null
        ? left
        : !p.positionOpen
          ? right
          : p.validUntil === null
            ? left
            : utcNanoseconds(p.validUntil) < right
              ? utcNanoseconds(p.validUntil)
              : right;
    intervals.push({ left, right, knownUntil: validTo });
    knownTime += validTo - left;
    if (validTo < right) unknown = true;
    if (p.exposureFraction !== null)
      weightedExposure = weightedExposure.plus(
        new D(p.exposureFraction).mul((validTo - left).toString()),
      );
    else if (p.positionOpen) unknown = true;
  }
  const atBoundary = (at: bigint) => {
    const p = curve.findLast((p) => utcNanoseconds(p.at) <= at);
    if (!p || p.equity === null) return null;
    if (p.positionOpen && (p.validUntil === null || utcNanoseconds(p.validUntil) < at)) return null;
    return p.equity;
  };
  const daily: PerformanceMetrics['daily'] = [];
  for (
    let day = utcNanoseconds(fromEpoch((start / dayNs) * 86400n, 'seconds'));
    day < end;
    day += dayNs
  ) {
    if (daily.length >= 3660) throw new Error('Evaluation calendar limit');
    const a = day < start ? start : day,
      b = day + dayNs > end ? end : day + dayNs,
      first = atBoundary(a),
      last = atBoundary(b),
      complete = intervals.every(
        (i) => i.right <= a || i.left >= b || i.knownUntil >= (i.right < b ? i.right : b),
      ),
      net = first === null || last === null ? null : new D(last).minus(first);
    daily.push({
      day: fromEpoch(day, 'nanoseconds').slice(0, 10),
      startEquity: first,
      endEquity: last,
      netPnl: net === null ? null : (metricAmount(net) as never),
      netReturn: net === null || first === null ? null : (ratio(net, first) as never),
      completeCalendarDay: a === day && b === day + dayNs,
      sourceCoverage: complete && first !== null && last !== null ? 'COMPLETE' : 'MISSING_OR_STALE',
    });
  }
  const returns = daily
    .filter((d) => d.completeCalendarDay)
    .map((d) =>
      d.sourceCoverage === 'COMPLETE' && d.netReturn !== null ? Number(d.netReturn) : null,
    );
  let volatility: string | null = null;
  if (returns.length >= 2 && returns.every((r) => r !== null)) {
    const values = returns,
      mean = values.reduce((s, v) => s + v, 0) / values.length;
    volatility = metricAmount(
      Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1)),
    );
  }
  const duration = end - start,
    result = PerformanceMetricsSchema.parse({
      schemaVersion: 'performance-metrics.v1',
      portfolio: q.portfolio,
      initialEquity: q.initialEquity,
      terminalEquity: terminal,
      netPnl: pnl === null ? null : metricAmount(pnl),
      grossPnlBeforeFees: pnl === null ? null : metricAmount(pnl.plus(fees)),
      netReturn: pnl === null ? null : ratio(pnl, initial),
      grossReturnBeforeFees: pnl === null ? null : ratio(pnl.plus(fees), initial),
      closedTrades: q.trades.length,
      winRate: q.trades.length ? ratio(wins.length, q.trades.length) : null,
      profitFactor: lossSum.isZero() ? null : ratio(winSum, lossSum.neg()),
      averageWin: wins.length ? ratio(winSum, wins.length) : null,
      averageLoss: losses.length ? ratio(lossSum, losses.length) : null,
      expectancyAfterFees: q.trades.length ? ratio(winSum.plus(lossSum), q.trades.length) : null,
      maxDrawdown: unknown ? null : metricAmount(observedDD),
      observedMaxDrawdown: metricAmount(observedDD),
      recoveryFactor:
        unknown || pnl === null || absoluteDD.isZero() ? null : ratio(pnl, absoluteDD),
      dailyReturnVolatility: volatility,
      fees: metricAmount(fees),
      slippageCost: metricAmount(slippage),
      turnoverNotional: metricAmount(turnover),
      turnoverFraction: ratio(turnover, initial),
      timeInMarketFraction:
        duration === 0n ? '0' : ratio(positioned.toString(), duration.toString()),
      timeWeightedExposure: unknown
        ? null
        : duration === 0n
          ? '0'
          : ratio(weightedExposure, duration.toString()),
      knownValuationFraction:
        duration === 0n ? '1' : ratio(knownTime.toString(), duration.toString()),
      eventCoverage: q.declaredOpportunities
        ? ratio(q.observedOpportunities, q.declaredOpportunities)
        : null,
      rejectedSignals: q.rejectedSignals,
      holds: q.holds,
      fillRate: q.acceptedOrders ? ratio(q.filledOrders, q.acceptedOrders) : null,
      daily,
      trades: q.trades,
    });
  deepFreeze(result);
  return result;
}
export type { PerformanceInput };
