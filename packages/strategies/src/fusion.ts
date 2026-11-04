import { Decimal } from 'decimal.js';
import {
  FusionPlanSchema,
  FusionReportSchema,
  FusionRunInputSchema,
  FusionSubmissionSchema,
  SignalCandidateSchema,
} from '@crypto/contracts';
import type {
  ComponentArm,
  FusionOpportunity,
  FusionPlan,
  FusionReport,
  FusionSubmission,
  SignalCandidate,
} from '@crypto/contracts';
import { canonicalHash, deepFreeze, deterministicId } from '@crypto/core';
import type { DeepReadonly } from '@crypto/core';

const D = Decimal.clone({ precision: 80 });
const components = ['BASELINE', 'NEWS_ONLY', 'MARKET_ONLY'] as const;
const portfolios = [...components, 'FUSION'] as const;
const seconds = (h: SignalCandidate['horizon']) =>
  BigInt(h.value) * { seconds: 1n, minutes: 60n, hours: 3600n, days: 86400n }[h.unit];
const check = (ok: boolean, reason: string) => {
  if (!ok) throw new Error(`Fusion rejected: ${reason}`);
};

export function validateFusionPlan(input: unknown): FusionPlan {
  const p = FusionPlanSchema.parse(input),
    s = p.policy.selection;
  check(
    s.startAt < s.endAt && s.endAt <= s.availableAt && s.availableAt <= p.policy.frozenAt,
    'selection must use available historical TRAIN evidence',
  );
  check(
    new D(p.policy.newsWeight).gt(0) && new D(p.policy.newsWeight).lt(1),
    'both weights must be positive',
  );
  check(new D(p.policy.minimumWeightedScore).gt(0), 'positive weighted threshold required');
  check(
    new Set(p.common.datasetHashes).size === p.common.datasetHashes.length,
    'duplicate dataset hash',
  );
  const seen = new Set<string>(),
    slots = new Set<string>();
  let previous: string | null = null;
  for (const w of p.opportunities) {
    check(!seen.has(w.id), 'duplicate opportunity');
    seen.add(w.id);
    const slot = `${w.decisionAt}/${w.symbol}`;
    check(!slots.has(slot), 'duplicate symbol/window');
    slots.add(slot);
    check(previous === null || previous <= w.decisionAt, 'opportunities must be chronological');
    previous = w.decisionAt;
    check(w.dataCutoff <= w.decisionAt && w.validUntil > w.decisionAt, 'invalid decision clocks');
    check(
      p.policy.frozenAt < w.decisionAt && p.generatedAt >= w.decisionAt,
      'policy must be frozen before decisions',
    );
  }
  return p;
}

function reproducibility(p: FusionPlan, w: FusionOpportunity, modelVersion: string) {
  return {
    datasetHashes: [...p.common.datasetHashes, w.snapshotHash],
    configHash: canonicalHash(p),
    codeVersion: p.codeVersion,
    modelVersion,
    randomSeed: p.randomSeed,
    randomAlgorithm: 'mulberry32.v1',
    clockSemantics: 'utc-nanoseconds.v1',
    generatedAt: w.decisionAt,
    feeAssumptionsHash: p.common.feeAssumptionsHash,
  };
}
function candidate(
  p: FusionPlan,
  w: FusionOpportunity,
  arm: SignalCandidate['portfolio'],
  side: SignalCandidate['side'],
  rationaleIds: string[],
  validUntil = w.validUntil,
) {
  const descriptor =
    arm === 'FUSION'
      ? { id: `fusion:${p.policy.kind.toLowerCase()}`, version: p.policy.algorithmVersion }
      : p.producers[arm];
  const body = {
    schemaVersion: 'signal-candidate.v1',
    strategyId: descriptor.id,
    version: descriptor.version,
    portfolio: arm,
    symbol: w.symbol,
    decisionAt: w.decisionAt,
    dataCutoff: w.dataCutoff,
    horizon: w.horizon,
    side,
    score: { status: 'MISSING', reason: 'No combined return forecast' },
    calibration: {
      status: 'MISSING',
      reason: 'Fusion policy is not a calibrated predictive model',
    },
    rationaleIds,
    validUntil,
    reproducibility: reproducibility(p, w, descriptor.version),
  };
  return SignalCandidateSchema.parse({ ...body, id: deterministicId('fusion-candidate', body) });
}

