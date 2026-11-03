import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { EventControlsRequestSchema, compareDecimal, utcNanoseconds } from '@crypto/contracts';
import type { EventStudyInput, EventControlsRequest } from '@crypto/contracts';
import { addDecimal, canonicalHash, decimal, fromEpoch, multiplyDecimal, utc } from '@crypto/core';
import { buildEventControlsApp } from '@crypto/api';
import {
  eventControlsFixture,
  eventControlsReport,
  SnapshotEventControls,
  buildEventControlsArtifact,
  validateEventControlsArtifact,
  verifyEventControlsArtifact,
  writeEventControlsArtifact,
  eventStudyFixture,
  buildEventStudyArtifact,
} from '@crypto/research';

const corpus = eventControlsFixture(),
  directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0)) {
    if (
      dirname(resolve(path)) !== resolve(tmpdir()) ||
      !basename(path).startsWith('crypto-controls-')
    )
      throw new Error('Unsafe cleanup');
    await rm(path, { recursive: true, force: true });
  }
});
const setup = async () => structuredClone(await corpus);
const shift = (at: string, seconds: number) =>
  fromEpoch(utcNanoseconds(utc(at)) + BigInt(seconds) * 1000000000n, 'nanoseconds');
const point = (input: EventStudyInput, asset: string, at: string) =>
  input.bars.find((b) => b.instrumentId === `${asset}/USDT` && b.closeAt === utc(at))!;
const run = (input: EventStudyInput, request: EventControlsRequest) =>
  new SnapshotEventControls(input).run(request);
const response = (result: ReturnType<typeof run>, asset = 'ETH') =>
  result.events[0]!.responses.find((r) => r.series.asset === asset)!;
function controlsAt(request: EventControlsRequest, seconds: number) {
  request.controls.from = shift(request.study.events[0]!.decisionAt, seconds);
  request.controls.to = request.controls.from;
}
function setReturns(input: EventStudyInput, asset: string, at: string, returns: string[]) {
  let previous = decimal('100');
  Object.assign(point(input, asset, at), {
    open: previous,
    high: previous,
    low: previous,
    close: previous,
  });
  for (let i = 0; i < returns.length; i++) {
    const close = multiplyDecimal(previous, addDecimal(decimal('1'), decimal(returns[i]!)));
    Object.assign(point(input, asset, shift(at, (i + 1) * 60)), {
      open: previous,
      close,
      high: compareDecimal(previous, close) > 0 ? previous : close,
      low: compareDecimal(previous, close) < 0 ? previous : close,
    });
    previous = close;
  }
}

