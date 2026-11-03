import { mkdtemp, readFile, writeFile, rm, cp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import {
  MarketMlConfigSchema,
  MarketMlReportSchema,
  MarketBarSchema,
  MarketStrategySourceSchema,
} from '@crypto/contracts';
import type { MarketMlModel, MarketMlReport, PanelFeatureCell } from '@crypto/contracts';
import { canonicalHash, canonicalJson, fromEpoch, SeededRandom } from '@crypto/core';
import { writeDatasetPanel, buildTechnicalFeatureArtifact } from '@crypto/research';
import {
  marketMlFixture,
  trainMarketModel,
  validateMarketModel,
  inferMarketModel,
  createMarketMlStrategy,
  classifyMarketReturn,
  writeMarketModel,
  verifyMarketModel,
} from '@crypto/strategies';
import { executeReplay } from '@crypto/backtest';
import { prepareMlRows } from '../packages/strategies/src/market-ml-data.js';
import {
  softmax,
  logits,
  fitLogistic,
  logLoss,
  forecast,
} from '../packages/strategies/src/market-ml-math.js';
const at = (s: number) => fromEpoch(1767225600n + BigInt(s), 'seconds');
let root: string,
  f: ReturnType<typeof marketMlFixture>,
  panel: Awaited<ReturnType<typeof writeDatasetPanel>>,
  report: MarketMlReport,
  model: MarketMlModel;
let bundle: Awaited<ReturnType<typeof writeMarketModel>>;
let future: ReturnType<typeof buildTechnicalFeatureArtifact>,
  source: ReturnType<typeof MarketStrategySourceSchema.parse>;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'crypto-market-ml-'));
  f = marketMlFixture();
  panel = await writeDatasetPanel(
    f.input,
    f.request,
    join(root, 'panels'),
    'synthetic:market-ml-source.v1',
  );
  bundle = await writeMarketModel(panel.directory, f.config, join(root, 'a'), 'synthetic:test');
  report = bundle.report;
  model = report.model;
  const a = f.input.technicalArtifacts[0]!,
    last = a.input.bars.at(-1)!;
  const extra = Array.from({ length: 7 }, (_, i) => {
    const price = String(Number(last.close) + i + 1);
    return MarketBarSchema.parse({
      ...last,
      id: `synthetic:ml:future:${i + 1}`,
      openAt: at(5760 + i * 60),
      closeAt: at(5820 + i * 60),
      availableAt: at(5820 + i * 60),
      open: price,
      high: price,
      low: price,
      close: price,
      provenance: {
        ...last.provenance,
        capturedAt: at(5820 + i * 60),
        parentIds: [canonicalHash({ recipe: 'synthetic-forward-ml.v1', i, price })],
      },
    });
  });
  future = buildTechnicalFeatureArtifact(
    { ...a.input, bars: [...a.input.bars, ...extra] },
    { ...a.request, featureAsOf: [at(5940), at(6060), at(6120)], generatedAt: at(6240) },
    'synthetic:forward-test',
  );
  const binding = f.input.bindings[0]!;
  source = MarketStrategySourceSchema.parse({
    schemaVersion: 'market-strategy-source.v1',
    market: f.input.market,
    sourceId: binding.sourceId,
    instrumentKey: binding.instrumentKey,
    series: binding.series,
    portfolio: 'BASELINE',
    intervalSeconds: 60,
    historyStartCloseAt: at(60),
    maxBarDelayMs: 30000,
  });
}, 60000);
afterAll(async () => {
  if (root) {
    if (
      dirname(resolve(root)) !== resolve(tmpdir()) ||
      !basename(root).startsWith('crypto-market-ml-')
    )
      throw new Error('Unsafe cleanup');
    await rm(root, { recursive: true, force: true });
  }
});
function query(index = 1) {
  const row = future.rows[index]!,
    features: PanelFeatureCell[] = model.featureSchema.map((s) => {
      const v = row.features.find((f) => `technical.${f.featureId}` === s.name)!;
      return {
        name: s.name,
        value: v.value,
        status: v.status,
        definitionHash: s.definitionHash,
        sourceKind: 'TECHNICAL',
        dependency: 'MARKET',
        sourceHashes: [row.datasetHash],
        inputBarIds: v.inputBarIds,
        maxInputAvailableAt: v.maxInputAvailableAt,
        maxInputEventAt: v.maxInputCloseAt,
      };
    });
  return {
    schemaVersion: 'market-ml-inference.v1',
    instrumentKey: source.instrumentKey,
    featureAsOf: row.request.featureAsOf,
    decisionAt: row.request.featureAsOf,
    features,
  };
}
function rows() {
  return structuredClone(panel.rows);
}
describe('fixed horizon labels and temporal leakage gates', () => {
  it.each([
    ['0.0025', 'HOLD'],
    ['-0.0025', 'HOLD'],
    ['0.00250000001', 'UP'],
    ['-0.00250000001', 'DOWN'],
    ['0', 'HOLD'],
  ] as const)('classifies %s with an inclusive 25 bps abstention band', (value, expected) => {
    expect(classifyMarketReturn({ value, abstentionReturnBps: '25' })).toBe(expected);
  });
  it('rejects invalid label/config parameters and unregistered predictors', () => {
    expect(() => classifyMarketReturn({ value: 'NaN', abstentionReturnBps: '25' })).toThrow();
    expect(() =>
      MarketMlConfigSchema.parse({ ...f.config, featureColumns: ['label.future_return'] }),
    ).toThrow();
    expect(() => MarketMlConfigSchema.parse({ ...f.config, leverage: '2' })).toThrow();
    expect(() =>
      MarketMlConfigSchema.parse({
        ...f.config,
        featureColumns: ['technical.return_1', 'technical.return_1'],
      }),
    ).toThrow();
  });
  it('retains purge and global embargo exclusions from the frozen Parquet', () => {
    expect(panel.artifact.audit.purgedCount).toBeGreaterThan(0);
    expect(panel.artifact.audit.embargoedCount).toBeGreaterThan(0);
    expect(panel.rows.every((r) => r.status === 'INCLUDED')).toBe(true);
    expect(report.audit).toMatchObject({ trainRows: 99, validationRows: 63, testRows: 66 });
  });
  it('rejects train/validation boundary-touching label support', () => {
    const r = rows(),
      row = r.find((r) => r.split === 'TRAIN')!;
    row.labels[0]!.availableAt = f.request.splits.validation.from;
    expect(() => prepareMlRows(panel.artifact, r, f.config)).toThrow(/held-out/);
  });
  it('rejects validation/test boundary-touching labels', () => {
    const r = rows(),
      row = r.find((r) => r.split === 'VALIDATION')!;
    row.labels[0]!.availableAt = f.request.splits.test.from;
    expect(() => prepareMlRows(panel.artifact, r, f.config)).toThrow(/held-out/);
  });
  it('rejects labels published after the fitting cutoff', () => {
    expect(() =>
      prepareMlRows(panel.artifact, panel.rows, { ...f.config, fitCutoff: at(1000) }),
    ).toThrow(/fitting cutoff/);
    expect(() =>
      prepareMlRows(panel.artifact, panel.rows, { ...f.config, calibrationCutoff: at(3000) }),
    ).toThrow(/fitting cutoff/);
  });
  it('rejects spoofed split membership and duplicate row identities', () => {
    const r = rows();
    r[0]!.split = 'TEST';
    expect(() => prepareMlRows(panel.artifact, r, f.config)).toThrow(/split mismatch/);
    expect(() => prepareMlRows(panel.artifact, [...panel.rows, panel.rows[0]!], f.config)).toThrow(
      /Duplicate/,
    );
  });
  it('rejects future input watermarks and target-as-feature leakage', () => {
    const r = rows();
    r[0]!.features[0]!.maxInputAvailableAt = at(6000);
    expect(() => prepareMlRows(panel.artifact, r, f.config)).toThrow(/leakage/);
    const target = rows();
    target[0]!.features[0]!.dependency = 'LABEL';
    expect(() => prepareMlRows(panel.artifact, target, f.config)).toThrow(/leakage/);
  });
  it('rejects unfrozen, missing and unsupported-horizon labels', () => {
    const r = rows();
    r[0]!.labels[0]!.availableAt = at(7000);
    expect(() => prepareMlRows(panel.artifact, r, f.config)).toThrow(/label/);
    expect(() =>
      prepareMlRows(panel.artifact, panel.rows, { ...f.config, horizonBars: 3 }),
    ).toThrow(/horizon/);
  });
  it('rejects late fitting clocks and publication before snapshot freeze', () => {
    expect(() =>
      prepareMlRows(panel.artifact, panel.rows, { ...f.config, fitCutoff: at(2700) }),
    ).toThrow(/splits/);
    expect(() =>
      prepareMlRows(panel.artifact, panel.rows, { ...f.config, generatedAt: at(5900) }),
    ).toThrow(/splits/);
  });
  it('enforces a bounded training work budget', () => {
    expect(() =>
      prepareMlRows(
        panel.artifact,
        Array.from({ length: 2001 }, () => panel.rows[0]!),
        f.config,
      ),
    ).toThrow(/budget/);
  });
});
describe('reliable deterministic multinomial logistic fitting', () => {
  it('stable softmax handles large logits and produces normalized probabilities', () => {
    for (const x of [
      [10000, 10001, 9999],
      [-10000, -10001, -9999],
      [0, 0, 0],
    ]) {
      const p = softmax(x);
      expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 14);
      expect(p.every((x) => Number.isFinite(x) && x >= 0 && x <= 1)).toBe(true);
    }
    expect(() => softmax([Infinity, 0, 0])).toThrow();
  });
  it('one gradient update agrees with finite-difference cross-entropy derivatives', () => {
    const xs = [[-1], [0], [1]],
      ys = [0, 1, 2],
      cfg = { ...f.config, epochs: 1, l2: 0, learningRate: 0.01 },
      random = new SeededRandom(cfg.randomSeed),
      w = Array.from({ length: 3 }, () => [(random.next() - 0.5) * 0.002]);
    const objective = (weights: number[][]) =>
        logLoss(
          xs.map((x) => softmax(logits(weights, [0, 0, 0], x))),
          ys,
        ),
      epsilon = 1e-6,
      fit = fitLogistic(xs, ys, cfg);
    for (let k = 0; k < 3; k++) {
      const plus = structuredClone(w),
        minus = structuredClone(w);
      plus[k]![0]! += epsilon;
      minus[k]![0]! -= epsilon;
      const gradient = (objective(plus) - objective(minus)) / (2 * epsilon);
      expect(fit.weights[k]![0]).toBeCloseTo(w[k]![0]! - cfg.learningRate * gradient, 9);
    }
  });
  it('retains finite coefficients and a lower regularized TRAIN objective', () => {
    expect(model.training.finalLoss).toBeLessThan(model.training.initialLoss);
    expect(model.training.weights.flat().every(Number.isFinite)).toBe(true);
    expect(model.training.classCounts.every((n) => n >= 2)).toBe(true);
  });
  it('fits scaler statistics from exactly the recorded TRAIN rows', () => {
    expect(model.scaler.rowIds).toEqual(model.training.rowIds);
    expect(
      model.scaler.rowIds.every((id) => panel.rows.find((r) => r.id === id)!.split === 'TRAIN'),
    ).toBe(true);
    expect(
      model.calibration.rowIds.every(
        (id) => panel.rows.find((r) => r.id === id)!.split === 'VALIDATION',
      ),
    ).toBe(true);
    expect(model.scaler.rowIds.some((id) => model.calibration.rowIds.includes(id))).toBe(false);
  });
  it('same seed and frozen snapshot reproduce model and prediction bytes', async () => {
    const b = await trainMarketModel(
      panel.directory,
      JSON.parse(canonicalJson(f.config)),
      'synthetic:test',
    );
    expect(canonicalJson(b)).toBe(canonicalJson(report));
  }, 30000);
  it('TEST price outliers cannot fit the scaler, weights or validation calibration', async () => {
    const variant = structuredClone(f);
    variant.input.technicalArtifacts = variant.input.technicalArtifacts.map((a) =>
      buildTechnicalFeatureArtifact(
        {
          ...a.input,
          bars: a.input.bars.map((bar, i) => {
            if (i < 70) return bar;
            const price = String(Number(bar.close) * 7);
            return MarketBarSchema.parse({
              ...bar,
              id: `${bar.id}:test-outlier`,
              open: price,
              high: price,
              low: price,
              close: price,
              provenance: {
                ...bar.provenance,
                parentIds: [
                  canonicalHash({ recipe: 'synthetic-test-outlier.v1', parent: bar.id, price }),
                ],
              },
            });
          }),
        },
        a.request,
        a.codeVersion,
      ),
    );
    const p = await writeDatasetPanel(
        variant.input,
        variant.request,
        join(root, 'outlier-panels'),
        'synthetic:market-ml-source.v1',
      ),
      b = await trainMarketModel(p.directory, f.config, 'synthetic:test');
    expect(b.model.scaler).toEqual(model.scaler);
    expect(b.model.training.weights).toEqual(model.training.weights);
    expect(b.model.training.biases).toEqual(model.training.biases);
    expect(b.model.calibration).toEqual(model.calibration);
    expect(b.predictions.filter((r) => r.split === 'TEST').map((r) => r.ml)).not.toEqual(
      report.predictions.filter((r) => r.split === 'TEST').map((r) => r.ml),
    );
    expect(b.model.sourcePanel.artifactHash).not.toBe(model.sourcePanel.artifactHash);
  }, 60000);
  it('insufficient directional classes and missing fitting coverage fail closed', async () => {
    await expect(
      trainMarketModel(panel.directory, { ...f.config, abstentionReturnBps: '10000' }, 'test'),
    ).rejects.toThrow(/every class/);
    await expect(
      trainMarketModel(panel.directory, { ...f.config, minimumTrainRows: 1000 }, 'test'),
    ).rejects.toThrow(/coverage/);
  }, 30000);
  it('model and scaler tampering fail identity validation', () => {
    const m = structuredClone(model);
    m.training.weights[0]![0]! += 1;
    expect(() => validateMarketModel(m)).toThrow(/integrity/);
    const s = structuredClone(model);
    s.scaler.means[0]! += 1;
    expect(() => validateMarketModel(s)).toThrow(/integrity/);
  });
});
describe('held-out interpretation, calibration and mandatory baselines', () => {
  it('equal directional probabilities abstain even with zero configured margin', () => {
    expect(
      forecast([0.5, 0, 0.5], { ...f.config, directionalMargin: 0, confidenceThreshold: 0.5 }),
    ).toMatchObject({ action: 'HOLD', reason: 'LOW_CONFIDENCE' });
  });
  it('reports prior, HOLD and deterministic MA on the same held-out rows', () => {
    for (const split of ['VALIDATION', 'TEST']) {
      const ms = report.metrics.filter((m) => m.split === split);
      expect(ms.map((m) => m.provider)).toEqual([
        'ML',
        'UNCALIBRATED_ML',
        'TRAIN_CLASS_PRIOR',
        'ALWAYS_HOLD',
        'MA_2_4',
      ]);
      expect(new Set(ms.map((m) => m.metric.rows)).size).toBe(1);
      expect(ms.find((m) => m.provider === 'ALWAYS_HOLD')!.metric.actionCoverage).toBe(0);
    }
  });
  it('retains all four validation calibration trials and never uses TEST ids', () => {
    expect(model.calibration.trials.map((t) => t.temperature)).toEqual([0.5, 1, 2, 4]);
    const best = Math.min(...model.calibration.trials.map((t) => t.logLoss));
    expect(
      model.calibration.trials.find((t) => t.temperature === model.calibration.temperature)!
        .logLoss,
    ).toBe(best);
    expect(
      model.calibration.rowIds.some((id) =>
        report.predictions.some((p) => p.rowId === id && p.split === 'TEST'),
      ),
    ).toBe(false);
  });
  it('keeps ten reliability bins per class with empty bins explicitly null', () => {
    for (const curve of report.calibrationCurves) {
      expect(curve.bins).toHaveLength(10);
      expect(curve.bins.reduce((s, b) => s + b.count, 0)).toBe(
        report.predictions.filter((r) => r.split === curve.split).length,
      );
      for (const bin of curve.bins.filter((b) => b.count === 0)) {
        expect(bin.meanProbability).toBeNull();
        expect(bin.observedFraction).toBeNull();
      }
    }
  });
  it('retains worse held-out log loss after validation temperature fitting', () => {
    const cal = report.metrics.find((m) => m.split === 'TEST' && m.provider === 'ML')!,
      raw = report.metrics.find((m) => m.split === 'TEST' && m.provider === 'UNCALIBRATED_ML')!;
    expect(cal.metric.logLoss!).toBeGreaterThan(raw.metric.logLoss!);
    expect(report.mode).toBe('RETROSPECTIVE_OUT_OF_SAMPLE');
    expect(report.execution).toBe('DISABLED');
  });
  it('every forecast has normalized probabilities and an explicit HOLD route', () => {
    expect(report.predictions.some((r) => r.ml.action === 'HOLD')).toBe(true);
    for (const r of report.predictions)
      expect(r.ml.probabilities.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(Object.isFrozen(report.model.training.weights)).toBe(true);
    expect(MarketMlReportSchema.safeParse(report).success).toBe(true);
  });
});
describe('actual model availability and causal candidate inference', () => {
  it('rejects inference before model publication even with known feature data', () => {
    expect(() => inferMarketModel(model, query(0))).toThrow(/Model unavailable/);
  });
  it('allows fresh inference after publication without accessing labels', () => {
    const p = inferMarketModel(model, query());
    expect(p.probabilities.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(Object.isFrozen(p)).toBe(true);
    expect(() => inferMarketModel(model, { ...query(), target: 'UP' })).toThrow();
  });
  it('rejects future and stale clocks, stale input evidence and unknown assets', () => {
    expect(() => inferMarketModel(model, { ...query(), decisionAt: at(6001) })).toThrow(/Future/);
    expect(() => inferMarketModel(model, { ...query(), decisionAt: at(6500) })).toThrow(/stale/);
    const stale = query();
    stale.features[0]!.maxInputEventAt = at(5000);
    expect(() => inferMarketModel(model, stale)).toThrow(/Stale/);
    expect(() => inferMarketModel(model, { ...query(), instrumentKey: 'unknown' })).toThrow(
      /unknown/,
    );
  });
  it('rejects formula, column order and source-kind drift', () => {
    const q = query();
    q.features.reverse();
    expect(() => inferMarketModel(model, q)).toThrow(/schema/);
    const label = query();
    label.features[0]!.dependency = 'LABEL';
    expect(() => inferMarketModel(model, label)).toThrow(/schema/);
    const formula = query();
    formula.features[0]!.definitionHash = canonicalHash('different formula');
    expect(() => inferMarketModel(model, formula)).toThrow(/schema/);
  });
  it('does not impute missing inputs or force a directional prediction', () => {
    const q = query();
    q.features[0]!.value = null;
    q.features[0]!.status = 'MISSING_SOURCE';
    expect(inferMarketModel(model, q)).toMatchObject({
      action: 'HOLD',
      reason: 'MISSING_FEATURE',
      score: 0,
    });
  });
  it('causal replay emits only HOLD before publication and immutable candidates afterward', () => {
    const r = executeReplay(
      { schemaVersion: 'replay-input.v1', bars: future.input.bars, news: [] },
      {
        schemaVersion: 'replay-request.v1',
        startAt: at(5940),
        endAt: at(6181),
        generatedAt: at(6240),
        symbols: [source.series.instrumentId],
        randomSeed: 42,
        snapshotEvery: 1,
        maxQueriesPerEvent: 20,
      },
      'synthetic:test',
      createMarketMlStrategy(model, source),
    );
    expect(r.candidates.find((c) => c.decisionAt === at(5940))!).toMatchObject({
      side: 'HOLD',
      score: { status: 'MISSING' },
    });
    expect(
      r.candidates
        .filter((c) => c.decisionAt >= model.availableAt)
        .every((c) => c.calibration.status === 'KNOWN'),
    ).toBe(true);
    expect(r.candidates.every((c) => c.dataCutoff <= c.decisionAt)).toBe(true);
    expect(Object.isFrozen(r.candidates)).toBe(true);
  });
  it('candidate adapter rejects a changed seeded-history origin', () => {
    expect(() =>
      createMarketMlStrategy(model, { ...source, historyStartCloseAt: at(120) }),
    ).toThrow(/source/);
  });
});
describe('frozen Parquet and immutable model bundles', () => {
  it('rejects modified Parquet before fitting any model', async () => {
    const d = join(root, 'bad-parquet', basename(panel.directory));
    await cp(panel.directory, d, { recursive: true });
    await writeFile(join(d, 'panel.parquet'), 'forged');
    await expect(trainMarketModel(d, f.config, 'test')).rejects.toThrow(/checksum/);
  }, 30000);
  it('publishes and verifies reproducible model/config/prediction/report bytes', async () => {
    const a = bundle,
      b = await writeMarketModel(panel.directory, f.config, join(root, 'b'), 'synthetic:test');
    expect((await verifyMarketModel(a.directory, panel.directory)).hash).toBe(a.hash);
    for (const file of [
      'report.json',
      'report.md',
      'model.json',
      'config.json',
      'predictions.json',
      'bundle.json',
    ])
      expect(await readFile(join(a.directory, file))).toEqual(
        await readFile(join(b.directory, file)),
      );
  }, 60000);
  it('reuses a verified immutable bundle and removes staging files', async () => {
    const a = bundle;
    expect(
      (await writeMarketModel(panel.directory, f.config, join(root, 'a'), 'synthetic:test')).hash,
    ).toBe(a.hash);
    expect((await readdir(join(root, 'a'))).some((s) => s.startsWith('.'))).toBe(false);
  }, 60000);
  it('rejects forged Markdown even if its file checksum is recomputed', async () => {
    const a = { ...bundle, directory: join(root, 'forgery', basename(bundle.directory)) },
      md = 'calibration guaranteed';
    await cp(bundle.directory, a.directory, { recursive: true });
    await writeFile(join(a.directory, 'report.md'), md);
    const b = JSON.parse(await readFile(join(a.directory, 'bundle.json'), 'utf8')) as {
      files: { reportMarkdown: string };
    };
    b.files.reportMarkdown = `sha256:${createHash('sha256').update(md).digest('hex')}`;
    await writeFile(join(a.directory, 'bundle.json'), canonicalJson(b));
    await expect(verifyMarketModel(a.directory, panel.directory)).rejects.toThrow(/semantic/);
  }, 30000);
  it('CLI denies live flags and absent frozen panel references', () => {
    for (const args of [
      ['fixture', '--live', 'true'],
      ['train', '--config', 'missing.json'],
    ]) {
      const p = spawnSync(
        process.execPath,
        ['--import', 'tsx', 'apps/cli/src/market-ml.ts', ...args],
        { encoding: 'utf8', timeout: 20000 },
      );
      expect(p.status).toBe(1);
      expect(p.stderr).toContain('Market ML failed');
    }
  }, 50000);
});