function normalize(p: FusionPlan, w: FusionOpportunity, arm: ComponentArm, s: FusionSubmission) {
  check(
    s.snapshotHash === w.snapshotHash &&
      s.executionAssumptionsHash === p.common.executionAssumptionsHash,
    'unequal snapshot/execution assumptions',
  );
  const evidence = new Map(s.evidence.map((e) => [e.id, e]));
  check(evidence.size === s.evidence.length, 'duplicate evidence id');
  for (const e of evidence.values()) {
    check(e.availableAt <= w.dataCutoff, 'future evidence');
    check(e.origin === p.origin, 'source origin mismatch');
  }
  const unique = new Map<string, SignalCandidate>();
  for (const c of s.candidates) {
    check(arm !== 'BASELINE' || c.side === 'HOLD', 'cash baseline must abstain');
    const old = unique.get(c.id);
    check(!old || canonicalHash(old) === canonicalHash(c), 'conflicting duplicate candidate id');
    unique.set(c.id, c);
    check(
      c.portfolio === arm &&
        c.strategyId === p.producers[arm].id &&
        c.version === p.producers[arm].version,
      'producer/portfolio mismatch',
    );
    check(
      c.symbol === w.symbol &&
        c.decisionAt === w.decisionAt &&
        seconds(c.horizon) === seconds(w.horizon),
      'candidate outside declared opportunity',
    );
    check(
      c.dataCutoff <= w.dataCutoff &&
        c.reproducibility.generatedAt <= w.decisionAt &&
        c.validUntil <= w.validUntil,
      'candidate clock/expiry mismatch',
    );
    check(
      c.reproducibility.feeAssumptionsHash === p.common.feeAssumptionsHash &&
        c.reproducibility.codeVersion === p.codeVersion &&
        c.reproducibility.configHash === p.producers[arm].configHash &&
        c.reproducibility.randomSeed === p.randomSeed &&
        c.reproducibility.datasetHashes.every((h) => p.common.datasetHashes.includes(h)),
      'candidate assumptions mismatch',
    );
    for (const id of c.rationaleIds) {
      const e = evidence.get(id);
      check(
        e !== undefined && e.availableAt <= c.dataCutoff,
        'missing or future rationale evidence',
      );
    }
  }
  check(unique.size <= 1, 'ambiguous candidates for one arm/window');
  return {
    candidate: [...unique.values()][0] ?? candidate(p, w, arm, 'HOLD', [w.id]),
    duplicates: s.candidates.length - unique.size,
  };
}

function calibratedSupport(
  c: SignalCandidate,
  s: FusionSubmission,
  p: FusionPlan,
  w: FusionOpportunity,
): Decimal | null {
  const b = s.calibration;
  if (c.side === 'HOLD' || c.calibration.status !== 'KNOWN' || !b) return null;
  if (
    b.sampleEndAt >= b.availableAt ||
    b.availableAt > p.policy.frozenAt ||
    b.availableAt > c.dataCutoff ||
    b.modelVersion !== c.calibration.value.modelVersion ||
    seconds(b.horizon) !== seconds(w.horizon)
  )
    return null;
  const e = s.evidence.find(
    (e) => e.contentHash === b.artifactHash && e.availableAt === b.availableAt,
  );
  if (!e) return null;
  const support = new D(c.calibration.value.probability).mul(2).minus(1);
  if (support.lte(0)) return null;
  return support.mul(c.side === 'LONG' ? 1 : -1);
}

