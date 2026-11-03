import { Decimal } from 'decimal.js';
import type { NewsEdgeRow, NewsEdgeStats } from '@crypto/contracts';
import { DecimalStringSchema } from '@crypto/contracts';
import { SeededRandom } from '@crypto/core';
export const EdgeDecimal = Decimal.clone({ precision: 96, rounding: Decimal.ROUND_HALF_EVEN });
export const edgeMetric = (v: Decimal) =>
  DecimalStringSchema.parse(v.toDecimalPlaces(36).toFixed());
const D = EdgeDecimal;
export function newsEdgeUnits(rows: NewsEdgeRow[]) {
  const groups: NewsEdgeRow[][] = [];
  for (const row of rows.filter((r) => r.status === 'COMPLETE')) {
    const joins = groups.filter((g) =>
      g.some(
        (r) =>
          row.lineageIds.some((id) => r.lineageIds.includes(id)) ||
          row.controlIds.some((id) => r.controlIds.includes(id)) ||
          row.barIds.some((id) => r.barIds.includes(id)) ||
          (row.from < r.endAt && r.from < row.endAt),
      ),
    );
    for (const g of joins) groups.splice(groups.indexOf(g), 1);
    groups.push([row, ...joins.flat()]);
  }
  return groups;
}
export function newsEdgeStatistics(
  rows: NewsEdgeRow[],
  minimum: number,
  samples: number,
  seed: number,
  family: number,
): NewsEdgeStats {
  const groups = newsEdgeUnits(rows),
    gross = groups.map((g) => D.sum(...g.map((r) => r.grossReturn!)).div(g.length)),
    excess = groups.map((g) => D.sum(...g.map((r) => r.excessReturn!)).div(g.length));
  const baseline = new Map<string, string>();
  for (const r of rows.filter((r) => r.status === 'COMPLETE'))
    r.controlIds.forEach((id, i) => {
      const value = r.baselineReturns[i]!;
      if (baseline.has(id) && baseline.get(id) !== value)
        throw new Error('Ambiguous matched control');
      baseline.set(id, value);
    });
  const distribution = [...baseline.values()].map((v) => new D(v)).sort((a, b) => a.comparedTo(b));
  const base = {
    sampleCount: rows.length,
    completeCount: rows.filter((r) => r.status === 'COMPLETE').length,
    independentUnits: groups.length,
    unitMembers: groups.map((g) => g.map((r) => r.observationId).sort()),
    meanGross: gross.length ? edgeMetric(D.sum(...gross).div(gross.length)) : null,
    meanExcess: excess.length ? edgeMetric(D.sum(...excess).div(excess.length)) : null,
    baselineDistribution: {
      count: distribution.length,
      minimum: distribution.length ? edgeMetric(distribution[0]!) : null,
      median: distribution.length
        ? edgeMetric(
            distribution[Math.floor((distribution.length - 1) / 2)]!.plus(
              distribution[Math.ceil((distribution.length - 1) / 2)]!,
            ).div(2),
          )
        : null,
      maximum: distribution.length ? edgeMetric(distribution.at(-1)!) : null,
    },
  };
  const tail = Math.floor((samples - 1) / (40 * family));
  if (groups.length < minimum || tail < 1)
    return {
      ...base,
      grossInterval: null,
      excessInterval: null,
      uncertaintyReason:
        groups.length < minimum ? 'INSUFFICIENT_UNITS' : 'INSUFFICIENT_RESAMPLING_RESOLUTION',
    };
  const random = new SeededRandom(seed),
    gDraws: Decimal[] = [],
    eDraws: Decimal[] = [];
  for (let i = 0; i < samples; i++) {
    let gs = new D(0),
      es = new D(0);
    for (let j = 0; j < groups.length; j++) {
      const k = random.nextInt(groups.length);
      gs = gs.plus(gross[k]!);
      es = es.plus(excess[k]!);
    }
    gDraws.push(gs.div(groups.length));
    eDraws.push(es.div(groups.length));
  }
  const interval = (draws: Decimal[]) => {
    draws.sort((a, b) => a.comparedTo(b));
    return {
      lower: edgeMetric(draws[tail]!),
      upper: edgeMetric(draws[samples - 1 - tail]!),
      level: edgeMetric(new D(1).minus(new D('0.05').div(family))),
      familySize: family,
      resamples: samples,
      seed,
      method: 'CONNECTED_EVIDENCE_BLOCK_BOOTSTRAP.v1' as const,
      interpretation: 'CONDITIONAL_MEAN_INTERVAL_NOT_INDIVIDUAL_FORECAST_OR_CAUSAL' as const,
    };
  };
  return {
    ...base,
    grossInterval: interval(gDraws),
    excessInterval: interval(eDraws),
    uncertaintyReason: null,
  };
}
export function newsEdgeMargin(
  stats: NewsEdgeStats,
  side: 'LONG' | 'SHORT' | 'HOLD',
  costBps: number,
  bufferBps: number,
) {
  if (side === 'HOLD' || !stats.grossInterval || !stats.excessInterval) return null;
  const signedLower = (ci: NonNullable<NewsEdgeStats['grossInterval']>) =>
    side === 'LONG' ? new D(ci.lower) : new D(ci.upper).neg();
  return edgeMetric(
    D.min(signedLower(stats.grossInterval), signedLower(stats.excessInterval)).minus(
      new D(costBps + bufferBps).div(10000),
    ),
  );
}
