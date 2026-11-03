import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import {
  NewsEdgeInputSchema,
  NewsEdgePlanSchema,
  MarketBarSchema,
  NewsEdgePredictionSchema,
  DecimalStringSchema,
} from '@crypto/contracts';
import type { NewsEdgeInput, NewsEdgeModel, NewsEdgeRow } from '@crypto/contracts';
import { canonicalHash, canonicalJson, utc, fromEpoch } from '@crypto/core';
import { newsEdgeFixture } from '@crypto/backtest';
import { buildNewsEventSnapshot } from '@crypto/news';
import { freezeNewsEdgeInput, prepareNewsEdgeRows } from '@crypto/research';
import {
  EstimatedNewsSignalProvider,
  trainNewsEdge,
  validateNewsEdgeModel,
  writeNewsEdgeModel,
  verifyNewsEdgeModel,
  newsEdgeMarkdown,
} from '@crypto/strategies';
import {
  newsEdgeStatistics,
  newsEdgeUnits,
  newsEdgeMargin,
} from '../packages/strategies/src/news-edge-statistics.js';

let f: Awaited<ReturnType<typeof newsEdgeFixture>>,
  model: NewsEdgeModel,
  small: NewsEdgeInput,
  root: string;
let bundle: Awaited<ReturnType<typeof writeNewsEdgeModel>>,
  p: EstimatedNewsSignalProvider,
  positive: EstimatedNewsSignalProvider;
const shift = (s: string, seconds: number) =>
  fromEpoch(BigInt(Date.parse(s)) + BigInt(seconds) * 1000n, 'milliseconds');
const fit = (horizon = 300) =>
  model.fits.find(
    (v) => v.hypothesisId === f.queries[0]!.hypothesisId && v.horizonSeconds === horizon,
  )!;
function infer(m = model, query = f.queries[0]!) {
  const provider = new EstimatedNewsSignalProvider(m, query.hypothesisId, query.snapshot);
  return provider.evaluate(query.query, provider.initialState(), query.roundTripCostBps);
}
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'crypto-news-edge-'));
  f = await newsEdgeFixture();
  model = trainNewsEdge(f.input, 'synthetic:test');
  const source = f.input.dataset.newsSnapshots[0]!,
    hash = canonicalHash(source);
  small = NewsEdgeInputSchema.parse({
    ...f.input,
    plan: {
      ...f.input.plan,
      hypotheses: [f.input.plan.hypotheses[0]],
      horizonsSeconds: [300],
      bootstrapSamples: 200,
    },
    dataset: {
      ...f.input.dataset,
      newsSnapshots: [source],
      observations: f.input.dataset.observations.filter((o) =>
        o.kind === 'POINT_IN_TIME' ? o.snapshotHash === hash : o.id.includes(':incident:'),
      ),
      marketBars: f.input.dataset.marketBars.filter((b) => b.id.includes(':incident:')),
    },
  });
  bundle = await writeNewsEdgeModel(small, join(root, 'a'), 'synthetic:test');
  p = new EstimatedNewsSignalProvider(model, f.queries[0]!.hypothesisId, f.queries[0]!.snapshot);
  positive = new EstimatedNewsSignalProvider(
    model,
    f.queries[1]!.hypothesisId,
    f.queries[1]!.snapshot,
  );
}, 120000);
afterAll(async () => {
  if (
    dirname(resolve(root)) !== resolve(tmpdir()) ||
    !basename(root).startsWith('crypto-news-edge-')
  )
    throw new Error('Unsafe news fixture cleanup');
  await rm(root, { recursive: true, force: true });
});

