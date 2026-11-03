import type { HypothesisSample, HypothesisStats, HypothesisCardContent } from '@crypto/contracts';
import { canonicalHash, SeededRandom } from '@crypto/core';
import { ControlDecimal as D, metric } from './event-control-math.js';

export function hypothesisUnits(samples: HypothesisSample[]) {
  const groups: HypothesisSample[][] = [];
  for (const s of samples.filter((s) => s.status === 'COMPLETE')) {
    const joins = groups.filter((g) =>
      g.some(
        (v) =>
          s.lineageIds.some((id) => v.lineageIds.includes(id)) ||
          (s.decisionAt < v.endAt && v.decisionAt < s.endAt),
      ),
    );
    if (!joins.length) groups.push([s]);
    else {
      for (const g of joins) groups.splice(groups.indexOf(g), 1);
      groups.push([s, ...joins.flat()]);
    }
  }
  return groups;
}
export function hypothesisStatistics(
  samples: HypothesisSample[],
  card: HypothesisCardContent,
  resamples: number,
  seed: number,
  familySize: number,
): HypothesisStats {
  const groups = hypothesisUnits(samples),
    values = groups.map((g) =>
      D.sum(
        ...g.map((s) =>
          card.tests.primaryMetric === 'GROSS_RETURN' ? s.grossReturn! : s.netReturn!,
        ),
      ).div(g.length),
    ),
    base = {
      sampleCount: samples.length,
      completeCount: samples.filter((s) => s.status === 'COMPLETE').length,
      quarantinedCount: samples.filter((s) =>
        [
          'DESCRIPTIVE_ONLY',
          'UNAVAILABLE_AT_DECISION',
          'QUALITY_EXCLUDED',
          'UNVERIFIED_EXCLUDED',
        ].includes(s.status),
      ).length,
      independentUnits: groups.length,
      unitDefinition: 'CONNECTED_LINEAGE_OR_OVERLAPPING_OUTCOME' as const,
      unitMembers: groups.map((g) => g.map((s) => s.observationId).sort()),
      mean: values.length ? metric(D.sum(...values).div(values.length)) : null,
    };
  if (groups.length < card.tests.minimumIndependentUnits)
    return {
      ...base,
      confidenceInterval: null,
      uncertaintyReason: values.length ? 'INSUFFICIENT_INDEPENDENT_UNITS' : 'NO_COMPLETE_SAMPLES',
    };
  const random = new SeededRandom(seed),
    draws = [];
  for (let i = 0; i < resamples; i++) {
    let sum = new D(0);
    for (let j = 0; j < values.length; j++) sum = sum.plus(values[random.nextInt(values.length)]!);
    draws.push(sum.div(values.length));
  }
  draws.sort((a, b) => a.comparedTo(b));
  const tail = Math.floor((resamples - 1) / (40 * familySize));
  return {
    ...base,
    uncertaintyReason: null,
    confidenceInterval: {
      method: 'LINEAGE_BLOCK_BOOTSTRAP_PERCENTILE.v1',
      level: metric(new D(1).minus(new D('0.05').div(familySize))),
      familySize,
      multiplicity: 'BONFERRONI_TARGET_95_FAMILY',
      interpretation: 'CONDITIONAL_RESAMPLING_NOT_CAUSAL_OR_POPULATION_GUARANTEE',
      lower: metric(draws[tail]!),
      upper: metric(draws[resamples - 1 - tail]!),
      resamples,
      seed,
    },
  };
}
export const hypothesisPhaseSeed = (seed: number, cardHash: string, phase: string) =>
  (seed ^ Number.parseInt(canonicalHash({ cardHash, phase }).slice(7, 15), 16)) >>> 0;
