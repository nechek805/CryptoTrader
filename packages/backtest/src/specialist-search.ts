import { SpecialistCandidateSchema, SpecialistAssetSchema } from '@crypto/contracts';
import type { SpecialistCandidate } from '@crypto/contracts';
import { canonicalHash } from '@crypto/core';
import { runSpecialistStrategy } from './specialist-runner.js';
import { D } from './spot-math.js';
export function specialistBaseline(assetInput: unknown): SpecialistCandidate {
  const asset = SpecialistAssetSchema.parse(assetInput);
  return SpecialistCandidateSchema.parse({
    asset,
    base: asset === 'XRP' ? 'V3' : 'V2',
    stopAtr: '2',
    targetAtr: '3',
    trendSlopeHours: 24,
  });
}
export function specialistCandidates(assetInput: unknown) {
  const asset = SpecialistAssetSchema.parse(assetInput),
    base = specialistBaseline(asset);
  return asset === 'XRP'
    ? [
        ...[12, 24, 48].flatMap((trendSlopeHours) =>
          ['3', '4', '5', '6'].map((targetAtr) =>
            SpecialistCandidateSchema.parse({ ...base, trendSlopeHours, targetAtr }),
          ),
        ),
        ...['0.8', '1', '1.25'].flatMap((minSignalRangeAtr) =>
          ['3', '3.5', '4', '4.5'].map((targetAtr) =>
            SpecialistCandidateSchema.parse({ ...base, minSignalRangeAtr, targetAtr }),
          ),
        ),
      ]
    : ['1.5', '2', '2.5'].flatMap((stopAtr) =>
        ['3', '4', '5', '6'].map((targetAtr) =>
          SpecialistCandidateSchema.parse({ ...base, stopAtr, targetAtr }),
        ),
      );
}
export type SpecialistTrial = {
  candidate: SpecialistCandidate;
  result: ReturnType<typeof runSpecialistStrategy>;
};
/** Rank only earlier development results at the same risk, not the later check or full period. */
export function chooseSpecialist(trials: SpecialistTrial[]) {
  const expected = trials[0]?.candidate.asset === 'XRP' ? 24 : 12;
  if (
    trials.length !== expected ||
    new Set(trials.map((t) => canonicalHash(t.candidate))).size !== expected ||
    trials.some((t) => t.candidate.asset !== trials[0]!.candidate.asset)
  )
    throw new Error('Complete distinct coin-specific candidate grid required');
  const registered = new Set(
      specialistCandidates(trials[0]!.candidate.asset).map((c) => canonicalHash(c)),
    ),
    first = trials[0]!.result.report;
  if (
    trials.some(
      (t) =>
        !registered.has(canonicalHash(t.candidate)) ||
        canonicalHash(t.candidate) !== canonicalHash(t.result.report.plan.candidate) ||
        t.result.report.plan.feeMode !== 'STANDARD' ||
        t.result.report.datasetId !== first.datasetId ||
        t.result.report.window.fromIndex !== 0 ||
        t.result.report.window.toIndex !== first.window.toIndex,
    )
  )
    throw new Error(
      'Selection requires one fixed fee-on development window and the registered profiles',
    );
  const eligible = trials.filter((t) => new D(t.result.report.summary.maxDrawdown).lte('0.02'));
  if (!eligible.length)
    throw new Error('No candidate passed the fixed 2% development drawdown ceiling');
  return [...eligible].sort(
    (a, b) =>
      new D(b.result.report.summary.netPnl).cmp(a.result.report.summary.netPnl) ||
      a.result.report.summary.closedTrades - b.result.report.summary.closedTrades ||
      Number(a.candidate.minSignalRangeAtr ?? 0) - Number(b.candidate.minSignalRangeAtr ?? 0) ||
      Math.abs(a.candidate.trendSlopeHours - 24) - Math.abs(b.candidate.trendSlopeHours - 24) ||
      canonicalHash(a.candidate).localeCompare(canonicalHash(b.candidate)),
  )[0]!;
}
export async function searchSpecialist(
  data: unknown,
  asset: unknown,
  splitIndex: number,
  progress: (s: string) => void = () => {},
) {
  const trials: SpecialistTrial[] = [];
  const candidates = specialistCandidates(asset);
  for (const candidate of candidates) {
    progress(`${candidate.asset}: development trial ${trials.length + 1}/${candidates.length}`);
    await new Promise<void>((resolve) => setImmediate(resolve));
    trials.push({
      candidate,
      result: runSpecialistStrategy(data, candidate, 'STANDARD', {
        fromIndex: 0,
        toIndex: splitIndex,
      }),
    });
  }
  return { trials, selected: chooseSpecialist(trials) };
}
