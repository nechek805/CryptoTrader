import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CrossFeatureRequestSchema,
  CrossFeatureRowSchema,
  DerivativeFeatureObservationSchema,
  compareDecimal,
  utcNanoseconds,
} from '@crypto/contracts';
import { canonicalHash, decimal, fromEpoch, addDecimal, multiplyDecimal } from '@crypto/core';
import {
  crossFeatureFixture,
  SnapshotCrossFeatures,
  buildCrossFeatureArtifact,
  writeCrossFeatureArtifact,
  verifyCrossFeatureArtifact,
  validateCrossFeatureArtifact,
  crossFeatureReport,
  buildTechnicalFeatureArtifact,
  technicalFeatureFixture,
} from '@crypto/research';

const dirs: string[] = [];
afterEach(async () => {
  for (const path of dirs.splice(0)) {
    if (
      dirname(resolve(path)) !== resolve(tmpdir()) ||
      !basename(path).startsWith('crypto-cross-features-')
    )
      throw new Error('Unsafe cleanup');
    await rm(path, { recursive: true, force: true });
  }
});
const at = (seconds: number) => fromEpoch(1767225600n + BigInt(seconds), 'seconds');
const shift = (t: ReturnType<typeof at>, nanos: bigint) =>
  fromEpoch(utcNanoseconds(t) + nanos, 'nanoseconds');
function setup(seconds = 330) {
  const f = structuredClone(crossFeatureFixture());
  f.request.featureAsOf = [at(seconds)];
  return f;
}
type Fixture = ReturnType<typeof setup>;
const run = (f: Fixture) => new SnapshotCrossFeatures(f.input).evaluate(f.request)[0]!;
const asset = (row: ReturnType<typeof run>, key = 'cross:SPOT:ETH') =>
  row.assets.find((a) => a.instrumentKey === key)!;
const bar = (f: Fixture, key: string, minute: number) =>
  f.input.technical.bars.find((b) => b.id === `${key}:bar:${minute}`)!;