describe('conditional news estimates and chronological evidence', () => {
  it('retains all eight predeclared hypothesis/horizon attempts including negative findings', () => {
    expect(model.fits).toHaveLength(8);
    expect(model.rows).toHaveLength(88);
    expect(model.fits.filter((v) => v.selectedOnTraining)).toHaveLength(2);
    expect(fit(60).reasons).toContain('TRAINING_EDGE_BELOW_COST_AND_UNCERTAINTY');
    expect(model.execution).toBe('DISABLED');
    expect(model.synthetic).toBe(true);
  });
  it('learns direction and holding period on TRAIN and checks a later disjoint period', () => {
    expect(fit().side).toBe('SHORT');
    expect(fit().horizonSeconds).toBe(300);
    expect(fit().training.independentUnits).toBe(6);
    expect(fit().validation.independentUnits).toBe(3);
    expect(fit().selectedOnTraining).toBe(true);
  });
  it('future predictions report sample sizes, conditional intervals and exact vintage', () => {
    const r = p.evaluate(f.queries[0]!.query, p.initialState());
    expect(r.decision.candidate.side).toBe('SHORT');
    expect(r.prediction.trainingSampleSize).toBe(6);
    expect(r.prediction.validationSampleSize).toBe(3);
    expect(r.prediction.grossInterval?.lower).toBe('-0.024');
    expect(r.prediction.dataVintage).toBe(utc('2026-01-26T00:00:00Z'));
    expect(r.prediction.horizonSeconds).toBe(300);
    expect(r.decision.candidate.horizon.value).toBe(300);
    expect(r.decision.candidate.validUntil).toBe(shift(f.queries[0]!.query.decisionAt, 300));
  });
  it('supports a positive conditional opinion with separate event support and missing probabilities', () => {
    const r = positive.evaluate(f.queries[1]!.query, positive.initialState());
    expect(r.prediction.side).toBe('LONG');
    expect(r.prediction.eventSupportGrade).toBe('ATTRIBUTED_SUPPORT');
    expect(r.prediction.eventTruthProbability).toBeNull();
    expect(r.decision.candidate.calibration.status).toBe('MISSING');
    expect(r.decision.candidate.score.status).toBe('MISSING');
  });
  it('no descriptive archive ever becomes a measured fit label', () => {
    const archives = model.rows.filter((r) => r.observationId.endsWith(':archive'));
    expect(archives).toHaveLength(8);
    expect(
      archives.every(
        (r) => r.status === 'DESCRIPTIVE_ONLY' && r.grossReturn === null && r.excessReturn === null,
      ),
    ).toBe(true);
    expect(
      model.fits.every((v) => v.training.completeCount <= 6 && v.validation.completeCount <= 3),
    ).toBe(true);
  });
  it('uses declared benchmark drift and matched baseline means rather than unadjusted labels', () => {
    const r = model.rows.find(
      (r) =>
        r.hypothesisId.endsWith('incident:first') &&
        r.horizonSeconds === 300 &&
        r.status === 'COMPLETE',
    )!;
    expect(r.benchmarkReturn).toBe('0.002');
    expect(r.baselineMean).toBe('0.001');
    expect(Number(r.excessReturn)).toBeCloseTo(Number(r.grossReturn) - 0.003);
    expect(r.controlIds).toHaveLength(2);
    expect(r.baselineReturns).toEqual(['0.001', '0.001']);
    expect(fit().training.baselineDistribution).toEqual({
      count: 12,
      minimum: '0.001',
      median: '0.001',
      maximum: '0.001',
    });
  });
  it('keeps recurrence strata separate and abstains on sparse recurrent events', () => {
    const id = f.input.plan.hypotheses[1]!.id,
      r = infer(model, { ...f.queries[0]!, hypothesisId: id });
    expect(r.prediction.trainingUnits).toBe(1);
    expect(r.prediction.validationUnits).toBe(0);
    expect(r.prediction.side).toBe('HOLD');
    expect(r.prediction.reasons).toContain('INSUFFICIENT_TRAINING_EDGE');
    expect(model.rows.some((r) => r.status === 'RECURRENCE_EXCLUDED')).toBe(true);
  });
  it('thin historical evidence must abstain with an explicitly missing interval', () => {
    const m = trainNewsEdge(
        { ...small, plan: { ...small.plan, minimumTrainingUnits: 7 } },
        'synthetic:test',
      ),
      r = infer(m);
    expect(r.prediction.trainingSampleSize).toBe(6);
    expect(r.prediction.side).toBe('HOLD');
    expect(m.fits[0]!.training.grossInterval).toBeNull();
    expect(r.state.slots).toHaveLength(0);
  }, 60000);
  it('an insufficient validation cohort cannot be promoted by a strong training result', () => {
    const m = trainNewsEdge(
      { ...small, plan: { ...small.plan, minimumValidationUnits: 4 } },
      'synthetic:test',
    );
    expect(m.fits[0]!.selectedOnTraining).toBe(true);
    expect(infer(m).prediction.reasons).toContain('INSUFFICIENT_VALIDATION_EVIDENCE');
    expect(infer(m).prediction.side).toBe('HOLD');
  }, 60000);
  it('changing validation outcomes cannot select a different sign or horizon', () => {
    const changed = {
      ...small,
      plan: { ...small.plan, horizonsSeconds: [60, 300], bootstrapSamples: 400 },
      dataset: {
        ...small.dataset,
        marketBars: small.dataset.marketBars.map((b) =>
          b.instrumentId === 'BTC/USDT' &&
          b.id.includes(':event:') &&
          b.closeAt >= small.plan.validation.from
            ? MarketBarSchema.parse({ ...b, open: '110', high: '110', low: '110', close: '110' })
            : b,
        ),
      },
    };
    const m = trainNewsEdge(changed, 'synthetic:test'),
      chosen = m.fits.find((v) => v.selectedOnTraining)!;
    expect(chosen.side).toBe('SHORT');
    expect(chosen.horizonSeconds).toBe(300);
    expect(chosen.validationMargin === null || Number(chosen.validationMargin) <= 0).toBe(true);
    expect(infer(m).prediction.side).toBe('HOLD');
    expect(m.fits.find((v) => v.horizonSeconds === 60)!.selectedOnTraining).toBe(false);
  }, 60000);
  it('freezes only known news, outcomes and observations at the fitting cutoff', () => {
    expect(model.input.dataset.observations.every((o) => o.decisionAt <= model.dataVintage)).toBe(
      true,
    );
    expect(
      model.input.dataset.marketBars.every(
        (b) => b.availableAt !== null && b.availableAt <= model.dataVintage,
      ),
    ).toBe(true);
    expect(
      model.input.dataset.newsSnapshots.every((s) =>
        s.input.graphRecords.every((r) => r.recordedAt <= model.dataVintage),
      ),
    ).toBe(true);
  });
  it('unseen future price edits do not change the frozen fitting input', () => {
    const changed = {
      ...f.input,
      dataset: {
        ...f.input.dataset,
        marketBars: f.input.dataset.marketBars.map((b) =>
          b.closeAt > model.dataVintage
            ? MarketBarSchema.parse({ ...b, open: '500', high: '500', low: '500', close: '500' })
            : b,
        ),
      },
    };
    expect(freezeNewsEdgeInput(changed)).toEqual(model.input);
    expect(freezeNewsEdgeInput(model.input)).toEqual(model.input);
  }, 60000);
  it('refuses prediction before model availability without exposing a future estimate', () => {
    const source = f.queries[0]!.snapshot,
      o = model.input.dataset.observations.find((o) => o.kind === 'POINT_IN_TIME')!;
    const earlier = { ...f.queries[0]!.query, decisionAt: o.decisionAt, eventId: o.eventId };
    expect(() => p.evaluate(earlier, p.initialState())).toThrow(/not yet available/);
    expect(source).toBeDefined();
  });
  it('rejects an inference decision lag outside the fitted opportunity set', () => {
    const r = f.queries[0]!,
      decisionAt = shift(r.query.decisionAt, 1),
      { proofHash: _hash, ...body } = r.query.freshness;
    void _hash;
    const guard = { ...body, decisionAt };
    const result = p.evaluate(
      { ...r.query, decisionAt, freshness: { ...guard, proofHash: canonicalHash(guard) } },
      p.initialState(),
    );
    expect(result.prediction.side).toBe('HOLD');
    expect(result.prediction.reasons).toContain('DECISION_LAG_OUT_OF_SCOPE');
  });
  it('higher execution cost vetoes an otherwise eligible opinion without consuming state', () => {
    const a = p.evaluate(f.queries[0]!.query, p.initialState(), 1000);
    expect(a.prediction.side).toBe('HOLD');
    expect(a.prediction.reasons).toContain('EDGE_BELOW_COST_AND_UNCERTAINTY');
    expect(a.state.slots).toHaveLength(0);
    expect(p.evaluate(f.queries[0]!.query, a.state, 10).prediction.side).toBe('SHORT');
  });
  it('inference cannot lower the frozen execution-cost floor', () => {
    const a = p.evaluate(f.queries[0]!.query, p.initialState(), 0),
      b = p.evaluate(f.queries[0]!.query, p.initialState(), 10);
    expect(a).toEqual(b);
  });
  it('retains the separate stale-market veto', () => {
    const q = f.queries[0]!.query,
      { proofHash: _hash, ...body } = q.freshness;
    void _hash;
    const g = { ...body, status: 'STALE' };
    const r = p.evaluate(
      { ...q, freshness: { ...g, proofHash: canonicalHash(g) } },
      p.initialState(),
    );
    expect(r.prediction.side).toBe('HOLD');
    expect(r.prediction.reasons).toContain('OPERATIONAL_FRESHNESS_VETO');
  });
  it('new raw price fields cannot enter the news-only inference query', () => {
    expect(() =>
      p.evaluate({ ...f.queries[0]!.query, marketReturn: 0.1 }, p.initialState()),
    ).toThrow();
  });
  it('predictions and candidates bind the exact model and as-of evidence', () => {
    const r = p.evaluate(f.queries[0]!.query, p.initialState());
    expect(r.decision.candidate.rationaleIds).toContain(canonicalHash(model));
    expect(r.decision.candidate.rationaleIds).toContain(r.decision.opinion.snapshotHash);
    expect(r.decision.candidate.rationaleIds).toContain(canonicalHash(r.prediction));
    expect(Object.isFrozen(r.prediction)).toBe(true);
    expect(
      NewsEdgePredictionSchema.safeParse({ ...r.prediction, eventTruthProbability: 0.99 }).success,
    ).toBe(false);
  });
  it('already-admitted evidence cannot repeatedly emit candidates', () => {
    const a = p.evaluate(f.queries[0]!.query, p.initialState());
    expect(p.evaluate(f.queries[0]!.query, a.state).prediction.side).toBe('HOLD');
  });
  it('requires the same curated direct exposure gate as conservative rules', () => {
    const r = f.queries[0]!,
      s = r.snapshot,
      snapshot = buildNewsEventSnapshot(
        s.graphConfig,
        s.input.graphRecords,
        [],
        s.config,
        { decisionAt: s.request.decisionAt, generatedAt: s.request.generatedAt },
        s.codeVersion,
      );
    expect(infer(model, { ...r, snapshot }).prediction.reasons).toContain(
      'NO_DIRECT_ASSET_MAPPING',
    );
  }, 30000);
});

