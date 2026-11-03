import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  MarketBarSchema,
  TechnicalFeatureConfigSchema,
  TechnicalFeatureQuerySchema,
  TechnicalFeatureRequestSchema,
  TechnicalFeatureRowSchema,
} from '@crypto/contracts';
import type { TechnicalFeatureRow } from '@crypto/contracts';
import { canonicalHash, decimal, fromEpoch } from '@crypto/core';
import {
  SnapshotTechnicalFeatures,
  technicalFeatureFixture,
  technicalFeatureCatalog,
  buildTechnicalFeatureArtifact,
  validateTechnicalFeatureArtifact,
  writeTechnicalFeatureArtifact,
  verifyTechnicalFeatureArtifact,
  technicalFeatureReport,
} from '@crypto/research';

const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0)) {
    if (
      dirname(resolve(path)) !== resolve(tmpdir()) ||
      !basename(path).startsWith('crypto-features-')
    )
      throw new Error('Unsafe cleanup');
    await rm(path, { recursive: true, force: true });
  }
});
const setup = () => structuredClone(technicalFeatureFixture());
type Fixture = ReturnType<typeof setup>;
const at = (seconds: number) =>
  fromEpoch(BigInt(Date.parse('2026-01-01T00:01:00Z')) + BigInt(seconds) * 1000n, 'milliseconds');
const query = (f: Fixture, seconds: number) =>
  new SnapshotTechnicalFeatures(f.input).query({
    schemaVersion: 'technical-feature-query.v1',
    series: f.request.series,
    intervalSeconds: f.request.intervalSeconds,
    historyStartCloseAt: f.request.historyStartCloseAt,
    config: f.request.config,
    featureAsOf: at(seconds),
  });
const value = (row: TechnicalFeatureRow, id: string) =>
  row.features.find((f) => f.featureId === id)!;