function returns(f: Fixture, key: string, values: string[]) {
  f.input.market.instruments.find((m) => m.instrumentKey === key)!.tickSize = decimal('0.00000001');
  let previous = decimal('100');
  Object.assign(bar(f, key, 1), { open: previous, high: previous, low: previous, close: previous });
  for (let i = 0; i < values.length; i++) {
    const price = multiplyDecimal(previous, addDecimal(decimal('1'), decimal(values[i]!))),
      b = bar(f, key, i + 2);
    Object.assign(b, {
      open: previous,
      close: price,
      high: compareDecimal(previous, price) > 0 ? previous : price,
      low: compareDecimal(previous, price) < 0 ? previous : price,
    });
    previous = price;
  }
}
describe('point-in-time cross-asset features and regimes', () => {
  it('does not borrow later-known BTC candles for an ETH feature', () => {
    const f = setup(300),
      early = run(f),
      eth = asset(early);
    expect(eth.grossReturn).toBe('0.08');
    expect(eth.relativeToBtc).toBeNull();
    expect(early.btc.grossReturn).toBeNull();
    expect(early.btc.slots.at(-1)!.status).toBe('NOT_AVAILABLE');
    for (const c of eth.correlations)
      expect(c.pairs.every((p) => !p.barIds.includes('cross:SPOT:BTC:bar:5'))).toBe(true);
    f.request.featureAsOf = [at(330)];
    expect(asset(run(f)).relativeToBtc).toBe('0.08');
  });
  it('honors a one-nanosecond availability boundary', () => {
    const f = setup(315);
    f.request.featureAsOf = [shift(at(315), -1n)];
    expect(run(f).btc.grossReturn).toBeNull();
    f.request.featureAsOf = [at(315)];
    expect(run(f).btc.grossReturn).toBe('0');
  });
  it('permits only explicitly bounded backward clock alignment', () => {
    const f = setup(390);
    for (const b of f.input.technical.bars.filter(
      (b) => b.marketType === 'SPOT' && b.instrumentId === 'BTC/USDT',
    )) {
      b.openAt = shift(b.openAt, -500000000n);
      b.closeAt = shift(b.closeAt, -500000000n);
      b.availableAt = shift(b.availableAt!, -500000000n);
      b.provenance.capturedAt = b.availableAt;
    }
    expect(run(f).btc.grossReturn).toBeNull();
    f.request.joinToleranceMs = 500;
    const r = run(f);
    expect(Number(r.btc.grossReturn)).toBeCloseTo(1 / 22, 14);
    for (const s of r.btc.slots)
      expect(utcNanoseconds(s.nominalCloseAt) - utcNanoseconds(s.actualCloseAt!)).toBe(500000000n);
    f.request.joinToleranceMs = 499;
    expect(run(f).btc.grossReturn).toBeNull();
  });
  it('never forward-joins a later BTC close even when already known at the query time', () => {
    const f = setup();
    f.request.joinToleranceMs = 500;
    for (const b of f.input.technical.bars.filter(
      (b) => b.marketType === 'SPOT' && b.instrumentId === 'BTC/USDT',
    )) {
      b.openAt = shift(b.openAt, 500000000n);
      b.closeAt = shift(b.closeAt, 500000000n);
      b.availableAt = shift(b.availableAt!, 500000000n);
      b.provenance.capturedAt = b.availableAt;
    }
    const r = run(f);
    expect(r.btc.grossReturn).toBeNull();
    expect(asset(r).relativeToBtc).toBeNull();
  });
  it('gates a missing historical listing and waits for enough post-listing bars', () => {
    const f = setup();
    let r = run(f);
    expect(asset(r, 'cross:SPOT:NEW').status).toBe('NO_KNOWN_LISTING');
    expect(r.universe.selected.some((s) => s.instrument.baseCode === 'NEW')).toBe(false);
    expect(r.inputMetadataIds.some((id) => id.includes('NEW'))).toBe(false);
    f.request.featureAsOf = [at(450)];
    r = run(f);
    expect(asset(r, 'cross:SPOT:NEW').status).toBe('AVAILABLE');
    expect(asset(r, 'cross:SPOT:NEW').grossReturn).toBeNull();
    expect(asset(r, 'cross:SPOT:NEW').slots[0]!.status).toBe('NOT_LISTED');
    f.request.featureAsOf = [at(510)];
    r = run(f);
    expect(asset(r, 'cross:SPOT:NEW').grossReturn).toBe('0.5');
  });
  it("uses historical liquidity rankings rather than today's survivors", () => {
    const f = setup();
    let r = run(f);
    expect(r.universe.selected.map((s) => s.instrument.baseCode)).toEqual(['BTC', 'ETH', 'SOL']);
    f.request.featureAsOf = [at(510)];
    r = run(f);
    expect(r.universe.selected.map((s) => s.instrument.baseCode)).toEqual(['NEW', 'BTC', 'ETH']);
  });
  it('excludes delisted assets without silently carrying them in the universe', () => {
    const f = setup();
    f.input.market.instruments.find((m) => m.baseCode === 'SOL')!.delistedAt = at(240);
    const r = run(f);
    expect(asset(r, 'cross:SPOT:SOL').status).toBe('DELISTED');
    expect(asset(r, 'cross:SPOT:SOL').grossReturn).toBeNull();
    expect(r.universe.excluded).toContainEqual({
      instrumentKey: 'cross:SPOT:SOL',
      reason: 'DELISTED',
    });
  });
  it('returns a missing BTC reference without replacing it with another asset', () => {
    const f = setup();
    f.input.bindings = f.input.bindings.filter(
      (b) => b.instrumentKey !== f.request.btcInstrumentKey,
    );
    const r = run(f);
    expect(r.btc.status).toBe('NO_BINDING');
    expect(asset(r).relativeToBtc).toBeNull();
    expect(asset(r).regime.trend).toBe('TRENDING');
    expect(r.breadth.measuredCount).toBe(2);
    expect(r.breadth.selectedCount).toBe(3);
  });
  it('does not compute features from a mismatched metadata symbol or precision', () => {
    const f = setup();
    f.input.market.instruments.find((m) => m.baseCode === 'ETH')!.baseCode = 'OTHER';
    expect(asset(run(f)).status).toBe('METADATA_MISMATCH');
    const g = setup();
    bar(g, 'cross:SPOT:ETH', 5).close = decimal('54.005');
    const r = run(g);
    expect(asset(r).grossReturn).toBeNull();
    expect(asset(r).slots.at(-1)!.status).toBe('PRECISION');
  });
  it('does not silently choose a price when metadata maps the provider symbol ambiguously', () => {
    const f = setup(),
      m = f.input.market.instruments[0]!;
    f.input.market.instruments.push({
      ...m,
      id: 'synthetic:ambiguous-meta',
      instrumentKey: 'synthetic:other-btc',
    });
    const r = run(f);
    expect(r.btc.status).toBe('METADATA_MISMATCH');
    expect(r.btc.grossReturn).toBeNull();
    expect(r.inputMetadataIds).toContain('synthetic:ambiguous-meta');
  });
  it('rejects multiple known source closes inside a nominal tolerance slot', () => {
    const f = setup(),
      b = bar(f, 'cross:SPOT:BTC', 5);
    f.request.joinToleranceMs = 1000;
    f.input.technical.bars.push({
      ...b,
      id: 'synthetic:extra-close',
      openAt: shift(b.openAt, -500000000n),
      closeAt: shift(b.closeAt, -500000000n),
      availableAt: shift(b.closeAt, -500000000n),
      provenance: { ...b.provenance, capturedAt: shift(b.closeAt, -500000000n) },
    });
    const r = run(f);
    expect(r.btc.slots.at(-1)!.status).toBe('AMBIGUOUS_SLOT');
    expect(r.btc.grossReturn).toBeNull();
  });
  it('keeps historical outputs stable when a later correction is appended', () => {
    const f = setup(),
      before = run(f),
      old = bar(f, 'cross:SPOT:BTC', 2);
    f.input.technical.bars.push({
      ...old,
      id: 'synthetic:late-correction',
      availableAt: at(600),
      close: decimal('999'),
      high: decimal('1000'),
      qualityFlags: ['SYNTHETIC', 'CORRECTED'],
      provenance: { ...old.provenance, capturedAt: at(600) },
    });
    expect(run(f)).toEqual(before);
  });
  it('does not bridge a missing interval in rolling return pairs', () => {
    const f = setup();
    bar(f, 'cross:SPOT:ETH', 3).availableAt = at(600);
    const r = run(f),
      c = asset(r).correlations.find((c) => c.lagBars === 0)!;
    expect(c.status).toBe('INSUFFICIENT_PAIRS');
    expect(c.pairs).toHaveLength(2);
    expect(asset(r).grossReturn).toBeNull();
    expect(c.pairs.some((p) => p.barIds.includes('cross:SPOT:ETH:bar:3'))).toBe(false);
  });
  it('enforces positive lag as BTC leading the asset', () => {
    const f = setup(390);
    f.request.lookbackBars = 5;
    returns(f, 'cross:SPOT:BTC', ['0.1', '-0.1', '0.2', '0', '0.05']);
    returns(f, 'cross:SPOT:ETH', ['0.03', '0.1', '-0.1', '0.2', '0']);
    const c = asset(run(f)).correlations.find((c) => c.lagBars === 1)!;
    expect(c).toMatchObject({
      status: 'COMPUTED',
      direction: 'BTC_LEADS_ASSET',
      value: '1',
      completeCoverage: true,
    });
    expect(c.pairs).toHaveLength(4);
    expect(c.pairs.every((p) => p.btcActualAt < p.assetActualAt)).toBe(true);
  });
  it('enforces negative lag as the asset leading BTC', () => {
    const f = setup(390);
    f.request.lookbackBars = 5;
    returns(f, 'cross:SPOT:ETH', ['0.1', '-0.1', '0.2', '0', '0.05']);
    returns(f, 'cross:SPOT:BTC', ['0.03', '0.1', '-0.1', '0.2', '0']);
    const c = asset(run(f)).correlations.find((c) => c.lagBars === -1)!;
    expect(c).toMatchObject({ status: 'COMPUTED', direction: 'ASSET_LEADS_BTC', value: '1' });
    expect(c.pairs.every((p) => p.assetActualAt < p.btcActualAt)).toBe(true);
  });
  it('reports constant-series correlations as undefined, while retaining genuine zero returns', () => {
    const f = setup();
    for (let i = 1; i <= 5; i++)
      Object.assign(bar(f, 'cross:SPOT:BTC', i), {
        open: '100',
        high: '100',
        low: '100',
        close: '100',
      });
    const r = run(f);
    expect(r.btc.grossReturn).toBe('0');
    expect(asset(r).relativeToBtc).toBe('0.08');
    expect(asset(r).correlations.find((c) => c.lagBars === 0)).toMatchObject({
      status: 'ZERO_VARIANCE',
      value: null,
    });
  });
  it('classifies a deterministic trend and a sideways path without conflating direction and volatility', () => {
    const r = run(setup());
    expect(asset(r).regime).toMatchObject({
      status: 'READY',
      trend: 'TRENDING',
      direction: 'UP',
      efficiency: '1',
      highVolatility: false,
    });
    expect(asset(r, 'cross:SPOT:SOL').regime).toMatchObject({
      status: 'READY',
      trend: 'RANGING',
      direction: 'FLAT',
      efficiency: '0',
      highVolatility: false,
    });
  });
  it('flags a sideways jump as high-volatility and leaves it ranging', () => {
    const f = setup();
    for (const [i, price] of [100, 100, 160, 100, 100].entries())
      Object.assign(bar(f, 'cross:SPOT:SOL', i + 1), {
        open: String(price),
        close: String(price),
        high: String(price),
        low: String(price),
      });
    expect(asset(run(f), 'cross:SPOT:SOL').regime).toMatchObject({
      trend: 'RANGING',
      direction: 'FLAT',
      highVolatility: true,
    });
  });
  it('allows high-volatility and trending flags to coexist', () => {
    const f = setup();
    for (const [i, price] of [100, 100, 100, 100, 200].entries())
      Object.assign(bar(f, 'cross:SPOT:SOL', i + 1), {
        open: String(price),
        close: String(price),
        high: String(price),
        low: String(price),
      });
    expect(asset(run(f), 'cross:SPOT:SOL').regime).toMatchObject({
      trend: 'TRENDING',
      direction: 'UP',
      efficiency: '1',
      highVolatility: true,
    });
  });
  it('treats a complete flat path as ranging, not warm-up or zero-filled missingness', () => {
    const f = setup();
    for (let i = 1; i <= 5; i++)
      Object.assign(bar(f, 'cross:SPOT:SOL', i), {
        open: '100',
        close: '100',
        high: '100',
        low: '100',
      });
    expect(asset(run(f), 'cross:SPOT:SOL').regime).toMatchObject({
      status: 'READY',
      trend: 'RANGING',
      direction: 'FLAT',
      volatility: '0',
      efficiency: '0',
    });
    expect(asset(run(setup(240))).regime.status).toBe('WARMUP_OR_GAP');
  });
  it('measures actual breadth and exchange-turnover concentration with explicit denominators', () => {
    const r = run(setup());
    expect(r.breadth).toMatchObject({
      selectedCount: 3,
      measuredCount: 3,
      advancing: 1,
      declining: 0,
      unchanged: 2,
      advancingFraction: '0.333333333333333333333333333333333333',
      coverageFraction: '1',
    });
    expect(Number(r.concentration.largestShare)).toBeCloseTo(5 / 11, 14);
    expect(Number(r.concentration.herfindahl)).toBeCloseTo(87 / 242, 14);
    const early = run(setup(300));
    expect(early.breadth).toMatchObject({
      selectedCount: 3,
      measuredCount: 2,
      advancingFraction: '0.5',
      coverageFraction: '0.666666666666666666666666666666666667',
    });
  });
  it('does not manufacture an empty-universe breadth or replace absent book liquidity with volume', () => {
    const f = setup();
    for (const o of f.input.market.observations) {
      o.quality = 'CANDLE_ONLY';
      o.liquidityQuote = null;
    }
    const r = run(f);
    expect(r.universe.selected).toEqual([]);
    expect(r.breadth.advancingFraction).toBeNull();
    expect(r.concentration.herfindahl).toBeNull();
    expect(asset(r).grossReturn).toBe('0.08');
  });
  it('audits ranking-excluded turnover inputs as well as selected instruments', () => {
    const f = setup();
    f.request.universe.count = 2;
    const r = run(f);
    expect(r.universe.excluded).toContainEqual({ instrumentKey: 'cross:SPOT:SOL', reason: 'RANK' });
    expect(r.inputMarketObservationIds.some((id) => id.startsWith('cross:SPOT:SOL:book:'))).toBe(
      true,
    );
  });
  it('gates funding and open interest by their own publication/availability clocks', () => {
    const f = setup(300),
      early = run(f),
      p = asset(early, 'cross:PERPETUAL:BTC');
    expect(asset(early).derivatives.fundingRate.status).toBe('NOT_APPLICABLE');
    expect(p.derivatives.fundingRate).toMatchObject({
      status: 'AVAILABLE',
      value: '0.001',
      publishedAt: at(245),
      availableAt: at(250),
    });
    expect(p.derivatives.openInterest.status).toBe('UNAVAILABLE');
    expect(early.inputDerivativeIds).not.toContain('synthetic:open-interest');
    f.request.featureAsOf = [at(330)];
    expect(asset(run(f), 'cross:PERPETUAL:BTC').derivatives.openInterest).toMatchObject({
      status: 'AVAILABLE',
      value: '1000',
      availableAt: at(320),
    });
  });
  it('never reads derivative fields from candle/book payloads without separate timing evidence', () => {
    const f = setup(300);
    for (const o of f.input.market.observations.filter(
      (o) => o.instrumentKey === 'cross:PERPETUAL:BTC',
    ))
      o.derivatives.openInterest = { status: 'KNOWN', value: decimal('999999') };
    expect(asset(run(f), 'cross:PERPETUAL:BTC').derivatives.openInterest).toMatchObject({
      status: 'UNAVAILABLE',
      value: null,
    });
  });
  it('retains optional missing, stale and unsupported derivative states', () => {
    const f = setup();
    f.input.derivatives = [];
    expect(asset(run(f), 'cross:PERPETUAL:BTC').derivatives.fundingRate.status).toBe('UNAVAILABLE');
    const g = setup();
    g.request.derivativeMaxAgeSeconds = 60;
    expect(asset(run(g), 'cross:PERPETUAL:BTC').derivatives.fundingRate.status).toBe('STALE');
    g.input.market.instruments.find((m) => m.marketType === 'PERPETUAL')!.derivatives.openInterest =
      'UNAVAILABLE';
    expect(asset(run(g), 'cross:PERPETUAL:BTC').derivatives.openInterest.status).toBe(
      'UNAVAILABLE',
    );
  });
  it('validates derivative chronology, nonnegative interest and unique evidence', () => {
    const f = setup(),
      d = f.input.derivatives[1]!;
    expect(DerivativeFeatureObservationSchema.safeParse({ ...d, value: '-1' }).success).toBe(false);
    expect(
      DerivativeFeatureObservationSchema.safeParse({ ...d, availableAt: at(300) }).success,
    ).toBe(false);
    f.input.derivatives.push(d);
    expect(() => run(f)).toThrow('Ambiguous derivative');
  });
  it('audits every joined bar, metadata record, metric and derivative against the common cutoff', () => {
    const f = setup(),
      r = run(f),
      t = r.featureAsOf;
    for (const a of [r.btc, ...r.assets, ...r.members])
      for (const s of a.slots)
        if (s.barId) {
          expect(s.actualCloseAt! <= s.nominalCloseAt).toBe(true);
          expect(s.availableAt! <= t).toBe(true);
        }
    for (const id of r.inputMetadataIds)
      expect(f.input.market.instruments.find((m) => m.id === id)!.availableAt! <= t).toBe(true);
    for (const id of r.inputMarketObservationIds)
      expect(f.input.market.observations.find((m) => m.id === id)!.availableAt! <= t).toBe(true);
    expect(r.maxInputAvailableAt! <= t).toBe(true);
    expect(r.maxInputEventAt! <= t).toBe(true);
    const changed = structuredClone(r);
    changed.btc.slots.at(-1)!.availableAt = at(999);
    expect(CrossFeatureRowSchema.safeParse(changed).success).toBe(false);
  });
  it('validates temporal bounds, join tolerance, work budgets and request field names', () => {
    const f = setup(),
      r = f.request;
    for (const bad of [
      { ...r, execute: true },
      { ...r, joinToleranceMs: 60000 },
      { ...r, intervalSeconds: 0 },
      { ...r, lagBars: [0, 0] },
      { ...r, targets: [] },
      { ...r, returnHorizonBars: 101 },
      { ...r, featureAsOf: [at(0)] },
      { ...r, generatedAt: at(0) },
    ])
      expect(CrossFeatureRequestSchema.safeParse(bad).success).toBe(false);
  });
  it('replays deterministically, freezes results and does not expose mutable caller data', () => {
    const f = setup(),
      engine = new SnapshotCrossFeatures(f.input),
      a = engine.evaluate(f.request);
    expect(canonicalHash(a)).toBe(canonicalHash(engine.evaluate(f.request)));
    Object.assign(f.input.technical.bars[0]!, { close: '999' });
    expect(canonicalHash(a)).toBe(canonicalHash(engine.evaluate(f.request)));
    expect(Object.isFrozen(a[0]!.assets)).toBe(true);
  });
  it('publishes immutable artifacts and detects altered values/catalogs', async () => {
    const f = setup(),
      root = await mkdtemp(join(tmpdir(), 'crypto-cross-features-'));
    dirs.push(root);
    const a = await writeCrossFeatureArtifact(f.input, f.request, root, 'synthetic:test'),
      b = await writeCrossFeatureArtifact(f.input, f.request, root, 'synthetic:test');
    expect(a.hash).toBe(b.hash);
    expect(await readdir(root)).toEqual([basename(a.path)]);
    const changed = structuredClone(a.artifact);
    changed.rows[0]!.assets[0]!.relativeToBtc = decimal('99');
    expect(() => validateCrossFeatureArtifact(changed)).toThrow('integrity');
    const wrong = join(root, 'wrong.json');
    await writeFile(wrong, await readFile(a.path));
    await expect(verifyCrossFeatureArtifact(wrong)).rejects.toThrow('name');
    await writeFile(a.path, JSON.stringify(changed));
    await expect(
      writeCrossFeatureArtifact(f.input, f.request, root, 'synthetic:test'),
    ).rejects.toThrow();
  });
  it('retains the iteration-one technical artifact identity and describes inference limits', () => {
    const f = technicalFeatureFixture(),
      old = buildTechnicalFeatureArtifact(
        f.input,
        f.request,
        'working-tree:sha256:0a0456500eab98d7d4456b1a64325a61ce4543a98638ae810c9920455060f600',
      );
    expect(canonicalHash(old)).toBe(
      'sha256:02ebd90d452927d9230a6e4b55b73aa6d3ee8307841d03d67989f6cf9663a6a9',
    );
    const c = setup(),
      report = crossFeatureReport(buildCrossFeatureArtifact(c.input, c.request, 'synthetic:test'));
    expect(report).toContain('do not establish causality');
    expect(report).toContain('not market-cap');
    expect(report).toContain('Direction');
  });
});
