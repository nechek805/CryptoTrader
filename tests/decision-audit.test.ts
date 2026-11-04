import { describe, expect, it } from 'vitest';
import { DecisionRequestSchema, DecisionPolicySchema } from '@crypto/contracts';
import {
  makeDecisionRecord,
  verifyDecisionRecord,
  compareRiskCounterfactuals,
  analyzeDecisionArms,
} from '@crypto/risk';
import { canonicalHash, decimal, fromEpoch } from '@crypto/core';
import { utcNanoseconds } from '@crypto/contracts';
import { riskFixture } from './fixtures/risk.js';

function fixture() {
  const f = riskFixture(),
    c = f.request.candidate;
  return {
    policy: DecisionPolicySchema.parse({
      schemaVersion: 'decision-policy.v1',
      risk: f.config,
      allowedRegimes: ['TREND', 'RANGE'],
      uncalibratedDiscount: '0.5',
    }),
    request: DecisionRequestSchema.parse({
      schemaVersion: 'decision-request.v1',
      risk: f.request,
      runManifestHash: canonicalHash('synthetic:manifest'),
      sourceSnapshotHash: canonicalHash('synthetic:prefix'),
      evidence: [...c.rationaleIds, ...f.request.market.evidenceIds, 'synthetic:regime'].map(
        (id) => ({
          id,
          contentHash: canonicalHash({ origin: 'SYNTHETIC', id }),
          availableAt: c.dataCutoff,
          researchUse: 'ELIGIBLE',
          availabilityBasis: 'OBSERVED',
          origin: 'SYNTHETIC',
        }),
      ),
      regime: { id: 'synthetic:regime', kind: 'TREND', availableAt: c.dataCutoff },
      calibration: null,
      previousHash: canonicalHash('synthetic:decision-genesis'),
    }),
  };
}
describe('Module 11 Iteration 3 decision audit', () => {
  it('tracks conflicts, vetoes, contribution and paired daily correlation without feeding producers', () => {
    const f = fixture(),
      news = makeDecisionRecord(f.policy, f.request, 'test');
    f.request.risk.candidate.portfolio = 'MARKET_ONLY';
    f.request.risk.account.portfolio = 'MARKET_ONLY';
    f.request.risk.candidate.id = 'synthetic:market-conflict';
    f.request.risk.candidate.side = 'SHORT';
    const market = makeDecisionRecord(f.policy, f.request, 'test'),
      daily = ['NEWS_ONLY', 'MARKET_ONLY'].flatMap((portfolio) =>
        [1, 2, 3].map((day) => ({
          portfolio,
          day: `2026-01-0${day}`,
          availableAt: `2026-01-0${day + 1}T00:00:00Z`,
          netPnl: String(day),
          netReturn: `0.0${day}`,
          evidenceHash: canonicalHash({ portfolio, day }),
        })),
      ),
      report = analyzeDecisionArms([news, market], daily, '2026-01-05T00:00:00Z');
    expect(report.signalConflicts).toBe(1);
    expect(report.byArm.find((a) => a.portfolio === 'NEWS_ONLY')!.contributionNetPnl).toBe('6');
    expect(
      report.correlations.find((c) => c.left === 'NEWS_ONLY' && c.right === 'MARKET_ONLY')!.value,
    ).toBeCloseTo(1);
    expect(report.correlations.find((c) => c.left === 'BASELINE')!.value).toBeNull();
    expect(() => analyzeDecisionArms([news, news], [], '2026-01-05T00:00:00Z')).toThrow(
      /Duplicate/,
    );
    expect(() => analyzeDecisionArms([], [daily[0], daily[0]], '2026-01-05T00:00:00Z')).toThrow(
      /Duplicate/,
    );
  });
  it('links sources, feature cutoff, manifest, calibration and risk configuration', () => {
    const f = fixture(),
      r = makeDecisionRecord(f.policy, f.request, 'synthetic:test');
    expect(r.risk.decision.allowed).toBe(true);
    expect(r.risk.decision.sizing.quantity).toBe('2.016');
    expect(r.calibration).toBe('UNCALIBRATED');
    expect(r.request.runManifestHash).toBe(f.request.runManifestHash);
    expect(r.featureCutoff).toBe(f.request.risk.candidate.dataCutoff);
    expect(r.configHash).toBe(canonicalHash(f.policy));
    expect(verifyDecisionRecord(r)).toEqual(r);
  });
  it('blocks restricted and unknown regimes with explicit reasons', () => {
    for (const kind of ['HIGH_VOLATILITY', 'UNKNOWN'] as const) {
      const f = fixture();
      f.request.regime.kind = kind;
      const r = makeDecisionRecord(f.policy, f.request, 'test');
      expect(r.risk.decision.allowed).toBe(false);
      expect(r.finalReasons).toContain('REGIME_RESTRICTED');
    }
  });
  it('does not increase risk from an unbound asserted model probability', () => {
    const f = fixture();
    f.request.risk.candidate.calibration = {
      status: 'KNOWN',
      value: { modelVersion: 'unbound', probability: 1 },
    };
    expect(makeDecisionRecord(f.policy, f.request, 'test').risk.decision.sizing.quantity).toBe(
      '2.016',
    );
  });
  it('rejects future and missing source evidence', () => {
    const f = fixture();
    f.request.evidence[0]!.availableAt = f.request.risk.candidate.validUntil;
    expect(() => makeDecisionRecord(f.policy, f.request, 'test')).toThrow(/evidence/);
    f.request.evidence = [];
    expect(() => makeDecisionRecord(f.policy, f.request, 'test')).toThrow();
  });
  it('rejects audit tampering even if the outer hash is repaired', () => {
    const f = fixture(),
      r = structuredClone(makeDecisionRecord(f.policy, f.request, 'test'));
    r.risk.decision.sizing.quantity = decimal('100');
    const { hash: _, ...body } = r;
    void _;
    r.hash = canonicalHash(body);
    expect(() => verifyDecisionRecord(r)).toThrow(/integrity/);
  });
  it('labels no-risk markouts, retains missingness and counts hindsight vetoed opportunities', () => {
    const f = fixture();
    f.policy.risk.killSwitch = true;
    const r = makeDecisionRecord(f.policy, f.request, 'test'),
      exitAt = fromEpoch(
        utcNanoseconds(r.request.risk.candidate.decisionAt) + 3600n * 1000000000n,
        'nanoseconds',
      ),
      out = {
        candidateId: r.request.risk.candidate.id,
        exitAt,
        availableAt: exitAt,
        netUnitReturn: '0.01',
        evidenceHash: canonicalHash('synthetic:outcome'),
      },
      report = compareRiskCounterfactuals([r], [out], exitAt);
    expect(report.rows[0]!.noRiskUnitMarkout).toBe('0.01');
    expect(report.rows[0]!.withRiskGateUnitMarkout).toBe('0');
    expect(report.hindsightPositiveOpportunitiesVetoed).toBe(1);
    expect(report.fusionImprovement).toContain('NOT_ESTABLISHED');
    expect(compareRiskCounterfactuals([r], [], exitAt).rows[0]!.noRiskUnitMarkout).toBeNull();
    expect(() => compareRiskCounterfactuals([r], [out, out], exitAt)).toThrow(/Duplicate/);
    expect(() => compareRiskCounterfactuals([r], [out], r.featureCutoff)).toThrow(/chronology/);
  });
});