describe('deterministic point-in-time technical features', () => {
  it('reports warm-up as missing instead of zeros for every feature', () => {
    const row = query(setup(), 0);
    expect(row.features.every((f) => f.status === 'WARMUP' && f.value === null)).toBe(true);
    expect(row.coverage).toMatchObject({
      expectedBars: 1,
      availableBars: 1,
      missingCloseTimes: [],
    });
    expect(row.currentBarId).toBe('synthetic:features:0');
  });
  it('matches hand-calculated SMA, seeded EMA, returns and prior-only reference bands', () => {
    const row = query(setup(), 210);
    expect(value(row, 'sma').value).toBe('12');
    expect(value(row, 'ema').value).toBe('12');
    expect(value(row, 'return_2').value).toBe('0.181818181818181818181818181818181818');
    expect(value(row, 'return_5').status).toBe('WARMUP');
    expect(value(row, 'breakout_upper').value).toBe('13');
    expect(value(row, 'breakout_lower').value).toBe('9');
    expect(value(row, 'breakout_upper').inputBarIds).not.toContain(row.currentBarId);
  });
  it('uses the first complete SMA seed and stable recursive EMA updates', () => {
    const f = setup();
    expect(value(query(f, 120), 'ema').value).toBe('11');
    expect(value(query(f, 240), 'ema').value).toBe('12');
    expect(value(query(f, 300), 'ema').value).toBe('11.5');
  });
  it('matches independent population log-volatility calculations', () => {
    const f = setup(),
      row = query(f, 210),
      logs = [Math.log(11 / 10), Math.log(12 / 11), Math.log(13 / 12)],
      m = logs.reduce((s, x) => s + x, 0) / 3,
      expected = Math.sqrt(logs.reduce((s, x) => s + (x - m) ** 2, 0) / 3);
    expect(Number(value(row, 'rolling_volatility').value)).toBeCloseTo(expected, 14);
    f.request.config.volatilityPeriod = 2;
    for (const [i, close] of [1, 2, 1].entries())
      Object.assign(f.input.bars[i]!, {
        open: String(close),
        close: String(close),
        high: String(close),
        low: String(close),
      });
    expect(value(query(f, 120), 'rolling_volatility').value).toBe(
      '0.693147180559945309417232121458176568',
    );
  });
  it('uses previous close for true range, an arithmetic seed and Wilder ATR updates', () => {
    const f = setup();
    f.request.config.atrPeriod = 2;
    Object.assign(f.input.bars[0]!, { open: '10', close: '10', high: '10', low: '10' });
    Object.assign(f.input.bars[1]!, { open: '14', close: '14', high: '15', low: '13' });
    Object.assign(f.input.bars[2]!, { open: '13', close: '13', high: '14', low: '12' });
    Object.assign(f.input.bars[3]!, { open: '20', close: '20', high: '21', low: '19' });
    expect(value(query(f, 60), 'atr').status).toBe('WARMUP');
    expect(value(query(f, 120), 'atr').value).toBe('3.5');
    expect(value(query(f, 210), 'atr').value).toBe('5.75');
  });
  it('computes relative volume and z-score using only prior reference bars', () => {
    const row = query(setup(), 210);
    expect(value(row, 'relative_volume').value).toBe('2');
    expect(Number(value(row, 'z_score').value)).toBeCloseTo(Math.sqrt(6), 14);
    expect(value(row, 'candle_gap').value).toBe('0');
  });
  it('reports zero variance and zero volume denominators explicitly', () => {
    const f = setup();
    for (let i = 0; i < 3; i++)
      Object.assign(f.input.bars[i]!, {
        open: '10',
        close: '10',
        high: '11',
        low: '9',
        volume: '0',
      });
    const row = query(f, 210);
    expect(value(row, 'z_score')).toMatchObject({ status: 'ZERO_VARIANCE', value: null });
    expect(value(row, 'relative_volume')).toMatchObject({
      status: 'ZERO_DENOMINATOR',
      value: null,
    });
    expect(value(row, 'rolling_volatility').value).not.toBe('NaN');
  });
  it('retains genuine zero values while flagging zero/low candle volume without claiming book liquidity', () => {
    const row = query(setup(), 240);
    expect(value(row, 'relative_volume')).toMatchObject({ status: 'READY', value: '0' });
    expect(row.liquidity.flags).toEqual(
      expect.arrayContaining([
        'ORDER_BOOK_UNAVAILABLE',
        'ZERO_VOLUME',
        'LOW_BASE_VOLUME',
        'LOW_RELATIVE_VOLUME',
      ]),
    );
    expect(row.liquidity.status).toBe('CANDLE_PROXY_ONLY_ORDER_BOOK_UNAVAILABLE');
  });
  it('detects an opening price gap separately from missing candle slots', () => {
    const f = setup();
    Object.assign(f.input.bars[4]!, { open: '14', high: '15' });
    const row = query(f, 240);
    expect(value(row, 'candle_gap').value).toBe('0.076923076923076923076923076923076923');
    expect(row.liquidity.flags).toContain('CANDLE_PRICE_GAP');
    expect(row.coverage.missingCloseTimes).toEqual([]);
  });
  it('never treats the current unfinished candle as a closed input', () => {
    const f = setup(),
      row = query(f, 150);
    expect(row.anchorCloseAt).toBe(at(120));
    expect(row.inputBarIds).not.toContain('synthetic:features:3');
    expect(value(row, 'sma').value).toBe('11');
    Object.assign(f.input.bars[3]!, { open: '999', close: '999', high: '1000', low: '998' });
    expect(query(f, 150).features).toEqual(row.features);
  });
  it('gates a completed but delayed candle until its exact availability instant', () => {
    const f = setup(),
      early = query(f, 180),
      late = query(f, 210);
    expect(early.currentBarId).toBeNull();
    expect(value(early, 'sma')).toMatchObject({ status: 'MISSING_CURRENT_BAR', value: null });
    expect(early.coverage.excluded).toContainEqual({
      barId: 'synthetic:features:3',
      reason: 'NOT_AVAILABLE_AT_ASOF',
    });
    expect(value(late, 'sma')).toMatchObject({
      status: 'READY',
      value: '12',
      maxInputAvailableAt: at(210),
    });
    expect(late.currentBarId).toBe('synthetic:features:3');
  });
  it('preserves nanosecond cutoff precision at delayed availability', () => {
    const f = setup(),
      engine = new SnapshotTechnicalFeatures(f.input),
      point = at(210),
      before = fromEpoch(BigInt(Date.parse(point)) * 1000000n - 1n, 'nanoseconds'),
      result = engine.query({
        schemaVersion: 'technical-feature-query.v1',
        series: f.request.series,
        intervalSeconds: 60,
        historyStartCloseAt: at(0),
        config: f.request.config,
        featureAsOf: before,
      });
    expect(result.currentBarId).toBeNull();
    expect(value(result, 'ema').value).toBeNull();
  });
  it('allows known prior breakout levels without inventing an unavailable current close', () => {
    const row = query(setup(), 180);
    expect(row.currentBarId).toBeNull();
    expect(value(row, 'breakout_upper')).toMatchObject({
      status: 'READY',
      value: '13',
      maxInputCloseAt: at(120),
    });
    expect(value(row, 'return_1').value).toBeNull();
  });
  it('does not bridge internal gaps and restarts EMA/ATR warm-up on the consecutive suffix', () => {
    const f = setup();
    f.input.bars = f.input.bars.filter((b) => b.id !== 'synthetic:features:2');
    expect(value(query(f, 240), 'ema')).toMatchObject({ status: 'GAP', value: null });
    expect(value(query(f, 300), 'ema')).toMatchObject({
      status: 'READY',
      value: '12',
      inputBarIds: ['synthetic:features:3', 'synthetic:features:4', 'synthetic:features:5'],
    });
    expect(value(query(f, 300), 'atr')).toMatchObject({ status: 'GAP', value: null });
    expect(value(query(f, 360), 'atr').value).toBe('3.666666666666666666666666666666666667');
    expect(query(f, 360).coverage.missingCloseTimes).toContain(at(120));
  });
  it('preserves earlier EMA values after later corrections become known', () => {
    const f = setup(),
      without = structuredClone(f);
    without.input.bars = without.input.bars.filter(
      (b) => b.id !== 'synthetic:features:corrected-1',
    );
    expect(query(f, 120).features).toEqual(query(without, 120).features);
    const now = query(f, 540),
      beforeCorrection = query(without, 540);
    expect(value(now, 'ema').value).not.toBe(value(beforeCorrection, 'ema').value);
    expect(value(now, 'ema').inputBarIds).toContain('synthetic:features:corrected-1');
    expect(value(now, 'ema').inputBarIds).not.toContain('synthetic:features:1');
    expect(now.coverage.excluded).toContainEqual({
      barId: 'synthetic:features:1',
      reason: 'SUPERSEDED',
    });
  });
  it('does not fall back to an older price when the newest eligible revision invalidates it', () => {
    const f = setup();
    f.input.bars
      .find((b) => b.id === 'synthetic:features:corrected-1')!
      .qualityFlags.push('CONFLICTING_EVIDENCE');
    const row = query(f, 540);
    expect(row.coverage.missingCloseTimes).toContain(at(60));
    expect(row.coverage.excluded).toContainEqual({
      barId: 'synthetic:features:corrected-1',
      reason: 'SOURCE_QUALITY',
    });
    expect(row.inputBarIds).not.toContain('synthetic:features:1');
  });
  it('rejects stale/uncertain source candles without fabricating replacements', () => {
    const f = setup();
    f.input.bars[4]!.qualityFlags.push('STALE');
    const row = query(f, 240);
    expect(row.currentBarId).toBeNull();
    expect(value(row, 'sma').value).toBeNull();
    expect(row.coverage.excluded).toContainEqual({
      barId: 'synthetic:features:4',
      reason: 'SOURCE_QUALITY',
    });
  });
  it('quarantines descriptive-only estimated history even if its close is present', () => {
    const f = setup();
    Object.assign(f.input.bars[2]!, {
      researchUse: 'DESCRIPTIVE_ONLY',
      availabilityBasis: 'ESTIMATED',
    });
    const row = query(f, 120);
    expect(value(row, 'sma').value).toBeNull();
    expect(row.coverage.excluded).toContainEqual({
      barId: 'synthetic:features:2',
      reason: 'DESCRIPTIVE_ONLY',
    });
  });
  it('reports unavailable current data and staleness independently of historical ready features', () => {
    const f = setup();
    f.input.bars = f.input.bars.filter((b) => b.closeAt <= at(120));
    const row = query(f, 360);
    expect(row.liquidity.flags).toEqual(
      expect.arrayContaining(['MISSING_CURRENT_BAR', 'MISSING_CANDLES', 'STALE_PRICE']),
    );
    expect(row.liquidity.lastKnownCloseAt).toBe(at(120));
    expect(value(row, 'ema').value).toBeNull();
  });
  it('does not mix sources, instruments, market types or intervals', () => {
    for (const change of [
      { exchange: 'synthetic:other' },
      { instrumentId: 'ETH/USDT' },
      { marketType: 'PERPETUAL' as const },
    ]) {
      const f = setup();
      Object.assign(f.request.series, change);
      expect(query(f, 120).coverage.availableBars).toBe(0);
    }
    const f = setup();
    f.request.intervalSeconds = 300;
    expect(query(f, 300).coverage.availableBars).toBe(0);
  });
  it('keeps fractional prices in decimal arithmetic', () => {
    const f = setup();
    for (let i = 0; i < 3; i++)
      Object.assign(f.input.bars[i]!, {
        open: `0.00000000000000000${i + 1}`,
        close: `0.00000000000000000${i + 1}`,
        high: `0.00000000000000000${i + 1}`,
        low: `0.00000000000000000${i + 1}`,
      });
    const row = query(f, 120);
    expect(value(row, 'sma').value).toBe('0.000000000000000002');
    expect(value(row, 'return_2').value).toBe('2');
  });
  it('audits every included input close and availability against the feature timestamp', () => {
    const f = setup(),
      artifact = buildTechnicalFeatureArtifact(f.input, f.request, 'synthetic:test'),
      byId = new Map(f.input.bars.map((b) => [b.id, b]));
    for (const row of artifact.rows) {
      for (const id of row.inputBarIds) {
        const b = byId.get(id)!;
        expect(b.closeAt <= row.request.featureAsOf).toBe(true);
        expect(b.availableAt! <= row.request.featureAsOf).toBe(true);
      }
      for (const feature of row.features) {
        const bars = feature.inputBarIds.map((id) => byId.get(id)!);
        expect(feature.maxInputAvailableAt).toBe(
          bars.length
            ? bars
                .map((b) => b.availableAt!)
                .sort()
                .at(-1)
            : null,
        );
        expect(feature.maxInputCloseAt).toBe(
          bars.length
            ? bars
                .map((b) => b.closeAt)
                .sort()
                .at(-1)
            : null,
        );
      }
    }
  });
  it('publishes a versioned formula/inputs/lag/warm-up/NaN catalog for all emitted features', () => {
    const f = setup(),
      catalog = technicalFeatureCatalog(f.request.config),
      row = query(f, 210);
    expect(catalog.map((d) => d.featureId)).toEqual(row.features.map((d) => d.featureId));
    for (const d of catalog) {
      expect(d.version).toBe('technical-features.v1');
      expect(d.formula.length).toBeGreaterThan(0);
      expect(d.nanPolicy).toBe('NULL_WITH_REASON_NEVER_NAN_OR_INFINITY');
      expect(d.availabilityLag).toContain('VARIABLE_SOURCE_LAG');
    }
    expect(catalog.find((d) => d.featureId === 'atr')!.warmupBars).toBe(4);
    expect(catalog.find((d) => d.featureId === 'ema')!.historyPolicy).toBe(
      'CONSECUTIVE_SEGMENT_FROM_DECLARED_START',
    );
  });
  it('rejects duplicate IDs, ambiguous revision times and unlabelled fixture data', () => {
    const f = setup(),
      first = f.input.bars[0]!;
    expect(
      () => new SnapshotTechnicalFeatures({ ...f.input, bars: [...f.input.bars, first] }),
    ).toThrow('Ambiguous');
    expect(
      () =>
        new SnapshotTechnicalFeatures({
          ...f.input,
          bars: [...f.input.bars, { ...first, id: 'synthetic:ambiguous' }],
        }),
    ).toThrow('Ambiguous');
    first.qualityFlags = [];
    expect(() => new SnapshotTechnicalFeatures(f.input)).toThrow('synthetic');
  });
  it('validates public configs, bounded history, batch budgets and generation order', () => {
    const f = setup(),
      config = f.request.config;
    for (const c of [
      { ...config, smaPeriod: 0 },
      { ...config, returnHorizonsBars: [1, 1] },
      { ...config, lowRelativeVolumeThreshold: '2' },
      { ...config, execute: true },
    ])
      expect(TechnicalFeatureConfigSchema.safeParse(c).success).toBe(false);
    const q = {
      schemaVersion: 'technical-feature-query.v1',
      series: f.request.series,
      intervalSeconds: 60,
      historyStartCloseAt: at(0),
      config,
      featureAsOf: at(120),
    };
    for (const bad of [
      { ...q, intervalSeconds: 0 },
      { ...q, historyStartCloseAt: at(180) },
      { ...q, featureAsOf: at(600000) },
      { ...q, featureAsOf: 'not-a-date' },
    ])
      expect(TechnicalFeatureQuerySchema.safeParse(bad).success).toBe(false);
    expect(
      TechnicalFeatureRequestSchema.safeParse({ ...f.request, generatedAt: at(0) }).success,
    ).toBe(false);
    expect(
      TechnicalFeatureRequestSchema.safeParse({
        ...f.request,
        featureAsOf: Array.from({ length: 128 }, (_, i) => at(540000 + i)),
        generatedAt: at(600000),
      }).success,
    ).toBe(false);
  });
  it('rejects output rows with future or incomplete audit metadata', () => {
    const row = query(setup(), 210),
      future = structuredClone(row);
    future.features[0]!.maxInputAvailableAt = at(600);
    expect(TechnicalFeatureRowSchema.safeParse(future).success).toBe(false);
    const missing = structuredClone(row);
    missing.features[0]!.maxInputAvailableAt = null;
    expect(TechnicalFeatureRowSchema.safeParse(missing).success).toBe(false);
  });
  it('detaches/freeze snapshots and produces deterministic repeated results', () => {
    const f = setup(),
      engine = new SnapshotTechnicalFeatures(f.input),
      request = {
        schemaVersion: 'technical-feature-query.v1',
        series: f.request.series,
        intervalSeconds: 60,
        historyStartCloseAt: at(0),
        config: f.request.config,
        featureAsOf: at(210),
      },
      row = engine.query(request),
      hash = canonicalHash(row);
    Object.assign(f.input.bars[0]!, { close: '999' });
    expect(canonicalHash(engine.query(request))).toBe(hash);
    expect(Object.isFrozen(row.features[0])).toBe(true);
    expect(Object.isFrozen(engine.input.bars)).toBe(true);
  });
  it('keeps feature values invariant under arbitrary unfinished future prices', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1000000 }), (price) => {
        const f = setup(),
          before = query(f, 120),
          template = f.input.bars[0]!;
        f.input.bars.push(
          MarketBarSchema.parse({
            ...template,
            id: 'synthetic:future',
            openAt: at(3540),
            closeAt: at(3600),
            availableAt: at(3600),
            open: String(price),
            high: String(price),
            low: String(price),
            close: String(price),
            provenance: { ...template.provenance, capturedAt: at(3600) },
          }),
        );
        expect(query(f, 120).features).toEqual(before.features);
      }),
      { numRuns: 30 },
    );
  });
  it('atomically publishes reproducible feature artifacts and detects metric or catalog tampering', async () => {
    const f = setup(),
      root = await mkdtemp(join(tmpdir(), 'crypto-features-'));
    directories.push(root);
    const a = await writeTechnicalFeatureArtifact(f.input, f.request, root, 'synthetic:test'),
      b = await writeTechnicalFeatureArtifact(f.input, f.request, root, 'synthetic:test');
    expect(a.hash).toBe(b.hash);
    expect(await readdir(root)).toEqual([basename(a.path)]);
    const changed = structuredClone(a.artifact);
    changed.catalog[0]!.formula = 'Invented formula';
    expect(() => validateTechnicalFeatureArtifact(changed)).toThrow('integrity');
    const wrong = join(root, 'wrong.json');
    await writeFile(wrong, await readFile(a.path));
    await expect(verifyTechnicalFeatureArtifact(wrong)).rejects.toThrow('name');
    const changedMetric = structuredClone(a.artifact);
    changedMetric.rows[4]!.features[0]!.value = decimal('999');
    expect(() => validateTechnicalFeatureArtifact(changedMetric)).toThrow('integrity');
    await writeFile(a.path, JSON.stringify(changedMetric));
    await expect(
      writeTechnicalFeatureArtifact(f.input, f.request, root, 'synthetic:test'),
    ).rejects.toThrow();
  });
  it('binds dataset, configuration and software identity into verified reports', () => {
    const f = setup(),
      a = buildTechnicalFeatureArtifact(f.input, f.request, 'synthetic:one'),
      b = buildTechnicalFeatureArtifact(f.input, f.request, 'synthetic:two');
    expect(canonicalHash(a)).not.toBe(canonicalHash(b));
    expect(a.inputHash).toBe(canonicalHash(a.input));
    const report = technicalFeatureReport(a);
    expect(report).toContain('WARMUP');
    expect(report).toContain('MISSING_CURRENT_BAR');
    expect(report).toContain('order-book liquidity is unavailable');
    expect(report).toContain('Feature catalog');
  });
});
