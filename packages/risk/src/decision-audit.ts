import { Decimal } from 'decimal.js';
import {
  CounterfactualOutcomeSchema,
  DecisionPolicySchema,
  DecisionRecordSchema,
  DecisionRequestSchema,
  UtcTimestampSchema,
  utcNanoseconds,
  ArmDayPerformanceSchema,
} from '@crypto/contracts';
import type { DecisionRecord } from '@crypto/contracts';
import { canonicalHash, deepFreeze, deterministicId } from '@crypto/core';
import { evaluateRisk } from './index.js';

const D = Decimal.clone({ precision: 256 });
export function makeDecisionRecord(
  policyInput: unknown,
  requestInput: unknown,
  codeVersion: string,
): DecisionRecord {
  const policy = DecisionPolicySchema.parse(policyInput),
    request = DecisionRequestSchema.parse(requestInput),
    c = request.risk.candidate,
    evidence = new Map(request.evidence.map((e) => [e.id, e]));
  if (evidence.size !== request.evidence.length) throw new Error('Duplicate decision evidence');
  for (const id of [...c.rationaleIds, ...request.risk.market.evidenceIds, request.regime.id]) {
    const e = evidence.get(id);
    if (!e || e.availableAt > (c.rationaleIds.includes(id) ? c.dataCutoff : request.risk.at))
      throw new Error('Decision evidence missing or unavailable');
  }
  if (
    request.regime.availableAt > request.risk.at ||
    evidence.get(request.regime.id)!.availableAt !== request.regime.availableAt
  )
    throw new Error('Unavailable regime');
  const b = request.calibration,
    horizon = (h: typeof c.horizon) =>
      BigInt(h.value) * { seconds: 1n, minutes: 60n, hours: 3600n, days: 86400n }[h.unit];
  const boundCalibration =
    c.calibration.status === 'KNOWN' &&
    b !== null &&
    b.modelVersion === c.calibration.value.modelVersion &&
    b.sampleEndAt < b.availableAt &&
    b.availableAt <= policy.risk.frozenAt &&
    horizon(b.horizon) === horizon(c.horizon) &&
    request.evidence.some(
      (e) =>
        e.contentHash === b.artifactHash &&
        e.availableAt === b.availableAt &&
        e.availableAt <= c.dataCutoff,
    );
  const restricted =
      request.regime.kind === 'UNKNOWN' ||
      !policy.allowedRegimes.some((r) => r === request.regime.kind),
    discount = D.min(
      request.risk.uncertaintyDiscount,
      boundCalibration ? '1' : policy.uncalibratedDiscount,
    ),
    riskRequest = { ...request.risk, uncertaintyDiscount: restricted ? '0' : discount.toFixed() },
    risk = evaluateRisk(policy.risk, riskRequest, codeVersion),
    body = {
      schemaVersion: 'decision-record.v1',
      request,
      policy,
      risk,
      featureCutoff: c.dataCutoff,
      calibration: boundCalibration ? 'BOUND_KNOWN' : 'UNCALIBRATED',
      finalReasons: [
        ...risk.decision.audit.reasons,
        ...(restricted ? ['REGIME_RESTRICTED'] : []),
        ...(!boundCalibration ? ['UNCALIBRATED_SIZE_DISCOUNT'] : []),
      ],
      configHash: canonicalHash(policy),
      previousHash: request.previousHash,
    };
  const withId = { ...body, id: deterministicId('decision-record', body) },
    record = DecisionRecordSchema.parse({ ...withId, hash: canonicalHash(withId) });
  deepFreeze(record);
  return record;
}
export function verifyDecisionRecord(input: unknown) {
  const r = DecisionRecordSchema.parse(input),
    rebuilt = makeDecisionRecord(r.policy, r.request, r.risk.decision.audit.codeVersion);
  if (canonicalHash(r) !== canonicalHash(rebuilt)) throw new Error('Decision semantic integrity');
  return rebuilt;
}
/** Diagnostic one-unit net markouts, not broker fills or portfolio PnL. Never changes decisions. */
export function compareRiskCounterfactuals(
  recordsInput: unknown[],
  outcomesInput: unknown[],
  generatedAt: string,
) {
  const asOf = UtcTimestampSchema.parse(generatedAt);
  const records = recordsInput.map(verifyDecisionRecord),
    outcomes = outcomesInput.map((o) => CounterfactualOutcomeSchema.parse(o));
  const byId = new Map(outcomes.map((o) => [o.candidateId, o]));
  if (byId.size !== outcomes.length) throw new Error('Duplicate counterfactual outcome');
  const rows = records.map((r) => {
    const c = r.request.risk.candidate,
      outcome = byId.get(c.id);
    const duration =
      BigInt(c.horizon.value) *
      { seconds: 1n, minutes: 60n, hours: 3600n, days: 86400n }[c.horizon.unit];
    if (
      outcome &&
      (utcNanoseconds(outcome.exitAt) !== utcNanoseconds(c.decisionAt) + duration * 1000000000n ||
        outcome.availableAt < outcome.exitAt ||
        outcome.availableAt > asOf)
    )
      throw new Error('Invalid counterfactual chronology');
    const measured = c.side !== 'HOLD' ? (outcome?.netUnitReturn ?? null) : null;
    return {
      candidateId: c.id,
      portfolio: c.portfolio,
      vetoed: !r.risk.decision.allowed,
      noRiskUnitMarkout: measured,
      withRiskGateUnitMarkout: measured === null ? null : r.risk.decision.allowed ? measured : '0',
      evidenceHash: outcome?.evidenceHash ?? null,
    };
  });
  if (outcomes.some((o) => !records.some((r) => r.request.risk.candidate.id === o.candidateId)))
    throw new Error('Outcome outside declared decisions');
  return deepFreeze({
    schemaVersion: 'risk-counterfactual.v1',
    interpretation: 'DIAGNOSTIC_UNIT_MARKOUT_NOT_EXECUTED_PNL',
    fusionImprovement: 'NOT_ESTABLISHED_REQUIRES_OUT_OF_SAMPLE_EVALUATION',
    rows,
    vetoCount: rows.filter((r) => r.vetoed).length,
    hindsightPositiveOpportunitiesVetoed: rows.filter(
      (r) => r.vetoed && r.noRiskUnitMarkout !== null && new D(r.noRiskUnitMarkout).gt(0),
    ).length,
  });
}

