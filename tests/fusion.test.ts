import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { FusionRunInputSchema } from '@crypto/contracts';
import type { ComponentArm } from '@crypto/contracts';
import { collectFusionRun, fusionFixture, runFusion, verifyFusionReport } from '@crypto/strategies';
import { canonicalHash } from '@crypto/core';

const exec = promisify(execFile);
const arms = ['BASELINE', 'NEWS_ONLY', 'MARKET_ONLY'] as const;
function weighted() {
  const f = fusionFixture();
  f.plan.policy.kind = 'WEIGHTED_CALIBRATED';
  for (const window of f.windows) {
    for (const arm of ['NEWS_ONLY', 'MARKET_ONLY'] as const) {
      const c = window.submissions[arm].candidates[0]!,
        binding = {
          artifactHash: canonicalHash({ arm, calibration: 'SYNTHETIC' }),
          modelVersion: `synthetic:${arm}:calibration`,
          target: 'POSITIVE_NET_RETURN_IN_CANDIDATE_DIRECTION' as const,
          phase: 'VALIDATION' as const,
          sampleEndAt: f.plan.policy.selection.endAt,
          availableAt: f.plan.policy.selection.availableAt,
          horizon: { ...c.horizon },
        };
      for (const candidate of window.submissions[arm].candidates)
        candidate.calibration = {
          status: 'KNOWN',
          value: { modelVersion: binding.modelVersion, probability: 0.8 },
        };
      window.submissions[arm].calibration = binding;
      window.submissions[arm].evidence.push({
        id: `synthetic:calibration:${arm}`,
        contentHash: binding.artifactHash,
        availableAt: binding.availableAt,
        availabilityBasis: 'OBSERVED',
        researchUse: 'ELIGIBLE',
        origin: 'SYNTHETIC',
      });
    }
  }
  return f;
}