describe('outcome, control, independence and integrity failures', () => {
  it('zero incremental edge remains a negative result even with complete history', () => {
    const input = {
      ...small,
      dataset: {
        ...small.dataset,
        marketBars: small.dataset.marketBars.map((b) =>
          b.instrumentId === 'BTC/USDT' && b.id.includes(':event:') && b.id.endsWith(':5')
            ? MarketBarSchema.parse({
                ...b,
                open: '100',
                close: '100.3',
                high: '100.3',
                low: '100',
              })
            : b,
        ),
      },
    };
    const m = trainNewsEdge(input, 'synthetic:test');
    expect(m.fits[0]!.training.completeCount).toBe(6);
    expect(m.fits[0]!.side).toBe('HOLD');
    expect(m.fits[0]!.reasons).toContain('ZERO_TRAINING_EXCESS');
    expect(infer(m).prediction.side).toBe('HOLD');
  }, 60000);
  it('an unavailable or descriptive price never supplies a tradable fit label', () => {
    const input = {
      ...small,
      dataset: {
        ...small.dataset,
        marketBars: small.dataset.marketBars.map((b) =>
          b.instrumentId === 'BTC/USDT' && b.id.includes(':event:')
            ? MarketBarSchema.parse({
                ...b,
                availableAt: null,
                availabilityBasis: 'UNKNOWN',
                researchUse: 'DESCRIPTIVE_ONLY',
              })
            : b,
        ),
      },
    };
    const rows = prepareNewsEdgeRows(input).rows;
    expect(rows.filter((r) => r.status === 'COMPLETE')).toHaveLength(0);
    expect(rows.some((r) => r.status === 'MISSING_PRICES')).toBe(true);
  }, 60000);
  it('late publication of an outcome close is rejected even at a later analysis cutoff', () => {
    const input = {
      ...small,
      dataset: {
        ...small.dataset,
        marketBars: small.dataset.marketBars.map((b) =>
          b.id.includes(':event:') && b.id.endsWith(':5')
            ? MarketBarSchema.parse({ ...b, availableAt: shift(b.closeAt, 1) })
            : b,
        ),
      },
    };
    expect(prepareNewsEdgeRows(input).rows.some((r) => r.status === 'MISSING_PRICES')).toBe(true);
  }, 60000);
  it('missing matched non-event prices leave edge unknown', () => {
    const input = {
      ...small,
      dataset: {
        ...small.dataset,
        marketBars: small.dataset.marketBars.filter((b) => !b.id.includes(':control-')),
      },
    };
    const rows = prepareNewsEdgeRows(input).rows;
    expect(rows.some((r) => r.status === 'INSUFFICIENT_MATCHED_CONTROLS')).toBe(true);
    expect(rows.every((r) => r.excessReturn === null)).toBe(true);
  }, 60000);
  it('purges full pre-news and outcome windows at phase boundaries', () => {
    const observation = small.dataset.observations.find((o) => o.kind === 'POINT_IN_TIME')!;
    const r = prepareNewsEdgeRows({
      ...small,
      plan: { ...small.plan, training: { ...small.plan.training, from: observation.decisionAt } },
    });
    expect(r.rows.find((r) => r.observationId === observation.id)!.status).toBe(
      'OUTCOME_OUTSIDE_PERIOD',
    );
  }, 60000);
  it('pre-news matching calipers reject unlike historical controls', () => {
    const input = {
      ...small,
      plan: {
        ...small.plan,
        controlAnchors: small.plan.controlAnchors.filter((t) => t.slice(0, 10) === '2026-01-01'),
      },
    };
    const rows = prepareNewsEdgeRows(input).rows;
    expect(rows.some((r) => r.status === 'COMPLETE')).toBe(true);
    expect(rows.some((r) => r.status === 'INSUFFICIENT_MATCHED_CONTROLS')).toBe(true);
  }, 60000);
  it.each(['lineageIds', 'controlIds', 'barIds'] as const)(
    'shared %s collapse repeated observations into one sampling unit',
    (key) => {
      const row = model.rows.find((r) => r.status === 'COMPLETE')!;
      const rows = Array.from({ length: 5 }, (_, i): NewsEdgeRow => ({
        ...row,
        observationId: `synthetic:unit:${i}`,
        from: utc(`2026-02-${String(i + 1).padStart(2, '0')}T00:00:00Z`),
        endAt: utc(`2026-02-${String(i + 1).padStart(2, '0')}T00:05:00Z`),
        lineageIds: [`synthetic:lineage:${i}`],
        controlIds: [`synthetic:control:${i}`],
        baselineReturns: [DecimalStringSchema.parse('0.001')],
        barIds: [`synthetic:bar:${i}`],
        [key]: ['synthetic:shared'],
      }));
      expect(newsEdgeUnits(rows)).toHaveLength(1);
      expect(newsEdgeStatistics(rows, 3, 200, 1, 1).excessInterval).toBeNull();
    },
  );
  it('overlapping pre/outcome intervals collapse sampling units', () => {
    const row = model.rows.find((r) => r.status === 'COMPLETE')!;
    expect(
      newsEdgeUnits([
        { ...row, lineageIds: [], controlIds: [], barIds: [] },
        { ...row, observationId: 'synthetic:overlap', lineageIds: [], controlIds: [], barIds: [] },
      ]),
    ).toHaveLength(1);
  });
  it('insufficient resampling resolution cannot create an interval or pass a cost gate', () => {
    const rows = model.rows.filter(
      (r) =>
        r.hypothesisId.endsWith('incident:first') &&
        r.horizonSeconds === 300 &&
        r.phase === 'TRAIN',
    );
    const stats = newsEdgeStatistics(rows, 3, 200, 42, 32);
    expect(stats.uncertaintyReason).toBe('INSUFFICIENT_RESAMPLING_RESOLUTION');
    expect(newsEdgeMargin(stats, 'SHORT', 0, 1)).toBeNull();
    expect(fit().training.grossInterval?.familySize).toBe(32);
  });
  it('a relative benefit alone cannot rescue a negative gross-direction bound', () => {
    const s = structuredClone(fit().training);
    s.grossInterval!.lower = DecimalStringSchema.parse('0.01');
    s.grossInterval!.upper = DecimalStringSchema.parse('0.02');
    expect(Number(newsEdgeMargin(s, 'SHORT', 10, 25))).toBeLessThan(0);
  });
  it('refuses overlapping periods, retrospective declaration and duplicate horizons', () => {
    expect(
      NewsEdgePlanSchema.safeParse({ ...small.plan, validation: small.plan.training }).success,
    ).toBe(false);
    expect(
      NewsEdgePlanSchema.safeParse({ ...small.plan, declaredAt: '2026-01-02T00:00:00Z' }).success,
    ).toBe(false);
    expect(
      NewsEdgePlanSchema.safeParse({ ...small.plan, horizonsSeconds: [300, 300] }).success,
    ).toBe(false);
  });
  it('refuses ambiguous outcome identities and bounded input overflow', () => {
    expect(() =>
      prepareNewsEdgeRows({
        ...small,
        dataset: {
          ...small.dataset,
          marketBars: [...small.dataset.marketBars, small.dataset.marketBars[0]],
        },
      }),
    ).toThrow(/Ambiguous/);
    expect(() =>
      prepareNewsEdgeRows({
        ...small,
        dataset: {
          ...small.dataset,
          observations: Array.from({ length: 129 }, () => small.dataset.observations[0]),
        },
      }),
    ).toThrow(/budget/);
  }, 60000);
  it('unknown model scope and foreign state are rejected', () => {
    expect(
      () => new EstimatedNewsSignalProvider(model, 'synthetic:unknown', f.queries[0]!.snapshot),
    ).toThrow(/Unknown/);
    const foreign = new EstimatedNewsSignalProvider(
      bundle.model,
      f.queries[0]!.hypothesisId,
      f.queries[0]!.snapshot,
    );
    expect(() => p.evaluate(f.queries[0]!.query, foreign.initialState())).toThrow(/scope/);
  });
  it('a changed novelty policy cannot reuse estimates with different feature definitions', () => {
    const source = f.queries[0]!.snapshot;
    const changed = buildNewsEventSnapshot(
      source.graphConfig,
      source.input.graphRecords,
      [],
      { ...source.config, noveltyWindowHours: 48 },
      { decisionAt: source.request.decisionAt, generatedAt: source.request.generatedAt },
      source.codeVersion,
    );
    expect(
      () => new EstimatedNewsSignalProvider(model, f.queries[0]!.hypothesisId, changed),
    ).toThrow(/policy/);
  }, 30000);
  it('mutating frozen estimates through a copied object triggers full semantic rebuilding', () => {
    const forged = structuredClone(bundle.model);
    forged.fits[0]!.side = 'LONG';
    expect(() => validateNewsEdgeModel(forged)).toThrow(/semantic/);
  }, 60000);
  it('immutable artifacts reproduce exactly and leave no staging files', async () => {
    const b = await writeNewsEdgeModel(bundle.model.input, join(root, 'b'), 'synthetic:test');
    expect(b.hash).toBe(bundle.hash);
    expect(await readFile(b.path)).toEqual(await readFile(bundle.path));
    expect((await verifyNewsEdgeModel(bundle.path)).hash).toBe(bundle.hash);
    expect((await readdir(join(root, 'a'))).some((n) => n.startsWith('.news-edge-stage-'))).toBe(
      false,
    );
    expect(newsEdgeMarkdown(bundle.model)).toContain('SYNTHETIC');
  }, 60000);
  it('a forged artifact cannot be repaired merely by renaming its content hash', async () => {
    const forged = structuredClone(bundle.model);
    forged.fits[0]!.trainingMargin = '0.99' as (typeof forged.fits)[0]['trainingMargin'];
    const path = join(root, `news-edge_${canonicalHash(forged).slice(7)}.json`);
    await writeFile(path, canonicalJson(forged));
    await expect(verifyNewsEdgeModel(path)).rejects.toThrow(/semantic/);
  }, 60000);
  it.each([
    ['fixture', '--live', 'true'],
    ['train'],
    ['infer', '--model', 'missing', '--request', 'missing'],
  ])('CLI rejects unsupported or missing inputs %j', (...args) => {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'apps/cli/src/news-edge.ts', ...args],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('News edge research failed');
  });
});
