import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { EventStudyRequestSchema } from '@crypto/contracts';
import type { EventStudyInput, EventStudyRequest } from '@crypto/contracts';
import { canonicalHash, fromEpoch, utc } from '@crypto/core';
import { buildEventStudyApp } from '@crypto/api';
import {
  eventStudyFixture,
  SnapshotEventStudy,
  buildEventStudyArtifact,
  validateEventStudyArtifact,
  verifyEventStudyArtifact,
  writeEventStudyArtifact,
} from '@crypto/research';

const fixture = eventStudyFixture(),
  directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0)) {
    if (dirname(resolve(path)) !== resolve(tmpdir()) || !basename(path).startsWith('crypto-study-'))
      throw new Error('Unsafe cleanup');
    await rm(path, { recursive: true, force: true });
  }
});
async function setup() {
  const f = await fixture;
  return structuredClone(f);
}
const bar = (input: EventStudyInput, asset: string, time: string) =>
  input.bars.find((b) => b.instrumentId === `${asset}/USDT` && b.closeAt === utc(time))!;
function run(input: EventStudyInput, request: EventStudyRequest, asset = 'ETH', label = '+5m') {
  return new SnapshotEventStudy(input)
    .run({ ...request, assets: request.assets.filter((a) => a.asset === asset) })
    .events[0]!.responses.find((r) => r.series.asset === asset)!
    .windows.find((w) => w.label === label)!;
}
// Fewer absent points for integrity/API tests; price arithmetic acceptance uses full 1m windows.
const coarse = (request: EventStudyRequest) => ({ ...request, intervalSeconds: 3600 as const });

