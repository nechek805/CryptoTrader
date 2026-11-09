import {
  ShortV6CandidateSchema,
  ShortV6ProfileSchema,
  SpecialistAssetSchema,
} from '@crypto/contracts';
import type { ShortV6Candidate } from '@crypto/contracts';
import { canonicalHash } from '@crypto/core';
import { D } from './spot-math.js';
import { runShortV6Test } from './short-v6-runner.js';
export function shortV6Candidates(input: unknown) {
  const asset = SpecialistAssetSchema.parse(input),
    rows: unknown[] = [{ asset, kind: 'BASELINE' }];
  if (asset === 'SOL') {
    for (const minSlopeAtr of ['0', '0.5', '0.75', '1'])
      for (const targetAtr of ['2.5', '3', '4'])
        for (const trailDistanceAtr of [undefined, '1.5'])
          rows.push({
            asset,
            kind: 'TUNED',
            minSlopeAtr,
            minDistanceAtr: '0',
            maxDistanceAtr: null,
            targetAtr,
            ...(trailDistanceAtr ? { trailDistanceAtr } : {}),
          });
  } else {
    for (const minDistanceAtr of ['0', '0.75'])
      for (const maxDistanceAtr of ['3', '4', '6'])
        for (const targetAtr of ['3', '3.5', '4.5'])
          rows.push({
            asset,
            kind: 'TUNED',
            minSlopeAtr: '0',
            minDistanceAtr,
            maxDistanceAtr,
            targetAtr,
          });
  }
  return rows.map((c) => ShortV6CandidateSchema.parse(c));
}
export function shortV6Profile(parentInput: unknown, rulesInput: unknown) {
  const parent = ShortV6ProfileSchema.parse(parentInput),
    shortRules = ShortV6CandidateSchema.parse(rulesInput);
  if (parent.strategy !== 'V5' || !parent.candidate || parent.asset !== shortRules.asset)
    throw new Error('V6 requires its frozen V5 coin parent');
  return ShortV6ProfileSchema.parse({
    asset: parent.asset,
    strategy: 'V6',
    candidate: parent.candidate,
    shortRules,
  });
}
export type ShortV6Trial = {
  candidate: ShortV6Candidate;
  result: ReturnType<typeof runShortV6Test>;
};
export const eligibleShortV6 = (t: ShortV6Trial) =>
  !t.result.report.summary.insolvent &&
  t.result.report.summary.closedTrades >= 2 &&
  new D(t.result.report.summary.maxDrawdown).lte('0.02');
export function chooseShortV6(trials: ShortV6Trial[]) {
  const expected = shortV6Candidates(trials[0]?.candidate.asset),
    hashes = new Set(expected.map((c) => canonicalHash(c))),
    first = trials[0]?.result.report;
  if (
    !first ||
    trials.length !== expected.length ||
    new Set(trials.map((t) => canonicalHash(t.candidate))).size !== expected.length ||
    trials.some(
      (t) =>
        !hashes.has(canonicalHash(t.candidate)) ||
        t.result.report.plan.profile.strategy !== 'V6' ||
        canonicalHash(t.result.report.plan.profile.shortRules) !== canonicalHash(t.candidate) ||
        t.result.report.plan.mode !== 'SHORT_ONLY' ||
        t.result.report.plan.feeMode !== 'STANDARD' ||
        t.result.report.datasetId !== first.datasetId ||
        canonicalHash(t.result.report.plan.profile.candidate) !==
          canonicalHash(first.plan.profile.candidate) ||
        t.result.report.window.fromIndex !== 0 ||
        t.result.report.window.toIndex !== first.window.toIndex,
    )
  )
    throw new Error(
      'Complete registered grid on one fee-on short-only development window required',
    );
  const valid = trials.filter(eligibleShortV6);
  if (!valid.length)
    throw new Error('No V6 candidate passes two-trade minimum and 2% drawdown ceiling');
  const complexity = (c: ShortV6Candidate) =>
    c.kind === 'BASELINE' ? 0 : 1 + Number(!!c.trailDistanceAtr);
  return [...valid].sort(
    (a, b) =>
      new D(b.result.report.summary.netPnl).cmp(a.result.report.summary.netPnl) ||
      complexity(a.candidate) - complexity(b.candidate) ||
      a.result.report.summary.closedTrades - b.result.report.summary.closedTrades ||
      canonicalHash(a.candidate).localeCompare(canonicalHash(b.candidate)),
  )[0]!;
}
export async function searchShortV6(
  data: unknown,
  parentInput: unknown,
  splitIndex: number,
  progress: (s: string) => void = () => {},
) {
  const parent = ShortV6ProfileSchema.parse(parentInput),
    candidates = shortV6Candidates(parent.asset),
    trials: ShortV6Trial[] = [];
  for (const candidate of candidates) {
    progress(`${parent.asset}: V6 development candidate ${trials.length + 1}/${candidates.length}`);
    await new Promise<void>((resolve) => setImmediate(resolve));
    trials.push({
      candidate,
      result: runShortV6Test(data, shortV6Profile(parent, candidate), 'SHORT_ONLY', 'STANDARD', {
        fromIndex: 0,
        toIndex: splitIndex,
      }),
    });
  }
  return { trials, selected: chooseShortV6(trials) };
}
