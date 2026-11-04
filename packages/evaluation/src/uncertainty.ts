import {
  EvaluationDiagnosticsSchema,
  EvaluationPlanSchema,
  PairedComparisonSchema,
  PerformanceMetricsSchema,
} from '@crypto/contracts';
import type { PerformanceMetrics } from '@crypto/contracts';
import { canonicalHash, SeededRandom } from '@crypto/core';

export function evaluationUncertainty(metricsInput: unknown[], planInput: unknown) {
  const plan = EvaluationPlanSchema.parse(planInput),
    metrics = metricsInput.map((m) => PerformanceMetricsSchema.parse(m));
  if (
    metrics.length !== 4 ||
    new Set(metrics.map((m) => m.portfolio)).size !== 4 ||
    plan.familySize < 3 * Math.max(plan.experimentCount, plan.hyperparameterTrials)
  )
    throw new Error('Incomplete arms or understated search family');
  if (
    metrics.some(
      (m) =>
        m.closedTrades !== m.trades.length ||
        new Set(m.daily.map((d) => d.day)).size !== m.daily.length,
    )
  )
    throw new Error('Inconsistent trade count or daily calendar');
  const maximumHoldingDays = Math.ceil(
    Math.max(
      0,
      ...metrics.flatMap((m) =>
        m.trades.map((t) => (Date.parse(t.closedAt) - Date.parse(t.openedAt)) / 86400000),
      ),
    ),
  );
  if (plan.blockDays < Math.max(maximumHoldingDays, plan.overlapHorizonDays))
    throw new Error('Blocks shorter than overlapping holding horizons');
  const perArm = metrics.map((m) => {
    const abs = m.trades.map((t) => Math.abs(Number(t.netPnl))),
      total = abs.reduce((s, n) => s + n, 0),
      tail = total > 0 ? Math.max(...abs) / total : null,
      warnings: string[] = [];
    if (m.closedTrades < plan.minimumClosedTrades) warnings.push('INSUFFICIENT_EVIDENCE');
    if (tail !== null && tail > Number(plan.maximumTailContribution))
      warnings.push('TAIL_EVENT_DOMINANCE');
    if (m.daily.some((d) => d.sourceCoverage !== 'COMPLETE'))
      warnings.push('MISSING_SOURCE_COVERAGE');
    if (m.daily.some((d) => !d.completeCalendarDay)) warnings.push('PARTIAL_CALENDAR_DAY');
    return {
      portfolio: m.portfolio,
      closedTrades: m.closedTrades,
      completeDays: m.daily.filter((d) => d.completeCalendarDay && d.sourceCoverage === 'COMPLETE')
        .length,
      tailContribution: tail,
      warnings,
    };
  });
  const pairs = [
    ['NEWS_ONLY', 'MARKET_ONLY'],
    ['FUSION', 'MARKET_ONLY'],
    ['NEWS_ONLY', 'BASELINE'],
  ] as const;
  const pairedComparisons = pairs.map(([left, right]) => {
    const a = metrics.find((m) => m.portfolio === left)!,
      b = metrics.find((m) => m.portfolio === right)!,
      paired = a.daily.map((x) => ({ x, y: b.daily.find((y) => y.day === x.day) })),
      complete = paired.every(
        (p) =>
          p.y &&
          p.x.completeCalendarDay &&
          p.y.completeCalendarDay &&
          p.x.sourceCoverage === 'COMPLETE' &&
          p.y.sourceCoverage === 'COMPLETE' &&
          p.x.netReturn !== null &&
          p.y.netReturn !== null,
      ),
      xs = complete ? paired.map((p) => Number(p.x.netReturn) - Number(p.y!.netReturn)) : [],
      n = xs.length,
      blocks = Math.floor(n / plan.blockDays),
      mean = n ? xs.reduce((s, x) => s + x, 0) / n : null,
      warnings = [a, b].some(
        (m) => m.portfolio !== 'BASELINE' && m.closedTrades < plan.minimumClosedTrades,
      );
    let status:
      | 'INSUFFICIENT_EVIDENCE'
      | 'MISSING_COVERAGE'
      | 'ZERO_VARIANCE'
      | 'CONDITIONAL_APPROXIMATION'
      | 'MONTE_CARLO_RESOLUTION' = !complete
      ? 'MISSING_COVERAGE'
      : blocks < plan.minimumBlocks || warnings
        ? 'INSUFFICIENT_EVIDENCE'
        : 'CONDITIONAL_APPROXIMATION';
    let lower: number | null = null,
      upper: number | null = null;
    const tail = plan.alpha / plan.familySize / 2;
    if (status === 'CONDITIONAL_APPROXIMATION') {
      if (xs.every((x) => Math.abs(x - mean!) < 1e-15)) status = 'ZERO_VARIANCE';
      else if (tail * (plan.resamples - 1) < 1) status = 'MONTE_CARLO_RESOLUTION';
      else {
        const random = new SeededRandom(
            (plan.randomSeed ^ Number.parseInt(canonicalHash({ left, right }).slice(7, 15), 16)) >>>
              0,
          ),
          draws: number[] = [];
        for (let r = 0; r < plan.resamples; r++) {
          let sum = 0,
            count = 0;
          while (count < n) {
            const start = random.nextInt(n);
            for (let j = 0; j < plan.blockDays && count < n; j++, count++)
              sum += xs[(start + j) % n]!;
          }
          draws.push(sum / n);
        }
        draws.sort((x, y) => x - y);
        lower = draws[Math.floor((draws.length - 1) * tail)]!;
        upper = draws[Math.ceil((draws.length - 1) * (1 - tail))]!;
      }
    }
    return PairedComparisonSchema.parse({
      left,
      right,
      pairedDays: n,
      blockCount: blocks,
      estimate: mean,
      lower,
      upper,
      confidenceLevel: 1 - plan.alpha / plan.familySize,
      method: 'CIRCULAR_CONTIGUOUS_DAY_BLOCK_BOOTSTRAP',
      status,
      dates: complete ? a.daily.map((d) => d.day) : [],
    });
  });
  // Prospective rolling audit splits; purge + embargo cover the declared dependence block.
  const days = metrics[0]!.daily.map((d) => d.day),
    temporalSplits = days.flatMap((day, i) =>
      i < plan.blockDays + 1
        ? []
        : [
            {
              trainEnd: days[i - plan.blockDays - 1]!,
              testStart: day,
              testEnd: day,
              embargoDays: plan.blockDays,
            },
          ],
    );
  return {
    diagnostics: EvaluationDiagnosticsSchema.parse({
      declaredExperiments: plan.experimentCount,
      declaredTrials: plan.hyperparameterTrials,
      familySize: plan.familySize,
      blockDays: plan.blockDays,
      maximumHoldingDays,
      multiplicity: 'BONFERRONI_FAMILYWISE_INTERVALS_DECLARED_SEARCH_ONLY',
      perArm,
      temporalSplits,
    }),
    pairedComparisons,
  };
}
export type { PerformanceMetrics };