describe('reproducible event study', () => {
  it('computes exact known signed/net/absolute and benchmark-adjusted returns and OHLC excursions', async () => {
    const { input, request } = await setup(),
      w = run(input, request);
    expect(w.status).toBe('COMPLETE');
    expect(w.grossReturn).toBe('0.2');
    expect(w.netReturn).toBe('0.199');
    expect(w.absoluteReturn).toBe('0.2');
    expect(w.benchmarkReturn).toBe('0');
    expect(w.benchmarkAdjustedReturn).toBe('0.2');
    expect(w.maxAdverseExcursion).toBe('-0.15');
    expect(w.maxFavorableExcursion).toBe('0.25');
    expect(w.maxDrawdown).toBe('0.181818181818181818181818181818181818');
    expect(w.observedBars).toBe(5);
    expect(w.barIds).toHaveLength(6);
    expect(w.missingCloseTimes).toEqual([]);
    // Independently computed sqrt(log(1.1)^2+log(9/11)^2+log(10/9)^2+log(1.1)^2+log(12/11)^2).
    expect(Number(w.realizedVolatility)).toBeCloseTo(0.277684365334535, 12);
  });
  it('keeps flat-price negative findings as genuine zero gross moves with explicit assumed cost', async () => {
    const { input, request } = await setup(),
      w = run(input, request, 'SOL');
    expect(w.grossReturn).toBe('0');
    expect(w.netReturn).toBe('-0.001');
    expect(w.absoluteReturn).toBe('0');
    expect(w.realizedVolatility).toBe('0');
    expect(w.maxDrawdown).toBe('0');
  });
  it('supports all long horizons when complete hourly history exists', async () => {
    const { input, request } = await setup(),
      anchor = BigInt(Date.parse(request.events[0]!.decisionAt));
    input.bars = request.assets.flatMap((series) =>
      Array.from({ length: 193 }, (_, i) => {
        const closeAt = fromEpoch(anchor + BigInt(i - 24) * 3600000n, 'milliseconds'),
          openAt = fromEpoch(anchor + BigInt(i - 25) * 3600000n, 'milliseconds'),
          template = input.bars.find((b) => b.instrumentId === series.instrumentId)!;
        return {
          ...template,
          id: `synthetic:hour:${series.asset}:${i}`,
          interval: { value: 1, unit: 'hours' as const },
          closeAt,
          openAt,
          open: template.close,
          high: template.close,
          low: template.close,
          availableAt: closeAt,
          provenance: { ...template.provenance, capturedAt: closeAt },
        };
      }),
    );
    const result = new SnapshotEventStudy(input).run(coarse(request));
    for (const w of result.events[0]!.responses[0]!.windows.filter((w) =>
      ['-24h', '-1h', '+1h', '+4h', '+24h', '+72h', '+7d'].includes(w.label),
    )) {
      expect(w.status).toBe('COMPLETE');
      expect(w.grossReturn).toBe('0');
    }
    expect(result.events[0]!.responses[0]!.windows.at(-1)!.observedBars).toBe(168);
  });
  it('uses signed benchmark subtraction and absolute magnitude for negative returns', async () => {
    const { input, request } = await setup();
    Object.assign(bar(input, 'ETH', '2026-01-01T09:22:00Z'), { close: '90', low: '85' });
    Object.assign(bar(input, 'BTC', '2026-01-01T09:22:00Z'), { close: '101', high: '101' });
    const w = run(input, request, 'ETH', '+1m');
    expect(w.grossReturn).toBe('-0.1');
    expect(w.absoluteReturn).toBe('0.1');
    expect(w.netReturn).toBe('-0.101');
    expect(w.benchmarkAdjustedReturn).toBe('-0.11');
  });
  it('keeps fractional prices in decimal arithmetic', async () => {
    const { input, request } = await setup();
    Object.assign(bar(input, 'ETH', '2026-01-01T09:21:00Z'), {
      open: '0.1',
      high: '0.1',
      low: '0.1',
      close: '0.1',
    });
    Object.assign(bar(input, 'ETH', '2026-01-01T09:22:00Z'), {
      open: '0.1',
      high: '0.3',
      low: '0.1',
      close: '0.3',
    });
    expect(run(input, request, 'ETH', '+1m').grossReturn).toBe('2');
  });
  it('excludes stale prices even when their availability timestamp passes', async () => {
    const { input, request } = await setup(),
      stale = bar(input, 'ETH', '2026-01-01T09:22:00Z');
    stale.qualityFlags.push('STALE');
    const w = run(input, request, 'ETH', '+1m');
    expect(w.grossReturn).toBeNull();
    expect(w.excludedBarIds).toContain(stale.id);
  });
  it('detects pre-event anticipation using the -1h start and event-decision close', async () => {
    const { input, request } = await setup();
    const first = bar(input, 'ETH', '2026-01-01T08:21:00Z');
    Object.assign(first, { open: '80', low: '80', high: '80', close: '80' });
    const w = run(input, request, 'ETH', '-1h');
    expect(w.status).toBe('COMPLETE');
    expect(w.grossReturn).toBe('0.25');
    expect(w.from).toBe(utc('2026-01-01T08:21:00Z'));
    expect(w.to).toBe(request.events[0]!.decisionAt);
  });
  it('flags an internal gap despite present endpoints and never extrapolates longer windows', async () => {
    const { input, request } = await setup();
    const removed = bar(input, 'ETH', '2026-01-01T09:23:00Z');
    input.bars = input.bars.filter((b) => b.id !== removed.id);
    const result = new SnapshotEventStudy(input).run(request),
      windows = result.events[0]!.responses[1]!.windows;
    expect(windows.find((w) => w.label === '+5m')).toMatchObject({
      status: 'PARTIAL',
      observedBars: 4,
      grossReturn: null,
      netReturn: null,
      maxAdverseExcursion: null,
      realizedVolatility: null,
    });
    expect(windows.find((w) => w.label === '-24h')!.grossReturn).toBeNull();
    for (const label of ['+4h', '+24h', '+72h', '+7d'])
      expect(windows.find((w) => w.label === label)).toMatchObject({
        status: 'PARTIAL',
        grossReturn: null,
      });
  });
  it('excludes an endpoint arriving one nanosecond after its simulated decision even when analysis is later', async () => {
    const { input, request } = await setup(),
      late = bar(input, 'ETH', '2026-01-01T09:22:00Z');
    late.availableAt = utc('2026-01-01T09:22:00.000000001Z');
    const w = run(input, request, 'ETH', '+1m');
    expect(w.status).toBe('PARTIAL');
    expect(w.endBarId).toBeNull();
    expect(w.excludedBarIds).toContain(late.id);
    expect(w.grossReturn).toBeNull();
  });
  it('does not replace the historical price with a later correction', async () => {
    const { input, request } = await setup(),
      original = bar(input, 'ETH', '2026-01-01T09:26:00Z');
    const correction = {
      ...original,
      id: 'synthetic:late-correction',
      availableAt: utc('2026-01-01T10:00:00Z'),
      open: original.open,
      close: original.high,
      qualityFlags: ['SYNTHETIC', 'CORRECTED'],
    };
    input.bars.push(correction as typeof original);
    const w = run(input, request);
    expect(w.grossReturn).toBe('0.2');
    expect(w.barIds).toContain(original.id);
    expect(w.excludedBarIds).toContain(correction.id);
  });
  it('requires the entry price to be known at the news decision', async () => {
    const { input, request } = await setup(),
      entry = bar(input, 'ETH', '2026-01-01T09:21:00Z');
    entry.availableAt = utc('2026-01-01T09:21:01Z');
    expect(run(input, request)).toMatchObject({
      status: 'PARTIAL',
      startBarId: null,
      grossReturn: null,
    });
  });
  it('does not borrow a benchmark from another source or fill an absent benchmark with zero', async () => {
    const { input, request } = await setup();
    request.benchmark.exchange = 'synthetic:absent';
    const w = run(input, request);
    expect(w.grossReturn).toBe('0.2');
    expect(w.benchmarkReturn).toBeNull();
    expect(w.benchmarkAdjustedReturn).toBeNull();
  });
  it('keeps future outcomes unobservable and does not expose their prices as metrics', async () => {
    const { input, request } = await setup();
    request.analysisAsOf = utc('2026-01-01T09:22:00Z');
    expect(run(input, request)).toMatchObject({
      status: 'NOT_YET_OBSERVABLE',
      observedBars: 1,
      grossReturn: null,
    });
  });
  it('does not resample unsupported short horizons from coarser bars', async () => {
    const { input, request } = await setup();
    expect(run(input, coarse(request))).toMatchObject({
      status: 'UNSUPPORTED_INTERVAL',
      grossReturn: null,
    });
  });
  it('freezes the early unverified event without later official status or corrections', async () => {
    const { input, request } = await setup(),
      result = new SnapshotEventStudy(input).run(coarse(request));
    expect(result.events[0]!.event.status).toBe('UNVERIFIED');
    expect(result.events[0]!.event.history.firstOfficialStatement).toBeNull();
    expect(result.events[0]!.event.history.corrections).toEqual([]);
    expect(result.events[0]!.event.availableAt! <= request.events[0]!.decisionAt).toBe(true);
  });
  it('rejects an event before receipt, a future snapshot cutoff and unknown event IDs', async () => {
    const { input, request } = await setup(),
      study = new SnapshotEventStudy(input);
    for (const selection of [
      { eventId: request.events[0]!.eventId, decisionAt: utc('2026-01-01T08:00:00Z') },
      { eventId: request.events[0]!.eventId, decisionAt: utc('2026-01-01T12:00:00Z') },
      { eventId: 'synthetic:unknown', decisionAt: request.events[0]!.decisionAt },
    ])
      expect(() => study.run({ ...coarse(request), events: [selection] })).toThrow();
  });
  it('quarantines descriptive-only/estimated prices and absent assets', async () => {
    const { input, request } = await setup(),
      point = bar(input, 'ETH', '2026-01-01T09:22:00Z');
    point.researchUse = 'DESCRIPTIVE_ONLY';
    point.availabilityBasis = 'ESTIMATED';
    expect(run(input, request, 'ETH', '+1m').grossReturn).toBeNull();
    request.assets[1]!.instrumentId = 'UNKNOWN/USDT';
    expect(run(input, request).status).toBe('MISSING');
  });
  it('rejects ambiguous versions, duplicate IDs and unlabelled synthetic bars', async () => {
    const { input } = await setup(),
      first = input.bars[0]!;
    expect(() => new SnapshotEventStudy({ ...input, bars: [...input.bars, first] })).toThrow();
    expect(
      () =>
        new SnapshotEventStudy({
          ...input,
          bars: [...input.bars, { ...first, id: 'synthetic:ambiguous' }],
        }),
    ).toThrow();
    first.qualityFlags = [];
    expect(() => new SnapshotEventStudy(input)).toThrow('synthetic');
  });
  it('rejects unknown request fields, invalid clocks/costs, duplicated assets and reversed dates', async () => {
    const { request } = await setup();
    for (const bad of [
      { ...request, execute: true },
      { ...request, clock: 'LOCAL' },
      { ...request, roundTripCostBps: -1 },
      { ...request, assets: [request.assets[0], request.assets[0]] },
      { ...request, generatedAt: '2025-01-01T00:00:00Z' },
    ])
      expect(EventStudyRequestSchema.safeParse(bad).success).toBe(false);
  });
  it('replays deterministically, freezes copies and rejects tampered news evidence', async () => {
    const { input, request } = await setup(),
      study = new SnapshotEventStudy(input),
      r = coarse(request),
      first = study.run(r),
      hash = canonicalHash(first);
    Object.assign(input.bars[0]!, { close: '999' });
    expect(canonicalHash(study.run(r))).toBe(hash);
    expect(Object.isFrozen(first.events[0]!.event)).toBe(true);
    expect(Object.isFrozen(study.input.bars)).toBe(true);
    const changed = structuredClone(study.input);
    changed.newsSnapshot.inputHash = canonicalHash('changed');
    expect(() => new SnapshotEventStudy(changed)).toThrow('integrity');
  });
  it('preserves sub-millisecond decision timestamps without silently rounding entry onto a bar', async () => {
    const { input, request } = await setup();
    request.events[0]!.decisionAt = fromEpoch(
      BigInt(Date.parse(request.events[0]!.decisionAt)) * 1000000n + 1n,
      'nanoseconds',
    );
    expect(run(input, request, 'ETH', '+1m')).toMatchObject({
      status: 'MISSING',
      grossReturn: null,
    });
  });
  it('atomically publishes and semantically verifies immutable, content-addressed artifacts', async () => {
    const { input, request } = await setup(),
      root = await mkdtemp(join(tmpdir(), 'crypto-study-'));
    directories.push(root);
    const r = coarse(request),
      first = await writeEventStudyArtifact(input, r, root, 'synthetic:test'),
      second = await writeEventStudyArtifact(input, r, root, 'synthetic:test');
    expect(second.hash).toBe(first.hash);
    expect(await readdir(root)).toEqual([basename(first.path)]);
    const parsed = JSON.parse(await readFile(first.path, 'utf8')) as unknown;
    expect(canonicalHash(validateEventStudyArtifact(parsed))).toBe(first.hash);
    const tampered = structuredClone(first.artifact);
    tampered.result.events[0]!.benchmarkWindows[0]!.grossReturn = null;
    tampered.result.configHash = canonicalHash('tampered');
    expect(() => validateEventStudyArtifact(tampered)).toThrow();
    await writeFile(first.path, JSON.stringify(tampered));
    await expect(verifyEventStudyArtifact(first.path)).rejects.toThrow();
    await expect(writeEventStudyArtifact(input, r, root, 'synthetic:test')).rejects.toThrow();
  });
  it('rejects invalid artifact filenames and preserves code/config/input identity', async () => {
    const { input, request } = await setup(),
      r = coarse(request),
      a = buildEventStudyArtifact(input, r, 'synthetic:one'),
      b = buildEventStudyArtifact(input, r, 'synthetic:two');
    expect(canonicalHash(a)).not.toBe(canonicalHash(b));
    const root = await mkdtemp(join(tmpdir(), 'crypto-study-'));
    directories.push(root);
    const path = join(root, 'wrong.json');
    await writeFile(path, JSON.stringify(a));
    await expect(verifyEventStudyArtifact(path)).rejects.toThrow('name');
  });
  it('serves validated queries, rejects uploads and sanitizes API errors', async () => {
    const { input, request } = await setup(),
      app = buildEventStudyApp(new SnapshotEventStudy(input));
    try {
      const good = await app.inject({
        method: 'POST',
        url: '/research/event-study',
        payload: coarse(request),
      });
      expect(good.statusCode).toBe(200);
      expect(good.headers['cache-control']).toBe('no-store');
      expect(good.json<{ execution: string }>().execution).toBe('DISABLED');
      const bad = await app.inject({
        method: 'POST',
        url: '/research/event-study',
        payload: { ...request, secret: 'SENTINEL' },
      });
      expect(bad.statusCode).toBe(400);
      expect(bad.body).not.toContain('SENTINEL');
      const large = await app.inject({
        method: 'POST',
        url: '/research/event-study',
        payload: { padding: 'x'.repeat(17000) },
      });
      expect(large.statusCode).toBe(413);
    } finally {
      await app.close();
    }
  });
});