/** Pure immutable candidate collection. It accepts no positions, balances, outcomes or PnL. */
export function runFusion(input: unknown): FusionReport {
  const parsed = FusionRunInputSchema.parse(input),
    p = validateFusionPlan(parsed.plan);
  check(parsed.windows.length === p.opportunities.length, 'missing/extra decision windows');
  const inputHash = canonicalHash(parsed),
    policyHash = canonicalHash(p.policy);
  let head = canonicalHash({ inputHash, policyHash });
  const windows: FusionReport['windows'] = [];
  const candidateHashes = new Map<string, string>();
  const evidenceHashes = new Map<string, string>();
  for (const [i, w] of p.opportunities.entries()) {
    const source = parsed.windows[i]!;
    check(source.opportunityId === w.id, 'window order/opportunity mismatch');
    for (const arm of components)
      for (const e of source.submissions[arm].evidence) {
        const hash = canonicalHash(e),
          old = evidenceHashes.get(e.id);
        check(old === undefined || old === hash, 'conflicting evidence identity');
        evidenceHashes.set(e.id, hash);
      }
    const b = normalize(p, w, 'BASELINE', source.submissions.BASELINE),
      n = normalize(p, w, 'NEWS_ONLY', source.submissions.NEWS_ONLY),
      m = normalize(p, w, 'MARKET_ONLY', source.submissions.MARKET_ONLY);
    for (const c of [b.candidate, n.candidate, m.candidate]) {
      const hash = canonicalHash(c),
        old = candidateHashes.get(c.id);
      check(old === undefined || old === hash, 'candidate id reused across arms/windows');
      candidateHashes.set(c.id, hash);
    }
    const missingArms = components.filter((arm) => source.submissions[arm].candidates.length === 0);
    let side: SignalCandidate['side'] = 'HOLD',
      reason: FusionReport['windows'][number]['reason'] = 'COMPONENT_HOLD',
      weightedScore: number | null = null;
    if (missingArms.includes('NEWS_ONLY') || missingArms.includes('MARKET_ONLY'))
      reason = 'MISSING_COMPONENT';
    else if (
      n.candidate.side !== 'HOLD' &&
      m.candidate.side !== 'HOLD' &&
      n.candidate.side !== m.candidate.side
    )
      reason = 'DIRECTIONAL_CONFLICT';
    else if (p.policy.kind === 'WEIGHTED_CALIBRATED') {
      const ns = calibratedSupport(n.candidate, source.submissions.NEWS_ONLY, p, w),
        ms = calibratedSupport(m.candidate, source.submissions.MARKET_ONLY, p, w);
      reason = 'CALIBRATION_REQUIRED';
      if (ns !== null && ms !== null) {
        const score = ns.mul(p.policy.newsWeight).plus(ms.mul(new D(1).minus(p.policy.newsWeight)));
        weightedScore = score.toNumber();
        reason = 'BELOW_WEIGHTED_THRESHOLD';
        if (score.abs().gte(p.policy.minimumWeightedScore)) {
          side = score.gt(0) ? 'LONG' : 'SHORT';
          reason = 'WEIGHTED_SUPPORT';
        }
      }
    } else if (n.candidate.side !== 'HOLD' && n.candidate.side === m.candidate.side) {
      side = n.candidate.side;
      reason = 'AGREEMENT';
    } else if (
      p.policy.kind === 'DISAGREEMENT_HOLD' &&
      (n.candidate.side !== 'HOLD' || m.candidate.side !== 'HOLD')
    ) {
      side = n.candidate.side === 'HOLD' ? m.candidate.side : n.candidate.side;
      reason = 'SINGLE_DIRECTION';
    }
    // A single fusion candidate references its components; components are never forwarded as fusion orders.
    const expiry = [w.validUntil, n.candidate.validUntil, m.candidate.validUntil].sort()[0]!,
      fused = candidate(p, w, 'FUSION', side, [n.candidate.id, m.candidate.id, policyHash], expiry),
      body = {
        opportunityId: w.id,
        snapshotHash: w.snapshotHash,
        reason,
        weightedScore,
        missingArms,
        duplicateCounts: {
          BASELINE: b.duplicates,
          NEWS_ONLY: n.duplicates,
          MARKET_ONLY: m.duplicates,
        },
        candidates: {
          BASELINE: b.candidate,
          NEWS_ONLY: n.candidate,
          MARKET_ONLY: m.candidate,
          FUSION: fused,
        },
        previousHash: head,
      };
    head = canonicalHash(body);
    windows.push({ ...body, hash: head });
  }
  const report = FusionReportSchema.parse({
    schemaVersion: 'fusion-report.v1',
    execution: 'DISABLED',
    ordersCreated: 0,
    promotion: 'NOT_AUTHORIZED',
    assessment: p.origin === 'SYNTHETIC' ? 'SYNTHETIC_ONLY' : 'CANDIDATE_COLLECTION_ONLY',
    input: parsed,
    inputHash,
    policyHash,
    arms: portfolios.map((portfolio) => ({
      portfolio,
      portfolioId: deterministicId('fusion-portfolio', { inputHash, portfolio }),
      initialCapital: p.common.initialCapital,
      currency: p.common.currency,
      executionAssumptionsHash: p.common.executionAssumptionsHash,
      feeAssumptionsHash: p.common.feeAssumptionsHash,
    })),
    windows,
    logHead: head,
  });
  deepFreeze(report);
  return report;
}

/** Rebuild semantics as well as hashes. Repaired checksums do not authorize changed decisions. */
export function verifyFusionReport(input: unknown): FusionReport {
  const report = FusionReportSchema.parse(input),
    rebuilt = runFusion(report.input);
  check(canonicalHash(report) === canonicalHash(rebuilt), 'report semantic integrity');
  return rebuilt;
}

export interface IsolatedFusionContext {
  readonly portfolio: ComponentArm;
  readonly opportunity: DeepReadonly<FusionOpportunity>;
  readonly common: DeepReadonly<FusionPlan['common']>;
}
export type FusionProducer = (context: IsolatedFusionContext) => unknown;
/** Trusted in-process producer ports, not a sandbox. Bind each port to its own upstream provider.
 * Only shared assumptions and its own opportunity are exposed; no sibling output is a capability.
 */
export function collectFusionRun(
  plan: unknown,
  producers: Record<ComponentArm, FusionProducer>,
): FusionReport {
  const p = validateFusionPlan(plan);
  const windows = p.opportunities.map((w) => {
    const call = (portfolio: ComponentArm) =>
      FusionSubmissionSchema.parse(
        producers[portfolio](
          deepFreeze({
            portfolio,
            opportunity: structuredClone(w),
            common: structuredClone(p.common),
          }),
        ),
      );
    return {
      opportunityId: w.id,
      submissions: {
        BASELINE: call('BASELINE'),
        NEWS_ONLY: call('NEWS_ONLY'),
        MARKET_ONLY: call('MARKET_ONLY'),
      },
    };
  });
  return runFusion({ schemaVersion: 'fusion-run-input.v1', plan: p, windows });
}