/** Outcome-only audit analytics. This function is never called by candidate producers. */
export function analyzeDecisionArms(
  recordsInput: unknown[],
  dailyInput: unknown[],
  generatedAt: string,
) {
  const records = recordsInput.map(verifyDecisionRecord),
    asOf = UtcTimestampSchema.parse(generatedAt),
    daily = dailyInput.map((d) => ArmDayPerformanceSchema.parse(d)),
    keys = new Set<string>(),
    arms = ['BASELINE', 'NEWS_ONLY', 'MARKET_ONLY', 'FUSION'] as const;
  for (const d of daily) {
    const key = `${d.portfolio}/${d.day}`;
    if (keys.has(key) || d.availableAt > asOf || d.availableAt.slice(0, 10) <= d.day)
      throw new Error('Duplicate, future or incomplete daily performance');
    keys.add(key);
  }
  const slots = new Map<string, Map<string, string>>();
  for (const r of records) {
    const c = r.request.risk.candidate,
      key = `${c.decisionAt}/${c.symbol}`,
      slot = slots.get(key) ?? new Map<string, string>();
    if (slot.has(c.portfolio)) throw new Error('Duplicate decision arm/window');
    slot.set(c.portfolio, c.side);
    slots.set(key, slot);
  }
  const correlations = arms.flatMap((a, i) =>
    arms.slice(i + 1).map((b) => {
      const pairs = daily
          .filter((d) => d.portfolio === a)
          .flatMap((x) => {
            const y = daily.find((d) => d.portfolio === b && d.day === x.day);
            return y ? [[Number(x.netReturn), Number(y.netReturn)] as const] : [];
          }),
        n = pairs.length;
      let value: number | null = null;
      if (n >= 3) {
        const mx = pairs.reduce((s, p) => s + p[0], 0) / n,
          my = pairs.reduce((s, p) => s + p[1], 0) / n,
          xx = pairs.reduce((s, p) => s + (p[0] - mx) ** 2, 0),
          yy = pairs.reduce((s, p) => s + (p[1] - my) ** 2, 0);
        if (xx > 0 && yy > 0)
          value = pairs.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0) / Math.sqrt(xx * yy);
      }
      return { left: a, right: b, pairedDays: n, value };
    }),
  );
  return deepFreeze({
    schemaVersion: 'decision-arm-analysis.v1',
    signalConflicts: [...slots.values()].filter((s) => {
      const n = s.get('NEWS_ONLY'),
        m = s.get('MARKET_ONLY');
      return n && m && n !== 'HOLD' && m !== 'HOLD' && n !== m;
    }).length,
    byArm: arms.map((portfolio) => ({
      portfolio,
      candidates: records.filter((r) => r.request.risk.candidate.portfolio === portfolio).length,
      vetoes: records.filter(
        (r) => r.request.risk.candidate.portfolio === portfolio && !r.risk.decision.allowed,
      ).length,
      contributionNetPnl: daily
        .filter((d) => d.portfolio === portfolio)
        .reduce((s, d) => s.plus(d.netPnl), new D(0))
        .toFixed(),
      observedDays: daily.filter((d) => d.portfolio === portfolio).length,
    })),
    correlations,
    fusionImprovement: 'NOT_ESTABLISHED_REQUIRES_OUT_OF_SAMPLE_EVALUATION',
  });
}