describe('cross-asset event controls', () => {
  it('fits exact pre-decision BTC beta and computes factor/basket residuals', async () => {
    const { input, request } = await setup(),
      result = run(input, request),
      eth = response(result);
    expect(eth.fit).toMatchObject({
      status: 'FITTED',
      alpha: '0',
      beta: '2',
      pairs: 6,
      to: shift(request.study.events[0]!.decisionAt, -60),
    });
    expect(eth.grossReturn).toBe('0.1');
    expect(eth.netReturn).toBe('0.099');
    expect(eth.btcBetaAdjustedReturn).toBe('0.1');
    // Independently simplified rational: .1 - (123578/123750 - 1) = 12547/123750.
    expect(eth.marketModelAdjustedReturn).toBe('0.10138989898989898989898989898989899');
    expect(result.events[0]!.basketReturn).toBe('-0.05');
    expect(eth.relativeToBasket).toBe('0.15');
    expect(result.events[0]!.cohortComplete).toBe(true);
  });
  it('does not refit beta with post-event outcomes', async () => {
    const { input, request } = await setup(),
      before = response(run(input, request)).fit;
    setReturns(input, 'ETH', request.study.events[0]!.decisionAt, [
      '0.5',
      '0.2',
      '-0.4',
      '0.1',
      '0',
    ]);
    expect(response(run(input, request)).fit).toEqual(before);
  });
  it('reports zero factor variance without inventing beta or dividing by zero', async () => {
    const { input, request } = await setup(),
      at = request.study.events[0]!.decisionAt;
    for (let i = 1; i <= 7; i++)
      Object.assign(point(input, 'BTC', shift(at, -60 * i)), {
        open: '100',
        high: '100',
        low: '100',
        close: '100',
      });
    const r = response(run(input, request));
    expect(r.fit.status).toBe('ZERO_FACTOR_VARIANCE');
    expect(r.fit.beta).toBeNull();
    expect(r.marketModelAdjustedReturn).toBeNull();
    expect(r.factorAdjustmentStatus).toBe('UNFITTED');
  });
  it('flags a market-model projection that implies a nonpositive price', async () => {
    const { input, request } = await setup(),
      at = request.study.events[0]!.decisionAt;
    Object.assign(point(input, 'BTC', shift(at, 60)), { close: '40', low: '40', high: '100' });
    const r = response(run(input, request));
    expect(r.fit.beta).toBe('2');
    expect(r.factorAdjustmentStatus).toBe('INVALID_PROJECTION');
    expect(r.marketModelAdjustedReturn).toBeNull();
    expect(r.btcBetaAdjustedReturn).toBe('0.1');
  });
  it('rejects a late pre-event fit observation despite a later analysis cutoff', async () => {
    const { input, request } = await setup(),
      bar = point(input, 'ETH', shift(request.study.events[0]!.decisionAt, -120));
    bar.availableAt = fromEpoch(utcNanoseconds(bar.closeAt) + 1n, 'nanoseconds');
    const result = run(input, request),
      r = response(result);
    expect(r.fit.status).toBe('INCOMPLETE');
    expect(r.grossReturn).toBe('0.1');
    expect(r.btcBetaAdjustedReturn).toBeNull();
    expect(r.baseline.frequency).toBeNull();
    expect(result.events[0]!.candidates.every((c) => c.status === 'EVENT_INCOMPLETE')).toBe(true);
  });
  it('does not renormalize a basket with an unavailable constituent', async () => {
    const { input, request } = await setup(),
      at = request.study.events[0]!.decisionAt;
    input.bars = input.bars.filter((b) => b.id !== point(input, 'SOL', at).id);
    const result = run(input, request);
    expect(result.events[0]!.basketReturn).toBeNull();
    expect(response(result).relativeToBasket).toBeNull();
    expect(response(result).grossReturn).toBe('0.1');
  });
  it('gives positive lag the explicit meaning BTC leads the asset', async () => {
    const { input, request } = await setup(),
      at = request.study.events[0]!.decisionAt;
    setReturns(input, 'BTC', at, ['0.1', '-0.1', '0.2', '0', '0.05']);
    setReturns(input, 'ETH', at, ['0.03', '0.1', '-0.1', '0.2', '0']);
    const lag = response(run(input, request)).lags.find(
      (l) => l.segment === 'POST_EVENT' && l.lagBars === 1,
    )!;
    expect(lag).toMatchObject({
      direction: 'BTC_LEADS_ASSET',
      status: 'COMPUTED',
      correlation: '1',
    });
    expect(lag.pairs).toHaveLength(4);
    for (const p of lag.pairs) {
      expect(p.assetAt).toBe(shift(p.factorAt, 60));
      expect(p.pairKnownAt).toBe(p.assetAt);
    }
  });
  it('gives negative lag the explicit reverse direction', async () => {
    const { input, request } = await setup(),
      at = request.study.events[0]!.decisionAt;
    setReturns(input, 'ETH', at, ['0.1', '-0.1', '0.2', '0', '0.05']);
    setReturns(input, 'BTC', at, ['0.03', '0.1', '-0.1', '0.2', '0']);
    const lag = response(run(input, request)).lags.find(
      (l) => l.segment === 'POST_EVENT' && l.lagBars === -1,
    )!;
    expect(lag).toMatchObject({
      direction: 'ASSET_LEADS_BTC',
      status: 'COMPUTED',
      correlation: '1',
    });
    for (const p of lag.pairs) {
      expect(p.factorAt).toBe(shift(p.assetAt, 60));
      expect(p.pairKnownAt).toBe(p.factorAt);
    }
  });
  it('never bridges a missing/late interval in lag pairs', async () => {
    const { input, request } = await setup(),
      late = point(input, 'ETH', shift(request.study.events[0]!.decisionAt, 120));
    late.availableAt = fromEpoch(utcNanoseconds(late.closeAt) + 1n, 'nanoseconds');
    const r = response(run(input, request)),
      lag = r.lags.find((l) => l.segment === 'POST_EVENT' && l.lagBars === 1)!;
    expect(r.grossReturn).toBeNull();
    expect(lag.status).toBe('INSUFFICIENT_PAIRS');
    expect(lag.pairs).toHaveLength(2);
    expect(lag.pairs.some((p) => p.assetBarId === late.id)).toBe(false);
    expect(r.coverage.excludedBarIds).toContain(late.id);
  });
  it('keeps constant-series correlation unknown rather than zero', async () => {
    const { input, request } = await setup(),
      r = response(run(input, request), 'SOL'),
      lag = r.lags.find((l) => l.segment === 'PRE_EVENT' && l.lagBars === 0)!;
    expect(lag.status).toBe('ZERO_VARIANCE');
    expect(lag.correlation).toBeNull();
  });
  it('samples reproducibly without replacement and publishes the empirical denominator', async () => {
    const { input, request } = await setup(),
      a = run(input, request),
      b = run(input, request),
      e = a.events[0]!;
    expect(canonicalHash(a)).toBe(canonicalHash(b));
    expect(e.controls).toHaveLength(4);
    expect(new Set(e.controls.map((c) => c.at)).size).toBe(4);
    for (const r of e.responses) {
      const count = e.controls.filter(
        (c) =>
          compareDecimal(
            c.responses.find((v) => v.asset === r.series.asset)!.absoluteReturn!,
            r.absoluteReturn!,
          ) >= 0,
      ).length;
      expect(r.baseline.selectedControls).toBe(4);
      expect(r.baseline.atLeastAsLarge).toBe(count);
      expect(Number(r.baseline.frequency)).toBe(count / 4);
    }
    request.controls.seed = 43;
    expect(run(input, request).events[0]!.controls.map((c) => c.at)).not.toEqual(
      e.controls.map((c) => c.at),
    );
  });
  it('requires the same complete joint universe and interval count for every control', async () => {
    const { input, request } = await setup();
    controlsAt(request, -7200);
    const late = point(input, 'ETH', shift(request.controls.from, 120));
    late.availableAt = shift(late.closeAt, 1);
    const e = run(input, request).events[0]!;
    expect(e.candidates[0]!.status).toBe('INCOMPLETE_COVERAGE');
    expect(e.controls).toHaveLength(0);
    expect(e.responses[1]!.baseline.frequency).toBeNull();
    expect(e.responses[1]!.coverage.expectedBars).toBe(5);
  });
  it('counts equal recurring decimal moves at the declared metric precision', async () => {
    const { input, request } = await setup();
    controlsAt(request, -7200);
    for (const at of [request.study.events[0]!.decisionAt, request.controls.from]) {
      Object.assign(point(input, 'ETH', at), { open: '3', high: '3', low: '3', close: '3' });
      Object.assign(point(input, 'ETH', shift(at, 300)), { close: '4', low: '4' });
    }
    const r = response(run(input, request));
    expect(r.baseline).toMatchObject({ selectedControls: 1, atLeastAsLarge: 1, frequency: '1' });
  });
  it('excludes control fits/outcomes overlapping observed news or the selected event response', async () => {
    const { input, request } = await setup();
    controlsAt(request, 600);
    expect(run(input, request).events[0]!.candidates[0]!.status).toBe('NEWS_BLACKOUT');
    controlsAt(request, 0);
    expect(run(input, request).events[0]!.candidates[0]!.status).toBe('NEWS_BLACKOUT');
  });
  it('does not claim absence of news beyond the frozen snapshot cutoff', async () => {
    const { input, request } = await setup();
    controlsAt(request, 6000);
    expect(run(input, request).events[0]!.candidates[0]!.status).toBe('AFTER_NEWS_CUTOFF');
  });
  it('matches only pre-event volatility and retains genuine no-match results', async () => {
    const { input, request } = await setup();
    request.controls.volatilityTolerance = decimal('0');
    let e = run(input, request).events[0]!;
    expect(e.controls).toHaveLength(0);
    expect(e.candidates.some((c) => c.status === 'VOLATILITY_MISMATCH')).toBe(true);
    expect(e.responses[1]!.baseline.frequency).toBeNull();
    request.controls.volatilityTolerance = decimal('10');
    e = run(input, request).events[0]!;
    expect(e.controls).toHaveLength(4);
  });
  it('matches UTC time of day without losing a one-nanosecond boundary', async () => {
    const { input, request } = await setup();
    request.controls.timeOfDayToleranceSeconds = 0;
    controlsAt(request, -86400);
    expect(run(input, request).events[0]!.candidates[0]!.status).toBe('INCOMPLETE_COVERAGE');
    request.controls.from = fromEpoch(utcNanoseconds(request.controls.from) + 1n, 'nanoseconds');
    request.controls.to = request.controls.from;
    expect(run(input, request).events[0]!.candidates[0]!.status).toBe('TIME_OF_DAY_MISMATCH');
  });
  it('reports actual recovery and explicit administrative right-censoring', async () => {
    const { input, request } = await setup(),
      result = run(input, request),
      at = request.study.events[0]!.decisionAt;
    expect(response(result).recovery).toMatchObject({
      status: 'RECOVERED',
      firstBelowAt: shift(at, 60),
      recoveredAt: shift(at, 240),
      recoverySeconds: 240,
      censorAt: null,
    });
    expect(response(result, 'SOL').recovery).toMatchObject({
      status: 'RIGHT_CENSORED',
      recoverySeconds: null,
      censorAt: shift(at, 300),
      censorReason: 'HORIZON_END',
    });
  });
  it('censors at the last continuous observation before a gap, ignoring a later apparent recovery', async () => {
    const { input, request } = await setup(),
      at = request.study.events[0]!.decisionAt,
      gap = point(input, 'SOL', shift(at, 180));
    input.bars = input.bars.filter((b) => b.id !== gap.id);
    Object.assign(point(input, 'SOL', shift(at, 240)), { close: '50', high: '50' });
    expect(response(run(input, request), 'SOL').recovery).toMatchObject({
      status: 'RIGHT_CENSORED',
      censorAt: shift(at, 120),
      censorReason: 'DATA_GAP',
      recoverySeconds: null,
    });
  });
  it('censors at the analysis cutoff without using future recovery prices', async () => {
    const { input, request } = await setup(),
      at = request.study.events[0]!.decisionAt;
    request.study.analysisAsOf = shift(at, 60);
    const r = response(run(input, request));
    expect(r.grossReturn).toBeNull();
    expect(r.recovery).toMatchObject({
      status: 'RIGHT_CENSORED',
      censorAt: shift(at, 60),
      censorReason: 'ANALYSIS_CUTOFF',
    });
    for (const lag of r.lags.filter((l) => l.segment === 'POST_EVENT'))
      expect(lag.pairs.every((p) => p.pairKnownAt <= request.study.analysisAsOf)).toBe(true);
  });
  it('distinguishes no drawdown, missing entry and incomplete coverage before any decline', async () => {
    const { input, request } = await setup(),
      at = request.study.events[0]!.decisionAt;
    setReturns(input, 'SOL', at, ['0', '0', '0', '0', '0']);
    expect(response(run(input, request), 'SOL').recovery).toMatchObject({
      status: 'NO_DRAWDOWN',
      recoverySeconds: null,
    });
    const first = point(input, 'SOL', shift(at, 60));
    input.bars = input.bars.filter((b) => b.id !== first.id);
    expect(response(run(input, request), 'SOL').recovery.status).toBe('INSUFFICIENT_COVERAGE');
    const entry = point(input, 'SOL', at);
    input.bars = input.bars.filter((b) => b.id !== entry.id);
    expect(response(run(input, request), 'SOL').recovery.status).toBe('MISSING_ENTRY');
  });
  it('drills down by frozen taxonomy and does not treat an empty filter result as zero movement', async () => {
    const { input, request } = await setup(),
      full = run(input, request);
    expect(full.events[0]!.taxonomy).toEqual(['SECURITY_INCIDENT']);
    request.taxonomyFilter = ['RATE_ANNOUNCEMENT'];
    const empty = run(input, request);
    expect(empty.events).toEqual([]);
    expect(empty.excludedByTaxonomy).toHaveLength(1);
    expect(empty.concentration.herfindahl).toBeNull();
    expect(empty.taxonomyGroups).toEqual([]);
  });
  it('reports repeated events and overlapping outcomes as concentrated observations', async () => {
    const { input, request } = await setup(),
      selection = request.study.events[0]!;
    request.study.events.push({ ...selection, decisionAt: shift(selection.decisionAt, 60) });
    const r = run(input, request);
    expect(r.concentration).toMatchObject({
      selectedObservations: 2,
      uniqueEventIds: 1,
      overlappingObservationPairs: 1,
      herfindahl: '1',
      largestShare: '1',
    });
    expect(r.concentration.groups).toHaveLength(1);
    expect(r.taxonomyGroups[0]).toMatchObject({
      observations: 2,
      uniqueEvents: 1,
      completeResponses: 6,
    });
  });
  it('keeps event-specific sampling stable when selected event decisions are reordered', async () => {
    const { input, request } = await setup(),
      selection = request.study.events[0]!;
    request.study.events.push({ ...selection, decisionAt: shift(selection.decisionAt, 60) });
    const a = run(input, request);
    request.study.events.reverse();
    const b = run(input, request);
    for (const e of a.events)
      expect(b.events.find((v) => v.decisionAt === e.decisionAt)!.controls).toEqual(e.controls);
  });
  it('reports overlapping sampled controls instead of implying independent samples', async () => {
    const { input, request } = await setup();
    request.controls.to = shift(request.controls.from, 240);
    request.controls.strideSeconds = 60;
    request.controls.sampleCount = 5;
    expect(run(input, request).events[0]!.overlappingControlPairs).toBe(10);
  });
  it('preserves missing concentration mass as null', async () => {
    const { input, request } = await setup();
    input.bars = [];
    const r = run(input, request);
    expect(r.concentration.groups[0]!.absoluteMovement).toBeNull();
    expect(r.concentration.completeResponses).toBe(0);
    expect(r.concentration.herfindahl).toBeNull();
    expect(response(r).baseline.frequency).toBeNull();
  });
  it('rejects invalid weights, clocks, duplicate lags, zero stride, oversized grids and unaligned horizons', async () => {
    const { request } = await setup();
    const bad = [
      { ...request, execute: true },
      { ...request, basket: [{ ...request.basket[0], weightBps: 1 }] },
      { ...request, lags: [1, 1] },
      { ...request, controls: { ...request.controls, strideSeconds: 0 } },
      {
        ...request,
        controls: { ...request.controls, to: shift(request.controls.from, 256 * 600) },
      },
      { ...request, study: { ...request.study, intervalSeconds: 3600 } },
      { ...request, factor: { ...request.factor, asset: 'ETH' } },
    ];
    for (const value of bad)
      expect(EventControlsRequestSchema.safeParse(value).success).toBe(false);
  });
  it('rebuilds and validates immutable controls artifacts and rejects metric/candidate tampering', async () => {
    const { input, request } = await setup(),
      root = await mkdtemp(join(tmpdir(), 'crypto-controls-'));
    controlsAt(request, -7200);
    const anchor = request.study.events[0]!.decisionAt,
      control = request.controls.from;
    input.bars = input.bars.filter(
      (b) =>
        (b.closeAt >= shift(anchor, -420) && b.closeAt <= shift(anchor, 300)) ||
        (b.closeAt >= shift(control, -420) && b.closeAt <= shift(control, 300)),
    );
    directories.push(root);
    const a = await writeEventControlsArtifact(input, request, root, 'synthetic:test'),
      b = await writeEventControlsArtifact(input, request, root, 'synthetic:test');
    expect(a.hash).toBe(b.hash);
    expect(await readdir(root)).toEqual([basename(a.path)]);
    expect(Object.isFrozen(a.artifact.result.events)).toBe(true);
    const changed = structuredClone(a.artifact);
    changed.result.events[0]!.responses[1]!.fit.beta = decimal('3');
    expect(() => validateEventControlsArtifact(changed)).toThrow('integrity');
    const changedCandidate = structuredClone(a.artifact);
    changedCandidate.result.events[0]!.candidates[0]!.status = 'NEWS_BLACKOUT';
    expect(() => validateEventControlsArtifact(changedCandidate)).toThrow('integrity');
    const wrong = join(root, 'wrong.json');
    await writeFile(wrong, await readFile(a.path));
    await expect(verifyEventControlsArtifact(wrong)).rejects.toThrow('name');
    await writeFile(a.path, JSON.stringify(changed));
    await expect(verifyEventControlsArtifact(a.path)).rejects.toThrow();
    await expect(
      writeEventControlsArtifact(input, request, root, 'synthetic:test'),
    ).rejects.toThrow();
  }, 30000);
  it('binds seed and software version into reproducible artifacts', async () => {
    const { input, request } = await setup(),
      a = buildEventControlsArtifact(input, request, 'synthetic:one');
    expect(canonicalHash(a)).not.toBe(
      canonicalHash(buildEventControlsArtifact(input, request, 'synthetic:two')),
    );
    request.controls.seed = 43;
    expect(canonicalHash(a)).not.toBe(
      canonicalHash(buildEventControlsArtifact(input, request, 'synthetic:one')),
    );
  });
  it('retains the original iteration-one artifact identity after sharing its price gate', async () => {
    const f = await eventStudyFixture(),
      artifact = buildEventStudyArtifact(
        f.input,
        f.request,
        'working-tree:sha256:13e0f95033181bc1fcc09f7a4e2bdc4cefcf8ea2132933126544c8f728bfa4fa',
      );
    expect(canonicalHash(artifact)).toBe(
      'sha256:898b59cf6305f568afec200e2ad032e928d2806b105df00299af2eee7e7113d9',
    );
  });
  it('serves strict controls queries and describes correlation, censoring and empirical sample limits', async () => {
    const { input, request } = await setup(),
      app = buildEventControlsApp(new SnapshotEventControls(input));
    try {
      const good = await app.inject({
        method: 'POST',
        url: '/research/event-controls',
        payload: request,
      });
      expect(good.statusCode).toBe(200);
      expect(good.headers['cache-control']).toBe('no-store');
      const result = run(input, request),
        report = eventControlsReport(result);
      expect(report).toContain('do not establish causality');
      expect(report).toContain('RIGHT_CENSORED');
      expect(report).toContain('not p-values');
      const bad = await app.inject({
        method: 'POST',
        url: '/research/event-controls',
        payload: { ...request, privateKey: 'SENTINEL' },
      });
      expect(bad.statusCode).toBe(400);
      expect(bad.body).not.toContain('SENTINEL');
      const large = await app.inject({
        method: 'POST',
        url: '/research/event-controls',
        payload: { padding: 'x'.repeat(17000) },
      });
      expect(large.statusCode).toBe(413);
    } finally {
      await app.close();
    }
  });
});
