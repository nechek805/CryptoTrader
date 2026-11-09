import { SpecialistV5CandidateSchema, SpecialistAssetSchema } from '@crypto/contracts';
import type { SpecialistV5Candidate } from '@crypto/contracts';
import { canonicalHash } from '@crypto/core';
import { runSpecialistV5 } from './specialist-v5-runner.js';
import { D } from './spot-math.js';
export function specialistV5Baseline(assetInput: unknown): SpecialistV5Candidate {
  const asset = SpecialistAssetSchema.parse(assetInput);
  return SpecialistV5CandidateSchema.parse(
    asset === 'SOL'
      ? { asset, base: 'V2', stopAtr: '2.5', targetAtr: '5', trendSlopeHours: 24 }
      : {
          asset,
          base: 'V3',
          stopAtr: '2',
          targetAtr: '3.5',
          minSignalRangeAtr: '0.8',
          trendSlopeHours: 24,
        },
  );
}
/** Registered before scoring; baseline is retained as a no-change candidate. */
export function specialistV5Candidates(assetInput: unknown) {
  const base = specialistV5Baseline(assetInput);
  return (
    base.asset === 'SOL'
      ? [
          ...['5', '6'].flatMap((targetAtr) =>
            [undefined, '1.5', '2', '2.5', '3', '3.5'].map((trailDistanceAtr) => ({
              ...base,
              targetAtr,
              ...(trailDistanceAtr ? { trailDistanceAtr } : {}),
            })),
          ),
          ...['0.004', '0.006', '0.008'].flatMap((lowVolatilityThreshold) =>
            ['3', '4'].map((lowVolatilityTargetAtr) => ({
              ...base,
              lowVolatilityThreshold,
              lowVolatilityTargetAtr,
            })),
          ),
        ]
      : [
          base,
          ...['1', '1.25', '1.5'].flatMap((adaptiveLowerAtr) =>
            ['4.5', '5', '5.5', '6'].map((adaptiveTargetAtr) => ({
              ...base,
              adaptiveLowerAtr,
              adaptiveTargetAtr,
            })),
          ),
        ]
  ).map((c) => SpecialistV5CandidateSchema.parse(c));
}
export type SpecialistV5Trial = {
  candidate: SpecialistV5Candidate;
  result: ReturnType<typeof runSpecialistV5>;
};
/** Later results are never ranked. */
export function chooseSpecialistV5(trials: SpecialistV5Trial[]) {
  const registered = specialistV5Candidates(trials[0]?.candidate.asset),
    hashes = new Set(registered.map((c) => canonicalHash(c))),
    first = trials[0]?.result.report;
  if (
    trials.length !== registered.length ||
    new Set(trials.map((t) => canonicalHash(t.candidate))).size !== registered.length ||
    !first ||
    trials.some(
      (t) =>
        !hashes.has(canonicalHash(t.candidate)) ||
        canonicalHash(t.candidate) !== canonicalHash(t.result.report.plan.candidate) ||
        t.result.report.plan.feeMode !== 'STANDARD' ||
        t.result.report.datasetId !== first.datasetId ||
        t.result.report.window.fromIndex !== 0 ||
        t.result.report.window.toIndex !== first.window.toIndex,
    )
  )
    throw new Error(
      'Complete registered coin-specific grid on one fee-on development window required',
    );
  const eligible = trials.filter((t) => new D(t.result.report.summary.maxDrawdown).lte('0.02'));
  if (!eligible.length)
    throw new Error('No candidate passed the fixed 2% development drawdown ceiling');
  const complexity = (c: SpecialistV5Candidate) =>
    c.trailDistanceAtr || c.lowVolatilityThreshold || c.adaptiveLowerAtr ? 1 : 0;
  return [...eligible].sort(
    (a, b) =>
      new D(b.result.report.summary.netPnl).cmp(a.result.report.summary.netPnl) ||
      a.result.report.summary.closedTrades - b.result.report.summary.closedTrades ||
      complexity(a.candidate) - complexity(b.candidate) ||
      Number(b.candidate.adaptiveLowerAtr ?? 0) - Number(a.candidate.adaptiveLowerAtr ?? 0) ||
      canonicalHash(a.candidate).localeCompare(canonicalHash(b.candidate)),
  )[0]!;
}
export async function searchSpecialistV5(
  data: unknown,
  asset: unknown,
  splitIndex: number,
  progress: (text: string) => void = () => {},
) {
  const trials: SpecialistV5Trial[] = [],
    candidates = specialistV5Candidates(asset);
  for (const candidate of candidates) {
    progress(`${candidate.asset}: v5 development trial ${trials.length + 1}/${candidates.length}`);
    await new Promise<void>((resolve) => setImmediate(resolve));
    trials.push({
      candidate,
      result: runSpecialistV5(data, candidate, 'STANDARD', { fromIndex: 0, toIndex: splitIndex }),
    });
  }
  return { trials, selected: chooseSpecialistV5(trials) };
}