describe('Module 11 Iteration 1: independent strategy isolation', () => {
  it('abstains on conflict, deduplicates agreement and retains explicit HOLD', () => {
    const r = runFusion(fusionFixture());
    expect(r.windows.map((w) => [w.reason, w.candidates.FUSION.side])).toEqual([
      ['DIRECTIONAL_CONFLICT', 'HOLD'],
      ['AGREEMENT', 'LONG'],
      ['COMPONENT_HOLD', 'HOLD'],
    ]);
    expect(r.windows[1]!.duplicateCounts).toEqual({ BASELINE: 1, NEWS_ONLY: 1, MARKET_ONLY: 1 });
    expect(Object.values(r.windows[1]!.candidates)).toHaveLength(4);
    expect(r.ordersCreated).toBe(0);
    expect(r.execution).toBe('DISABLED');
    expect(r.assessment).toBe('SYNTHETIC_ONLY');
  });

  it('assigns independent portfolios with equal capital, fees and execution assumptions', () => {
    const r = runFusion(fusionFixture());
    expect(new Set(r.arms.map((a) => a.portfolioId)).size).toBe(4);
    expect(new Set(r.arms.map((a) => a.initialCapital))).toEqual(new Set(['10000']));
    expect(new Set(r.arms.map((a) => a.feeAssumptionsHash)).size).toBe(1);
    expect(new Set(r.arms.map((a) => a.executionAssumptionsHash)).size).toBe(1);
    for (const w of r.windows)
      for (const arm of arms) expect(w.candidates[arm].portfolio).toBe(arm);
  });

  it('does not mutate input and produces immutable byte-reproducible decisions', () => {
    const f = fusionFixture(),
      before = canonicalHash(f),
      r = runFusion(f);
    expect(canonicalHash(runFusion(f))).toBe(canonicalHash(r));
    expect(canonicalHash(f)).toBe(before);
    expect(
      Object.isFrozen(r.input.windows[0]!.submissions.NEWS_ONLY.candidates[0]!.rationaleIds),
    ).toBe(true);
    expect(() => {
      r.windows[0]!.candidates.FUSION.side = 'LONG';
    }).toThrow();
    expect(verifyFusionReport(JSON.parse(JSON.stringify(r)))).toEqual(r);
  });

  it('exposes only frozen own-arm context and shared assumptions to producer ports', () => {
    const f = fusionFixture(),
      calls: ComponentArm[] = [],
      producer =
        (arm: ComponentArm) =>
        (context: Parameters<Parameters<typeof collectFusionRun>[1]['BASELINE']>[0]) => {
          calls.push(arm);
          expect(Object.keys(context).sort()).toEqual(['common', 'opportunity', 'portfolio']);
          expect(context.portfolio).toBe(arm);
          expect(Object.isFrozen(context.common)).toBe(true);
          expect(() => {
            (context as unknown as { pnl: number }).pnl = 10;
          }).toThrow();
          expect('candidates' in context || 'positions' in context || 'outcomes' in context).toBe(
            false,
          );
          return f.windows.find((w) => w.opportunityId === context.opportunity.id)!.submissions[
            arm
          ];
        };
    const r = collectFusionRun(f.plan, {
      BASELINE: producer('BASELINE'),
      NEWS_ONLY: producer('NEWS_ONLY'),
      MARKET_ONLY: producer('MARKET_ONLY'),
    });
    expect(calls).toHaveLength(9);
    expect(r).toEqual(runFusion(f));
  });

  it('parses each callback result immediately so later producers cannot alter it', () => {
    const f = fusionFixture();
    let index = 0;
    const r = collectFusionRun(f.plan, {
      BASELINE: () => f.windows[index]!.submissions.BASELINE,
      NEWS_ONLY: () => f.windows[index]!.submissions.NEWS_ONLY,
      MARKET_ONLY: () => {
        const w = f.windows[index++]!;
        w.submissions.NEWS_ONLY.candidates[0]!.side = 'SHORT';
        return w.submissions.MARKET_ONLY;
      },
    });
    expect(r.windows[0]!.candidates.NEWS_ONLY.side).toBe('LONG');
  });

  it('changing baseline evidence cannot change news/market/fusion directions', () => {
    const f = fusionFixture(),
      before = runFusion(f);
    for (const w of f.windows)
      for (const c of w.submissions.BASELINE.candidates) c.id = `${c.id}-changed`;
    const after = runFusion(f);
    expect(after.windows.map((w) => w.candidates.NEWS_ONLY)).toEqual(
      before.windows.map((w) => w.candidates.NEWS_ONLY),
    );
    expect(after.windows.map((w) => w.candidates.MARKET_ONLY)).toEqual(
      before.windows.map((w) => w.candidates.MARKET_ONLY),
    );
    expect(after.windows.map((w) => w.candidates.FUSION.side)).toEqual(
      before.windows.map((w) => w.candidates.FUSION.side),
    );
  });

  it('uses one fusion candidate referencing both components with earliest expiry', () => {
    const f = fusionFixture(),
      w = f.windows[1]!;
    for (const c of w.submissions.NEWS_ONLY.candidates)
      c.validUntil = '2026-02-02T00:02:30.000000000Z' as typeof c.validUntil;
    const r = runFusion(f),
      out = r.windows[1]!;
    expect(out.candidates.FUSION.rationaleIds).toEqual([
      out.candidates.NEWS_ONLY.id,
      out.candidates.MARKET_ONLY.id,
      r.policyHash,
    ]);
    expect(out.candidates.FUSION.validUntil).toBe('2026-02-02T00:02:30.000000000Z');
  });

  it('materializes missing arm HOLD and never treats missing data as single-direction permission', () => {
    const f = fusionFixture();
    f.plan.policy.kind = 'DISAGREEMENT_HOLD';
    f.windows[1]!.submissions.NEWS_ONLY.candidates = [];
    const w = runFusion(f).windows[1]!;
    expect(w.missingArms).toEqual(['NEWS_ONLY']);
    expect(w.reason).toBe('MISSING_COMPONENT');
    expect(w.candidates.FUSION.side).toBe('HOLD');
    expect(w.candidates.NEWS_ONLY.side).toBe('HOLD');
  });

  it('allows one explicit directional component only under opt-in disagreement policy', () => {
    const f = fusionFixture();
    f.plan.policy.kind = 'DISAGREEMENT_HOLD';
    const r = runFusion(f);
    expect(r.windows[0]!.candidates.FUSION.side).toBe('HOLD');
    expect(r.windows[2]!.reason).toBe('SINGLE_DIRECTION');
    expect(r.windows[2]!.candidates.FUSION.side).toBe('LONG');
  });

  it('requires calibration instead of using arbitrary scores or evidence confidence', () => {
    const f = fusionFixture();
    f.plan.policy.kind = 'WEIGHTED_CALIBRATED';
    for (const arm of ['NEWS_ONLY', 'MARKET_ONLY'] as const)
      for (const c of f.windows[1]!.submissions[arm].candidates)
        c.score = { status: 'KNOWN', value: 1 };
    expect(runFusion(f).windows[1]!.reason).toBe('CALIBRATION_REQUIRED');
  });

  it('uses frozen calibrated directional support but still vetoes opposite signals', () => {
    const r = runFusion(weighted());
    expect(r.windows[0]!.reason).toBe('DIRECTIONAL_CONFLICT');
    expect(r.windows[1]!.reason).toBe('WEIGHTED_SUPPORT');
    expect(r.windows[1]!.weightedScore).toBeCloseTo(0.6);
    expect(r.windows[1]!.candidates.FUSION.calibration.status).toBe('MISSING');
    expect(r.windows[2]!.reason).toBe('CALIBRATION_REQUIRED');
  });

  it('retains HOLD below the predeclared weighted threshold', () => {
    const f = weighted();
    f.plan.policy.minimumWeightedScore = '0.9' as typeof f.plan.policy.minimumWeightedScore;
    expect(runFusion(f).windows[1]!.reason).toBe('BELOW_WEIGHTED_THRESHOLD');
  });

  it.each(['unbound', 'late', 'wrongModel', 'wrongHorizon', 'weak'] as const)(
    'rejects unusable %s calibration with HOLD',
    (kind) => {
      const f = weighted(),
        s = f.windows[1]!.submissions.NEWS_ONLY;
      if (kind === 'unbound') s.evidence.pop();
      if (kind === 'late') s.calibration!.availableAt = f.plan.opportunities[1]!.decisionAt;
      if (kind === 'wrongModel') s.calibration!.modelVersion = 'wrong';
      if (kind === 'wrongHorizon') s.calibration!.horizon.value = 99;
      if (kind === 'weak')
        for (const c of s.candidates)
          c.calibration = {
            status: 'KNOWN',
            value: { modelVersion: s.calibration!.modelVersion, probability: 0.4 },
          };
      expect(runFusion(f).windows[1]!.reason).toBe('CALIBRATION_REQUIRED');
    },
  );

  it.each([
    [
      'descriptive evidence',
      (f: ReturnType<typeof fusionFixture>) => {
        Object.assign(f.windows[0]!.submissions.NEWS_ONLY.evidence[0]!, {
          researchUse: 'DESCRIPTIVE_ONLY',
        });
      },
    ],
    [
      'estimated availability',
      (f: ReturnType<typeof fusionFixture>) => {
        Object.assign(f.windows[0]!.submissions.NEWS_ONLY.evidence[0]!, {
          availabilityBasis: 'ESTIMATED',
        });
      },
    ],
    [
      'synthetic inputs in research cohort',
      (f: ReturnType<typeof fusionFixture>) => {
        f.plan.origin = 'RESEARCH';
      },
    ],
    [
      'changed producer configuration',
      (f: ReturnType<typeof fusionFixture>) => {
        f.windows[0]!.submissions.NEWS_ONLY.candidates[0]!.reproducibility.configHash =
          canonicalHash('other');
      },
    ],
    [
      'changed producer seed',
      (f: ReturnType<typeof fusionFixture>) => {
        f.windows[0]!.submissions.NEWS_ONLY.candidates[0]!.reproducibility.randomSeed++;
      },
    ],
    [
      'noncash baseline',
      (f: ReturnType<typeof fusionFixture>) => {
        f.windows[0]!.submissions.BASELINE.candidates[0]!.side = 'LONG';
      },
    ],
    [
      'TEST selection',
      (f: ReturnType<typeof fusionFixture>) => {
        Object.assign(f.plan.policy.selection, { phase: 'TEST' });
      },
    ],
    [
      'late freeze',
      (f: ReturnType<typeof fusionFixture>) => {
        f.plan.policy.frozenAt = f.plan.opportunities[0]!.decisionAt;
      },
    ],
    [
      'late training',
      (f: ReturnType<typeof fusionFixture>) => {
        f.plan.policy.selection.availableAt = f.plan.opportunities[0]!.decisionAt;
      },
    ],
    [
      'duplicate opportunity',
      (f: ReturnType<typeof fusionFixture>) => {
        f.plan.opportunities[1]!.id = f.plan.opportunities[0]!.id;
      },
    ],
    [
      'missing window',
      (f: ReturnType<typeof fusionFixture>) => {
        f.windows.pop();
      },
    ],
    [
      'reordered window',
      (f: ReturnType<typeof fusionFixture>) => {
        f.windows.reverse();
      },
    ],
    [
      'different snapshot',
      (f: ReturnType<typeof fusionFixture>) => {
        f.windows[0]!.submissions.NEWS_ONLY.snapshotHash = canonicalHash('other');
      },
    ],
    [
      'different execution',
      (f: ReturnType<typeof fusionFixture>) => {
        f.windows[0]!.submissions.NEWS_ONLY.executionAssumptionsHash = canonicalHash('other');
      },
    ],
    [
      'different fee',
      (f: ReturnType<typeof fusionFixture>) => {
        f.windows[0]!.submissions.NEWS_ONLY.candidates[0]!.reproducibility.feeAssumptionsHash =
          canonicalHash('other');
      },
    ],
    [
      'cross-arm portfolio',
      (f: ReturnType<typeof fusionFixture>) => {
        f.windows[0]!.submissions.NEWS_ONLY.candidates[0]!.portfolio = 'MARKET_ONLY';
      },
    ],
    [
      'wrong horizon',
      (f: ReturnType<typeof fusionFixture>) => {
        f.windows[0]!.submissions.NEWS_ONLY.candidates[0]!.horizon.value++;
      },
    ],
    [
      'future evidence',
      (f: ReturnType<typeof fusionFixture>) => {
        f.windows[0]!.submissions.NEWS_ONLY.evidence[0]!.availableAt = f.plan.generatedAt;
      },
    ],
    [
      'missing evidence',
      (f: ReturnType<typeof fusionFixture>) => {
        f.windows[0]!.submissions.NEWS_ONLY.evidence = [];
      },
    ],
    [
      'unknown dataset',
      (f: ReturnType<typeof fusionFixture>) => {
        f.windows[0]!.submissions.NEWS_ONLY.candidates[0]!.reproducibility.datasetHashes = [
          canonicalHash('other'),
        ];
      },
    ],
    [
      'outcome injection',
      (f: ReturnType<typeof fusionFixture>) => {
        Object.assign(f.windows[0]!.submissions.NEWS_ONLY, { pnl: 123 });
      },
    ],
  ])('rejects %s', (_name, mutate) => {
    const f = fusionFixture();
    mutate(f);
    expect(() => runFusion(f)).toThrow();
  });

  it('rejects ambiguous distinct candidates and conflicting duplicates', () => {
    for (const sameId of [false, true]) {
      const f = fusionFixture(),
        s = f.windows[0]!.submissions.NEWS_ONLY,
        c = structuredClone(s.candidates[0]!);
      if (!sameId) c.id = 'synthetic:other-candidate';
      c.side = 'SHORT';
      s.candidates.push(c);
      expect(() => runFusion(f)).toThrow(/duplicate|ambiguous/);
    }
  });

  it('rejects globally ambiguous candidate identities', () => {
    const f = fusionFixture();
    f.windows[0]!.submissions.NEWS_ONLY.candidates[0]!.id =
      f.windows[0]!.submissions.MARKET_ONLY.candidates[0]!.id;
    expect(() => runFusion(f)).toThrow(/reused/);
  });

  it('rejects a shared evidence identity with conflicting contents', () => {
    const f = fusionFixture(),
      source = f.windows[0]!.submissions.NEWS_ONLY.evidence[0]!;
    f.windows[0]!.submissions.MARKET_ONLY.evidence.push({
      ...source,
      contentHash: canonicalHash('conflicting'),
    });
    expect(() => runFusion(f)).toThrow(/evidence identity/);
  });

  it('detects modified decisions even when their chain hashes are repaired', () => {
    const r = structuredClone(runFusion(fusionFixture()));
    r.windows[0]!.candidates.FUSION.side = 'LONG';
    let head = r.windows[0]!.previousHash;
    for (const w of r.windows) {
      w.previousHash = head;
      const { hash: _, ...body } = w;
      void _;
      w.hash = canonicalHash(body);
      head = w.hash;
    }
    r.logHead = head;
    expect(() => verifyFusionReport(r)).toThrow(/semantic integrity/);
  });

  it('keeps persisted schema strict and earlier candidate formats unchanged', () => {
    expect(FusionRunInputSchema.safeParse(fusionFixture()).success).toBe(true);
    expect(FusionRunInputSchema.safeParse({ ...fusionFixture(), positions: [] }).success).toBe(
      false,
    );
  });

  it('runs and verifies an exclusive CLI artifact and rejects accidental overwrite', async () => {
    const root = await mkdtemp(join(tmpdir(), 'crypto-fusion-'));
    try {
      const file = join(root, 'report.json'),
        cli = ['--import', 'tsx', 'apps/cli/src/fusion.ts'];
      const result = await exec(process.execPath, [...cli, 'fixture', '--out', file]);
      expect(result.stdout).toContain('DIRECTIONAL_CONFLICT');
      const artifact: unknown = JSON.parse(await readFile(file, 'utf8'));
      expect(verifyFusionReport(artifact).ordersCreated).toBe(0);
      expect((await exec(process.execPath, [...cli, 'verify', '--report', file])).stdout).toContain(
        '"valid": true',
      );
      await expect(exec(process.execPath, [...cli, 'fixture', '--out', file])).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);
});
