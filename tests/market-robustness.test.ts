import { mkdtemp, readFile, writeFile, cp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import {
  MarketRobustnessPlanSchema,
  RobustEvidenceSchema,
  MarketBarSchema,
} from '@crypto/contracts';
import type {
  MarketMlModel,
  MarketRobustnessPlan,
  RobustAttempt,
  RobustEvidence,
  RobustJournalEntry,
} from '@crypto/contracts';
import { canonicalHash, canonicalJson, decimal, deterministicId } from '@crypto/core';
import { marketMlFixture, trainMarketModel, MarketSignalProvider } from '@crypto/strategies';
import type { MarketSignalProvider as ProducerPort } from '@crypto/strategies';
import {
  writeDatasetPanel,
  SnapshotTechnicalFeatures,
  technicalFeatureFixture,
} from '@crypto/research';
import {
  robustnessFixture,
  validateRobustnessPlan,
  runMarketRobustness,
  writeMarketRobustness,
  verifyMarketRobustness,
  rankRobustness,
  holmAdjusted,
  selectRobustness,
  projectLongOnlyTargets,
} from '@crypto/backtest';
let root: string, base: MarketRobustnessPlan, withModel: MarketRobustnessPlan, model: MarketMlModel;
let sample: Awaited<ReturnType<typeof runMarketRobustness>>,
  bundle: Awaited<ReturnType<typeof writeMarketRobustness>>;
const evidence: RobustEvidence[] = [],
  entries: RobustJournalEntry[] = [];
function small(
  ids = ['MA_2_4', 'MA_3_5'],
  scenarios = ['BTC_WHIPSAW_BASE', 'BTC_WHIPSAW_HIGH_COST'],
  source = base,
) {
  const p = structuredClone(source);
  p.trials = p.trials.filter((t) => ids.includes(t.id));
  p.scenarios = p.scenarios.filter((s) => scenarios.includes(s.id));
  p.models = p.models.filter((m) => p.trials.some((t) => t.modelId === m.id));
  return p;
}
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'crypto-robustness-'));
  base = robustnessFixture();
  const f = marketMlFixture(),
    p = await writeDatasetPanel(
      f.input,
      f.request,
      join(root, 'panels'),
      'synthetic:market-ml-source.v1',
    );
  model = (await trainMarketModel(p.directory, f.config, 'synthetic:test')).model;
  withModel = robustnessFixture([model]);
  sample = await runMarketRobustness(small(), 'synthetic:test', {
    journal: (e) => {
      entries.push(e);
      return Promise.resolve();
    },
    evidence: (name, value) => {
      if (name.startsWith('robust-evidence_')) evidence.push(RobustEvidenceSchema.parse(value));
      return Promise.resolve();
    },
  });
  bundle = await writeMarketRobustness(
    small(['MA_2_4'], ['BTC_WHIPSAW_BASE']),
    join(root, 'bundle'),
    'synthetic:test',
  );
}, 120000);
afterAll(async () => {
  if (root) {
    if (
      dirname(resolve(root)) !== resolve(tmpdir()) ||
      !basename(root).startsWith('crypto-robustness-')
    )
      throw new Error('Unsafe cleanup');
    await rm(root, { recursive: true, force: true });
  }
});
function fake(
  trialId: string,
  scenarioId: string,
  net: number,
  dd: number,
  increments: number[],
): RobustAttempt {
  const source = structuredClone(sample.report.attempts[0]!);
  return {
    ...source,
    trialId,
    scenarioId,
    metrics: {
      ...source.metrics!,
      netReturn: decimal(String(net)),
      maxDrawdownFraction: decimal(String(dd)),
    },
    cashNetReturn: 0,
    buyAndHoldNetReturn: 0,
    increments,
  };
}
describe('predeclared trial and source policies', () => {
  it('contains all nine base cells plus explicit cost and volatility stress', () => {
    expect(base.scenarios.filter((s) => s.stress === 'BASE')).toHaveLength(9);
    expect(new Set(base.scenarios.map((s) => s.asset)).size).toBe(3);
    expect(new Set(base.scenarios.map((s) => s.regime)).size).toBe(3);
    expect(base.scenarios.map((s) => s.stress)).toContain('COST_AND_VOLATILITY');
  });
  it('exports a structural MarketSignalProvider port and compatible constructor', () => {
    const provider: ProducerPort = {
      descriptor: { id: 'synthetic:port', version: '1', portfolio: 'BASELINE', config: {} },
      initialState: () => ({}),
      strategy() {
        return {
          descriptor: this.descriptor,
          initialState: () => this.initialState(),
          onEvent: () => ({ state: {}, candidates: [] }),
        };
      },
    };
    expect(provider.strategy().descriptor.id).toBe('synthetic:port');
    expect(typeof MarketSignalProvider).toBe('function');
  });
  it('rejects duplicate identities and unknown producer fingerprints', () => {
    const p = small();
    p.trials.push(p.trials[0]!);
    expect(() => validateRobustnessPlan(p)).toThrow(/Duplicate/);
    const q = small();
    q.trials[0]!.provider = null;
    q.trials[0]!.modelId = 'missing';
    expect(() => validateRobustnessPlan(q)).toThrow(/Unknown/);
  });
  it('requires changes to reference an earlier immutable trial', () => {
    const p = small();
    p.trials[1]!.parentTrialId = 'missing';
    expect(() => validateRobustnessPlan(p)).toThrow(/lineage/);
  });
  it('rejects synthetic symmetric shorts from costed runs', () => {
    const p = small();
    p.trials[0]!.provider = {
      ...p.trials[0]!.provider!,
      kind: 'SYMMETRIC_MA_FIXTURE',
    } as (typeof p.trials)[0]['provider'];
    expect(() => validateRobustnessPlan(p)).toThrow(/non-executable/);
  });
  it('rejects source tampering and unfair quantity changes', () => {
    const p = small();
    p.scenarios[0]!.manifest.backtest.input.replay.bars.pop();
    expect(() => validateRobustnessPlan(p)).toThrow(/frozen/);
    const q = small();
    q.scenarios[1]!.manifest.backtest.quantity = decimal('2');
    expect(() => validateRobustnessPlan(q)).toThrow(/quantity/);
  });
  it('rejects late declaration, incomparable clocks and missing base stress lineage', () => {
    const p = small();
    p.declaredAt = p.generatedAt;
    expect(() => validateRobustnessPlan(p)).toThrow(/clock/);
    const q = small();
    q.scenarios[1]!.parentScenarioId = 'missing';
    expect(() => validateRobustnessPlan(q)).toThrow(/matching base/);
  });
  it('rejects models published after experiment declaration', () => {
    const p = small(['ML_H2_CONTROL'], ['BTC_WHIPSAW_BASE'], withModel);
    p.declaredAt = p.scenarios[0]!.manifest.backtest.assumptions.declaredAt;
    const later = structuredClone(model);
    later.availableAt = p.generatedAt;
    later.config.generatedAt = p.generatedAt;
    const { id, ...body } = later;
    void id;
    later.id = deterministicId('market-logistic', body);
    p.trials[0]!.modelId = later.id;
    p.models = [later];
    expect(() => validateRobustnessPlan(p)).toThrow(/unavailable/);
  });
  it('forbids labelling an unchanged model as a retrained feature ablation', () => {
    const p = small(['ML_H2_CONTROL'], ['BTC_WHIPSAW_BASE'], withModel);
    p.trials.push({
      ...p.trials[0]!,
      id: 'fake_ablation',
      parentTrialId: 'ML_H2_CONTROL',
      change: 'FEATURE_ABLATION',
    });
    expect(() => validateRobustnessPlan(p)).toThrow(/strict feature subset/);
  });
  it('allows only bounded bootstrap/work policies', () => {
    expect(() =>
      MarketRobustnessPlanSchema.parse({ ...base, policy: { ...base.policy, resamples: 1000000 } }),
    ).toThrow();
    expect(() =>
      MarketRobustnessPlanSchema.parse({
        ...base,
        policy: { ...base.policy, syntheticPromotion: 'ALLOW' },
      }),
    ).toThrow();
  });
});
describe('attempt accounting, causal execution and immutable evidence', () => {
  it('journals every planned cell before execution begins', () => {
    expect(sample.report.attemptCount).toBe(4);
    const start = entries.findIndex((e) => e.state === 'STARTED');
    expect(entries.slice(0, start).filter((e) => e.trialId !== null)).toHaveLength(4);
    expect(entries.filter((e) => e.state === 'COMPLETE')).toHaveLength(4);
    expect(entries.at(-1)!.state).toBe('FINALIZED');
    for (let i = 1; i < entries.length; i++)
      expect(entries[i]!.previousHash).toBe(entries[i - 1]!.hash);
  });
  it('uses the full attempted family, including declared previous trials', () => {
    expect(sample.report.familySize).toBe(base.priorTrialCount + 4);
    expect(sample.report.attempts.every((a) => a.status === 'COMPLETE')).toBe(true);
    expect(sample.report.selection.every((s) => s.status === 'ARCHIVED')).toBe(true);
  });
  it('preserves fees, negative whipsaw results and paired independent controls', () => {
    for (const a of sample.report.attempts) {
      expect(Number(a.metrics!.fees)).toBeGreaterThan(0);
      expect(Number(a.metrics!.netReturn)).toBeLessThan(0);
      expect(a.cashNetReturn).toBe(0);
    }
    const first = sample.report.attempts.find(
        (a) => a.trialId === 'MA_2_4' && a.scenarioId.endsWith('_BASE'),
      )!,
      stress = sample.report.attempts.find(
        (a) => a.trialId === 'MA_2_4' && a.scenarioId.endsWith('HIGH_COST'),
      )!;
    expect(Number(stress.metrics!.netReturn)).toBeLessThan(Number(first.metrics!.netReturn));
  });
  it('makes parameter instability visible rather than retaining only the better chart', () => {
    expect(sample.report.instability).toHaveLength(1);
    expect(sample.report.instability[0]!.comparedSignalEvents).toBeGreaterThan(0);
    expect(sample.report.instability[0]!.changedSignalEvents).toBeGreaterThan(0);
    expect(sample.report.instability[0]!.maxAbsoluteNetDelta).toBeGreaterThan(0);
  });
  it('keeps raw model forecasts separate from projected long-only execution targets', async () => {
    const p = small(['ML_H2_CONTROL'], ['BTC_WHIPSAW_BASE'], withModel),
      captured: RobustEvidence[] = [];
    const r = await runMarketRobustness(p, 'synthetic:test', {
      journal: () => Promise.resolve(),
      evidence: (name, v) => {
        if (name.startsWith('robust-evidence_')) captured.push(RobustEvidenceSchema.parse(v));
        return Promise.resolve();
      },
    });
    const e = captured[0]!;
    expect(
      e.projectedCandidates.every(
        (c) => c.score.status === 'KNOWN' && [0, 1].includes(c.score.value),
      ),
    ).toBe(true);
    expect(e.projectedCandidates[0]!.id).not.toBe(e.originalReplay.candidates[0]!.id);
    expect(e.projectedCandidates[0]!.rationaleIds).toContain(e.originalReplay.candidates[0]!.id);
    expect(e.projectedCandidates.map((c) => c.validUntil)).toEqual(
      e.originalReplay.candidates.map((c) => c.validUntil),
    );
    expect(r.report.importedCalibrationTrials).toBe(4);
    expect(r.report.attempts[0]!.metrics!.fillCount).toBe(0);
  }, 60000);
  it('preserves original candidates when projecting abstention to flat', () => {
    const original = evidence[0]!.originalReplay,
      before = canonicalHash(original),
      projected = projectLongOnlyTargets(original);
    expect(canonicalHash(original)).toBe(before);
    expect(projected.every((p, i) => p.id !== original.candidates[i]!.id)).toBe(true);
  });
  it('retains every failed runtime attempt in the journal and ranking family', async () => {
    const p = small(['MA_2_4'], ['BTC_WHIPSAW_BASE']),
      b = p.scenarios[0]!.manifest.backtest;
    b.input.replay.bars.push(structuredClone(b.input.replay.bars[0]!));
    b.inputHash = canonicalHash(b.input);
    const r = await runMarketRobustness(p, 'synthetic:test');
    expect(r.report.attempts[0]!.status).toBe('FAILED');
    expect(r.report.familySize).toBe(base.priorTrialCount + 1);
    expect(r.journal.some((j) => j.state === 'FAILED')).toBe(true);
    expect(r.report.rankings[0]!.score).toBeNull();
  }, 30000);
  it('does not turn evidence-storage failure into a successful research report', async () => {
    const events: RobustJournalEntry[] = [];
    await expect(
      runMarketRobustness(small(['MA_2_4'], ['BTC_WHIPSAW_BASE']), 'synthetic:test', {
        journal: (e) => {
          events.push(e);
          return Promise.resolve();
        },
        evidence: () => Promise.reject(new Error('synthetic disk fault')),
      }),
    ).rejects.toThrow(/persistence/);
    expect(events.at(-1)!.state).toBe('STARTED');
    expect(events.some((e) => e.state === 'FINALIZED')).toBe(false);
  }, 30000);
});
describe('risk-adjusted ranking and honest joint uncertainty', () => {
  it('enforces the two-candidate cap and refuses an omitted case despite hypothetical passing statistics', () => {
    const p = structuredClone(base);
    p.trials = p.trials.slice(0, 3);
    const rs = p.trials.map((t, i) => ({
      ...structuredClone(sample.report.rankings[0]!),
      trialId: t.id,
      rank: i + 1,
      meanNetReturn: 0.02,
      score: 0.01,
      worstDrawdown: 0.01,
      tailCvar05: 0.01,
      uncertainty: {
        marginal95: { lower: 0.01, upper: 0.03 },
        rawP: 0.0001,
        holmP: 0.001,
        blockCount: 10,
        reason: 'CONDITIONAL_APPROXIMATION' as const,
      },
    }));
    const attempts = p.trials.flatMap((t) =>
        p.scenarios.map((s) => fake(t.id, s.id, 0.02, 0.01, [0.02])),
      ),
      fps = new Map(
        attempts.map((a) => [
          a.trialId,
          { producerHash: a.producerHash, featureHash: a.featureHash },
        ]),
      );
    const selected = selectRobustness(rs, p, false, attempts, fps);
    expect(selected.filter((s) => s.status === 'FORWARD_RESEARCH_CANDIDATE')).toHaveLength(2);
    expect(selected[2]!.reasons).toContain('PREDECLARED_CANDIDATE_CAP');
    expect(selectRobustness(rs, p, false, attempts.slice(1), fps)[0]!.reasons).toContain(
      'FAILED_OR_INACTIVE_CASE',
    );
  });
  it('matches hand-calculated net, drawdown and empirical loss-tail penalties', () => {
    const attempts = [
      fake('A', 'one', 0.1, 0.1, [0.1, 0]),
      fake('A', 'two', -0.04, 0.07, [-0.04, 0]),
    ];
    const r = rankRobustness({
      attempts,
      trialIds: ['A'],
      familySize: 1,
      randomSeed: 42,
      policy: base.policy,
    })[0]!;
    expect(r.meanNetReturn).toBeCloseTo(0.03, 12);
    expect(r.tailCvar05).toBe(-0.04);
    expect(r.worstDrawdown).toBe(0.1);
    expect(r.score).toBeCloseTo(-0.11, 12);
  });
  it('computes monotone Holm adjustment and counts unobserved/failed hypotheses', () => {
    expect(holmAdjusted([0.01, 0.04, 0.03], 3)).toEqual([0.03, 0.06, 0.06]);
    const padded = holmAdjusted([0.01, 0.04, 0.03], 5);
    expect(padded[0]).toBe(0.05);
    expect(padded[1]).toBe(0.12);
    expect(holmAdjusted([0.001, 1], 100)[0]).toBe(0.1);
    expect(() => holmAdjusted([0.1], 0)).toThrow();
  });
  it('does not manufacture precision by treating stress copies as new time blocks', () => {
    const a = fake('A', 'one', 0.06, 0.01, [0.02, -0.01, 0.02, -0.01, 0.02, 0.02]),
      r = rankRobustness({
        attempts: [a, { ...a, scenarioId: 'copy' }],
        trialIds: ['A'],
        familySize: 2,
        randomSeed: 42,
        policy: base.policy,
      })[0]!;
    expect(r.uncertainty.blockCount).toBe(2);
    expect(r.uncertainty.rawP).toBeNull();
    expect(r.uncertainty.reason).toBe('INSUFFICIENT_BLOCKS');
  });
  it('reproduces conditional block draws with fixed seed and keeps marginal intervals labelled', () => {
    const increments = Array.from({ length: 36 }, (_, i) => (i % 3 === 0 ? -0.001 : 0.002)),
      a = fake(
        'A',
        'one',
        increments.reduce((s, v) => s + v, 0),
        0.01,
        increments,
      ),
      q = {
        attempts: [a],
        trialIds: ['A'],
        familySize: 1,
        randomSeed: 42,
        policy: { ...base.policy, resamples: 256 },
      };
    const r = rankRobustness(q);
    expect(r).toEqual(rankRobustness(q));
    expect(r[0]!.uncertainty.reason).toBe('CONDITIONAL_APPROXIMATION');
    expect(r[0]!.uncertainty.marginal95!.lower).toBeLessThanOrEqual(
      r[0]!.uncertainty.marginal95!.upper,
    );
  });
  it('flat returns have unknown inference rather than infinite risk-adjusted confidence', () => {
    const a = fake('A', 'one', 0, 0, Array<number>(36).fill(0)),
      r = rankRobustness({
        attempts: [a],
        trialIds: ['A'],
        familySize: 1,
        randomSeed: 42,
        policy: base.policy,
      })[0]!;
    expect(r.score).toBe(0);
    expect(r.uncertainty.reason).toBe('ZERO_VARIANCE');
    expect(r.uncertainty.rawP).toBeNull();
  });
  it('blocks inference when resample resolution cannot support the family threshold', () => {
    const increments = Array.from({ length: 36 }, (_, i) => (i % 2 ? 0.002 : -0.001)),
      a = fake(
        'A',
        'one',
        increments.reduce((s, v) => s + v, 0),
        0.01,
        increments,
      ),
      r = rankRobustness({
        attempts: [a],
        trialIds: ['A'],
        familySize: 10000,
        randomSeed: 42,
        policy: { ...base.policy, resamples: 200 },
      })[0]!;
    expect(r.uncertainty.reason).toBe('MONTE_CARLO_RESOLUTION');
    expect(r.uncertainty.holmP).toBeNull();
  });
  it('unknown marks keep scores and uncertainty explicitly unknown', () => {
    const a = fake('A', 'one', 0.1, 0.1, [null as unknown as number, 0.1]);
    a.metrics!.maxDrawdownFraction = null;
    const r = rankRobustness({
      attempts: [a],
      trialIds: ['A'],
      familySize: 1,
      randomSeed: 42,
      policy: base.policy,
    })[0]!;
    expect(r.score).toBeNull();
    expect(r.rank).toBeNull();
    expect(r.uncertainty.marginal95).toBeNull();
  });
  it('rejects duplicate, omitted and numerically unreconciled attempted cells', () => {
    const a = fake('A', 'one', 0.1, 0.1, [0.1]);
    expect(() =>
      rankRobustness({
        attempts: [a, a],
        trialIds: ['A'],
        familySize: 2,
        randomSeed: 42,
        policy: base.policy,
      }),
    ).toThrow(/duplicated/);
    expect(() =>
      rankRobustness({
        attempts: [a],
        trialIds: ['A', 'B'],
        familySize: 2,
        randomSeed: 42,
        policy: base.policy,
      }),
    ).toThrow(/matrix/);
    expect(() =>
      rankRobustness({
        attempts: [{ ...a, increments: [0.9] }],
        trialIds: ['A'],
        familySize: 2,
        randomSeed: 42,
        policy: base.policy,
      }),
    ).toThrow(/reconcile/);
  });
  it('archives synthetic candidates even with positive scores and hypothetical significant bounds', () => {
    const r = structuredClone(sample.report.rankings);
    r[0]!.score = 1;
    r[0]!.worstDrawdown = 0;
    r[0]!.tailCvar05 = 0.1;
    r[0]!.uncertainty.holmP = 0.001;
    r[0]!.uncertainty.marginal95 = { lower: 0.01, upper: 0.1 };
    const fps = new Map(
      sample.report.attempts.map((a) => [
        a.trialId,
        { producerHash: a.producerHash, featureHash: a.featureHash },
      ]),
    );
    expect(
      selectRobustness(r, base, true, sample.report.attempts, fps).every(
        (v) => v.status === 'ARCHIVED',
      ),
    ).toBe(true);
  });
});
describe('immutable bundles and backwards-compatible features', () => {
  it('small feature caches preserve dataset identity, content and decision cutoffs', () => {
    const f = technicalFeatureFixture(),
      q = {
        schemaVersion: 'technical-feature-query.v1',
        series: f.request.series,
        intervalSeconds: 60,
        historyStartCloseAt: f.request.historyStartCloseAt,
        featureAsOf: f.request.featureAsOf.at(-1)!,
        config: f.request.config,
      },
      a = new SnapshotTechnicalFeatures(f.input),
      first = a.query(q);
    expect(a.query(q)).toEqual(first);
    const changed = structuredClone(f.input);
    changed.bars[8] = MarketBarSchema.parse({ ...changed.bars[8], close: '18', high: '19' });
    const second = new SnapshotTechnicalFeatures(changed).query(q);
    expect(second.datasetHash).not.toBe(first.datasetHash);
    expect(second.features.find((v) => v.featureId === 'sma')!.value).not.toBe(
      first.features.find((v) => v.featureId === 'sma')!.value,
    );
    expect(a.query({ ...q, featureAsOf: f.request.featureAsOf[2] }).request.featureAsOf).not.toBe(
      first.request.featureAsOf,
    );
  });
  it('semantically verifies every artifact, raw replay, projected target and journal', async () => {
    expect((await verifyMarketRobustness(bundle.directory)).hash).toBe(bundle.hash);
    const archive = JSON.parse(
      await readFile(join(bundle.directory, 'evidence', 'robust-archive.json'), 'utf8'),
    ) as { archived: unknown[] };
    expect(archive.archived).toHaveLength(1);
    expect(Object.isFrozen(sample.report)).toBe(true);
  }, 60000);
  it('reproduces all original report and evidence bytes from equivalent plans', async () => {
    const b = await writeMarketRobustness(
      JSON.parse(canonicalJson(bundle.report.plan)),
      join(root, 'reproduced'),
      'synthetic:test',
    );
    expect(b.hash).toBe(bundle.hash);
    for (const file of [...Object.keys(bundle.metadata.files), 'bundle.json'])
      expect(await readFile(join(b.directory, ...file.split('/')))).toEqual(
        await readFile(join(bundle.directory, ...file.split('/'))),
      );
  }, 60000);
  it('rejects rewritten trial journals even if the attacker recomputes byte checksums', async () => {
    const d = join(root, 'forged', basename(bundle.directory));
    await cp(bundle.directory, d, { recursive: true });
    const path = join(d, 'journal.jsonl'),
      text = await readFile(path, 'utf8'),
      forged = text.replace('STARTED', 'FAILED');
    await writeFile(path, forged);
    const metadata = JSON.parse(await readFile(join(d, 'bundle.json'), 'utf8')) as {
      files: Record<string, string>;
    };
    metadata.files['journal.jsonl'] = `sha256:${createHash('sha256').update(forged).digest('hex')}`;
    await writeFile(join(d, 'bundle.json'), canonicalJson(metadata));
    await expect(verifyMarketRobustness(d)).rejects.toThrow(/journal/);
  }, 60000);
  it('refuses to erase or bypass an unfinished synced experiment stage', async () => {
    const out = join(root, 'unfinished');
    await mkdir(join(out, '.robustness-stage-synthetic'), { recursive: true });
    await writeFile(
      join(out, '.robustness-stage-synthetic', 'journal.jsonl'),
      'synthetic partial evidence\n',
    );
    await expect(writeMarketRobustness(bundle.report.plan, out, 'synthetic:test')).rejects.toThrow(
      /Unfinished/,
    );
    expect(await readFile(join(out, '.robustness-stage-synthetic', 'journal.jsonl'), 'utf8')).toBe(
      'synthetic partial evidence\n',
    );
  });
  it('requires a parent receipt and a new experiment version for changes', async () => {
    const p = structuredClone(bundle.report.plan);
    p.parentReportHash = bundle.hash;
    await expect(
      writeMarketRobustness(p, join(root, 'no-parent'), 'synthetic:test'),
    ).rejects.toThrow(/Parent/);
    await expect(
      writeMarketRobustness(p, join(root, 'bad-parent'), 'synthetic:test', bundle.directory),
    ).rejects.toThrow(/lineage/);
  }, 60000);
  it('CLI rejects live flags and missing plans before publishing a trial', () => {
    for (const args of [
      ['fixture', '--live', 'true'],
      ['run', '--out', join(root, 'bad-cli')],
    ]) {
      const r = spawnSync(
        process.execPath,
        ['--import', 'tsx', 'apps/cli/src/robustness.ts', ...args],
        { encoding: 'utf8', timeout: 20000 },
      );
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('Robustness failed');
    }
  }, 50000);
});
