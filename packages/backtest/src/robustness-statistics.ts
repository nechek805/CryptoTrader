import { RobustRiskInputSchema } from '@crypto/contracts';
import type { RobustRanking, MarketRobustnessPlan, RobustAttempt } from '@crypto/contracts';
import { canonicalHash, SeededRandom } from '@crypto/core';
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
/** Missing hypotheses are conservatively padded with p=1, including failed/imported trials. */
export function holmAdjusted(values: readonly number[], familySize: number) {
  if (
    !Number.isSafeInteger(familySize) ||
    familySize < values.length ||
    values.some((p) => !Number.isFinite(p) || p < 0 || p > 1)
  )
    throw new Error('Invalid multiple-comparison family');
  const ordered = values.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p || a.i - b.i),
    result = Array<number>(values.length);
  let previous = 0;
  ordered.forEach((v, i) => {
    previous = Math.max(previous, Math.min(1, v.p * (familySize - i)));
    result[v.i] = previous;
  });
  return result;
}
export function rankRobustness(input: unknown): RobustRanking[] {
  const q = RobustRiskInputSchema.parse(input),
    summaries: RobustRanking[] = [];
  if (new Set(q.trialIds).size !== q.trialIds.length || q.familySize < q.trialIds.length)
    throw new Error('Invalid ranking family');
  const keys = q.attempts.map((a) => `${a.trialId}\u0000${a.scenarioId}`),
    cases = q.attempts
      .filter((a) => a.trialId === q.trialIds[0])
      .map((a) => a.scenarioId)
      .sort();
  if (
    new Set(keys).size !== keys.length ||
    q.attempts.some((a) => !q.trialIds.includes(a.trialId)) ||
    q.trialIds.some(
      (id) =>
        canonicalHash(
          q.attempts
            .filter((a) => a.trialId === id)
            .map((a) => a.scenarioId)
            .sort(),
        ) !== canonicalHash(cases),
    )
  )
    throw new Error('Incomplete or duplicated attempted-case matrix');
  for (const a of q.attempts)
    if (
      a.status === 'COMPLETE' &&
      a.metrics?.netReturn !== null &&
      a.metrics !== null &&
      a.increments.length &&
      a.increments.every((v) => v !== null) &&
      Math.abs(a.increments.reduce<number>((s, v) => s + v, 0) - Number(a.metrics.netReturn)) >
        1e-10
    )
      throw new Error('Equity increments do not reconcile to net return');
  for (const trialId of q.trialIds) {
    const rows = q.attempts.filter((r) => r.trialId === trialId),
      complete = rows.filter(
        (r) =>
          r.status === 'COMPLETE' &&
          r.metrics?.netReturn !== null &&
          r.metrics?.maxDrawdownFraction !== null &&
          r.metrics !== null,
      ),
      values = complete.map((r) => Number(r.metrics!.netReturn)),
      dd = complete.map((r) => Number(r.metrics!.maxDrawdownFraction)),
      valid = rows.length > 0 && complete.length === rows.length;
    if (values.some((v) => !Number.isFinite(v))) throw new Error('Non-finite risk metrics');
    const sorted = [...values].sort((a, b) => a - b),
      tail = sorted.slice(0, Math.max(1, Math.ceil(sorted.length * 0.05))),
      average = valid ? mean(values) : null,
      worst = valid ? Math.max(...dd) : null,
      cvar = valid ? mean(tail) : null;
    const r: RobustRanking = {
      trialId,
      rank: null,
      completeCases: complete.length,
      failedCases: rows.filter((r) => r.status === 'FAILED').length,
      meanNetReturn: average,
      worstDrawdown: worst,
      tailCvar05: cvar,
      worstNetReturn: valid ? sorted[0]! : null,
      underperformCash: complete.filter(
        (r) => r.cashNetReturn !== null && Number(r.metrics!.netReturn) < r.cashNetReturn,
      ).length,
      underperformBuyAndHold: complete.filter(
        (r) =>
          r.buyAndHoldNetReturn !== null && Number(r.metrics!.netReturn) < r.buyAndHoldNetReturn,
      ).length,
      score: valid ? average! - worst! - Math.max(0, -cvar!) : null,
      uncertainty: {
        marginal95: null,
        rawP: null,
        holmP: null,
        blockCount: 0,
        reason: 'INCOMPLETE_EQUITY',
      },
    };
    const length = rows[0]?.increments.length ?? 0;
    if (
      valid &&
      length >= q.policy.blockLength &&
      rows.every((r) => r.increments.length === length && r.increments.every((v) => v !== null))
    ) {
      // Resample the SAME time indices for all scenarios/assets; averaging first preserves
      // their contemporaneous dependence. Stress variants never inflate the time sample.
      const joint = Array.from({ length }, (_, i) => mean(rows.map((r) => r.increments[i]!))),
        observed = joint.reduce((a, b) => a + b, 0),
        blocks = Math.floor(length / q.policy.blockLength),
        random = new SeededRandom(
          (q.randomSeed ^ Number.parseInt(canonicalHash(trialId).slice(7, 15), 16)) >>> 0,
        ),
        draws: number[] = [];
      for (let b = 0; b < q.policy.resamples; b++) {
        let sum = 0,
          count = 0;
        while (count < length) {
          const start = random.nextInt(length);
          for (let j = 0; j < q.policy.blockLength && count < length; j++, count++)
            sum += joint[(start + j) % length]!;
        }
        draws.push(sum);
      }
      draws.sort((a, b) => a - b);
      const lower = draws[Math.floor((draws.length - 1) * 0.025)]!,
        upper = draws[Math.ceil((draws.length - 1) * 0.975)]!,
        variance = joint.reduce((s, v) => s + (v - observed / length) ** 2, 0) / length;
      const reason =
        blocks < q.policy.minimumBlocks
          ? 'INSUFFICIENT_BLOCKS'
          : variance < 1e-24
            ? 'ZERO_VARIANCE'
            : 1 / (q.policy.resamples + 1) > q.policy.alpha / q.familySize
              ? 'MONTE_CARLO_RESOLUTION'
              : 'CONDITIONAL_APPROXIMATION';
      r.uncertainty = {
        marginal95: { lower, upper },
        rawP:
          reason === 'CONDITIONAL_APPROXIMATION'
            ? (1 + draws.filter((sum) => sum - observed >= observed).length) / (draws.length + 1)
            : null,
        holmP: null,
        blockCount: blocks,
        reason,
      };
    }
    summaries.push(r);
  }
  const adjusted = holmAdjusted(
    summaries.map((r) => r.uncertainty.rawP ?? 1),
    q.familySize,
  );
  summaries.forEach((r, i) => {
    r.uncertainty.holmP = r.uncertainty.rawP === null ? null : adjusted[i]!;
  });
  const sorted = [...summaries].sort((a, b) =>
    a.score === null
      ? b.score === null
        ? compare(a.trialId, b.trialId)
        : 1
      : b.score === null
        ? -1
        : b.score - a.score || compare(a.trialId, b.trialId),
  );
  let rank = 0;
  for (const r of sorted) if (r.score !== null) r.rank = ++rank;
  return sorted;
}
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
export function selectRobustness(
  rankings: RobustRanking[],
  plan: MarketRobustnessPlan,
  synthetic: boolean,
  attempts: RobustAttempt[],
  fingerprints: Map<string, { producerHash: string; featureHash: string }>,
) {
  let selected = 0;
  return rankings.map((r) => {
    const reasons: string[] = [];
    if (synthetic) reasons.push('SYNTHETIC_EVIDENCE_NO_PROMOTION');
    if (
      new Set(plan.scenarios.map((s) => s.asset)).size < 3 ||
      new Set(plan.scenarios.map((s) => s.regime)).size < 3
    )
      reasons.push('INSUFFICIENT_COHORT_COVERAGE');
    if (r.score === null || r.score <= 0) reasons.push('NONPOSITIVE_OR_UNKNOWN_RISK_ADJUSTED_NET');
    if (r.uncertainty.holmP === null || r.uncertainty.holmP > plan.policy.alpha)
      reasons.push('MULTIPLICITY_OR_UNCERTAINTY_GATE');
    if (r.uncertainty.marginal95 === null || r.uncertainty.marginal95.lower <= 0)
      reasons.push('LOWER_NET_BOUND_NOT_POSITIVE');
    if (
      r.worstDrawdown === null ||
      r.worstDrawdown > plan.policy.maxDrawdown ||
      r.tailCvar05 === null ||
      r.tailCvar05 < -plan.policy.maxTailLoss
    )
      reasons.push('DRAWDOWN_OR_TAIL_GATE');
    const cells = attempts.filter((a) => a.trialId === r.trialId);
    if (
      cells.length !== plan.scenarios.length ||
      cells.some((a) => a.status !== 'COMPLETE' || !a.metrics?.fillCount)
    )
      reasons.push('FAILED_OR_INACTIVE_CASE');
    if (!reasons.length && selected >= plan.policy.maxCandidates)
      reasons.push('PREDECLARED_CANDIDATE_CAP');
    const accepted = !reasons.length;
    if (accepted) selected++;
    return {
      trialId: r.trialId,
      status: accepted ? ('FORWARD_RESEARCH_CANDIDATE' as const) : ('ARCHIVED' as const),
      reasons,
      ...fingerprints.get(r.trialId)!,
      forwardExperimentRequired: true as const,
    };
  });
}
