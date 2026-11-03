import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StreamConfigSchema, StreamStepSchema } from '@crypto/contracts';
import type { StreamInput, StreamStep } from '@crypto/contracts';
import { canonicalHash, fromEpoch } from '@crypto/core';
import {
  BinancePublicStream,
  decodeBinanceDepth,
  DepthStreamState,
  isStreamUsableAt,
  parseStreamJson,
  retryAfterMs,
  runMarketStream,
  StreamRequestBudget,
  StreamTransportError,
  streamNow,
  syntheticStreamConfig,
  syntheticStreamSteps,
} from '@crypto/connectors';
import type { MarketStream } from '@crypto/connectors';
import { replayStreamRecording, writeStreamRecording } from '@crypto/research';

const config = syntheticStreamConfig;
const at = (offset: number) => fromEpoch(1767225600000n + BigInt(offset), 'milliseconds');
type WithoutReceipt<T> = T extends unknown ? Omit<T, 'observedAt'> : never;
function step(offset: number, input: WithoutReceipt<StreamInput>, processed = offset): StreamStep {
  return StreamStepSchema.parse({
    schemaVersion: 'market-stream-step.v1',
    input: { ...input, observedAt: at(offset) },
    processedAt: at(processed),
  });
}
const tick = (time: number, connection = 1) => step(time, { kind: 'TICK', connection });
const delta = (time: number, first: string, last = first, eventTime = time) =>
  step(time, {
    kind: 'DELTA',
    connection: 1,
    first,
    last,
    occurredAt: at(eventTime),
    bids: [],
    asks: [],
    raw: `synthetic delta ${first}:${last}`,
  });
function ready() {
  const state = new DepthStreamState(config);
  for (const event of syntheticStreamSteps().slice(0, 4)) state.consume(event);
  return state;
}
const directories: string[] = [];
async function temporary() {
  const dir = await mkdtemp(join(tmpdir(), 'crypto-stream-'));
  directories.push(dir);
  return dir;
}
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('causal public depth state', () => {
  it('buffers before REST, bridges later, and never backdates recovery availability', () => {
    const state = new DepthStreamState(config),
      events = syntheticStreamSteps();
    const views = events.slice(0, 4).map((event) => state.consume(event));
    expect(views.map((v) => v.usable)).toEqual([false, false, false, true]);
    const quote = views[3]!;
    expect(quote.observedAt).toBe(at(20));
    expect(quote.occurredAt).toBe(at(20));
    expect(quote.availableAt).toBe(at(30));
    expect(quote.sequence).toBe('101');
    expect(isStreamUsableAt(quote, at(29))).toBe(false);
    expect(isStreamUsableAt(quote, at(30))).toBe(true);
    expect(Object.isFrozen(quote.bids[0])).toBe(true);
  });
  it('invalidates a packet gap and reordering until a new REST snapshot bridges it', () => {
    const state = new DepthStreamState(config),
      events = syntheticStreamSteps();
    const views = events.map((event) => state.consume(event));
    expect(views[4]?.status).toBe('GAP');
    expect(views[5]?.usable).toBe(false);
    expect(views[6]?.usable).toBe(true);
    expect(views[6]?.sequence).toBe('103');
    expect(views[6]?.observedAt).toBe(at(40));
    expect(views[6]?.availableAt).toBe(at(60));
    expect(views[8]?.status).toBe('STALE');
    expect(views[9]?.status).toBe('DISCONNECTED');
    expect(views[10]?.status).toBe('SYNCING');
    expect(views[11]?.status).toBe('STOPPED');
  });
  it('duplicates and timer heartbeats cannot refresh market freshness', () => {
    const state = ready(),
      quote = state.consume(delta(500, '101'));
    expect(quote.observedAt).toBe(at(20));
    expect(state.consume(tick(2100)).status).toBe('STALE');
    expect(isStreamUsableAt(quote, at(2020))).toBe(false);
  });
  it('a snapshot alone and candle-only observations cannot qualify', () => {
    const state = new DepthStreamState(config),
      events = syntheticStreamSteps();
    state.consume(events[0]!);
    state.consume(events[1]!);
    expect(state.consume(events[3]!).usable).toBe(false);
    const quote = ready().consume(tick(100));
    expect(isStreamUsableAt({ ...quote, quality: 'CANDLE_ONLY' }, at(100))).toBe(false);
  });
  it.each([6000, -6000])('rejects excessive server clock offset %i ms', (offset) => {
    const state = ready();
    const view = state.consume(
      step(100, {
        kind: 'CLOCK',
        connection: 1,
        sentAt: at(90),
        providerAt: at(95 + offset),
        raw: 'synthetic clock skew',
      }),
    );
    expect(view.status).toBe('CLOCK_UNRELIABLE');
    expect(view.usable).toBe(false);
  });
  it('uses midpoint offset and RTT uncertainty without rewriting timestamps', () => {
    const state = ready();
    const clock = state.consume(
      step(100, {
        kind: 'CLOCK',
        connection: 1,
        sentAt: at(80),
        providerAt: at(590),
        raw: 'synthetic clock offset',
      }),
    );
    expect(clock.clockOffsetNs).toBe('500000000');
    expect(clock.clockUncertaintyNs).toBe('11000000');
    const view = state.consume(delta(200, '102', '102', 700));
    expect(view.usable).toBe(true);
    expect(view.occurredAt).toBe(at(700));
    expect(view.observedAt).toBe(at(200));
  });
  it('rejects long RTT, expired clock samples, delayed/future provider events', () => {
    const state = ready();
    expect(
      state.consume(
        step(1200, {
          kind: 'CLOCK',
          connection: 1,
          sentAt: at(100),
          providerAt: at(650),
          raw: 'synthetic slow clock',
        }),
      ).status,
    ).toBe('CLOCK_UNRELIABLE');
    const short = new DepthStreamState({ ...config, clockTtlMs: 1000 });
    for (const event of syntheticStreamSteps().slice(0, 4)) short.consume(event);
    expect(short.consume(tick(1010)).status).toBe('CLOCK_UNRELIABLE');
    expect(ready().consume(delta(100, '102', '102', 200)).status).toBe('CLOCK_UNRELIABLE');
    expect(ready().consume(delta(3000, '102', '102', 10)).status).toBe('STALE');
  });
  it('ignores late REST data after disconnect and previous connection data after reconnect', () => {
    const state = ready();
    state.consume(step(100, { kind: 'DISCONNECTED', connection: 1 }));
    const snapshot = structuredClone(syntheticStreamSteps()[3]!);
    snapshot.input.observedAt = at(110);
    snapshot.processedAt = at(110);
    expect(state.consume(snapshot).usable).toBe(false);
    state.consume(step(120, { kind: 'CONNECTED', connection: 2 }));
    expect(state.consume(delta(130, '102')).status).toBe('SYNCING');
  });
  it('fails closed on receipt/processing clock regression and future receipt', () => {
    expect(ready().consume(tick(15)).status).toBe('FAULT');
    expect(ready().consume(step(100, { kind: 'TICK', connection: 1 }, 90)).status).toBe('FAULT');
  });
  it('rejects duplicate price spellings, crossed/empty books, and unknown snapshot depth', () => {
    const events = syntheticStreamSteps();
    const invalid = structuredClone(events[3]!);
    if (invalid.input.kind !== 'SNAPSHOT') throw new Error('Fixture');
    invalid.input.bids.push(['100.0', '2'] as (typeof invalid.input.bids)[number]);
    const state = new DepthStreamState(config);
    events.slice(0, 3).forEach((e) => state.consume(e));
    expect(state.consume(invalid).status).toBe('INVALID_BOOK');
    for (const bids of [
      [['102', '1']],
      [
        ['100', '0'],
        ['99', '0'],
      ],
      [
        ['100', '0'],
        ['99', '0'],
        ['98', '1'],
      ],
    ]) {
      const event = delta(100, '102');
      if (event.input.kind === 'DELTA') event.input.bids = bids as typeof event.input.bids;
      expect(ready().consume(event).status).toBe('INVALID_BOOK');
    }
  });
  it('bounds pre-snapshot buffers', () => {
    const state = new DepthStreamState(config);
    state.consume(syntheticStreamSteps()[0]!);
    let view;
    for (let i = 0; i < 257; i++) view = state.consume(delta(i + 1, String(i + 1)));
    expect(view?.status).toBe('INVALID_BOOK');
    expect(state.needsSnapshot).toBe(true);
  });
});

describe('public transport and budgets', () => {
  it('preserves sequence identifiers beyond float precision and explicit millisecond time', () => {
    const raw =
      '{"e":"depthUpdate","E":1767225600020,"s":"BTCUSDT","U":9007199254740993,"u":9007199254740994,"b":[["100.000000000000000001","0.000000000000000001"]],"a":[]}';
    const event = decodeBinanceDepth(raw, 'BTCUSDT', 1, at(30));
    expect(event.kind === 'DELTA' && event.first).toBe('9007199254740993');
    expect(event.kind === 'DELTA' && event.occurredAt).toBe(at(20));
    expect(() => decodeBinanceDepth(raw, 'ETHUSDT', 1, at(30))).toThrow();
    expect(() => parseStreamJson('{"u":1e20}')).toThrow();
    expect(() => parseStreamJson('x'.repeat(262145))).toThrow();
  });
  it('uses only fixed GET public endpoints, bounded snapshot and no redirects', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{"serverTime":1767225600000}'))
      .mockResolvedValueOnce(
        new Response('{"lastUpdateId":9007199254740993,"bids":[["100","1"]],"asks":[["101","1"]]}'),
      );
    const transport = new BinancePublicStream(
      { ...config, provider: 'binance-public' },
      fetcher,
      () => at(0),
    );
    await transport.clock(1, new AbortController().signal);
    const snapshot = await transport.snapshot(1, new AbortController().signal);
    expect(snapshot.kind === 'SNAPSHOT' && snapshot.sequence).toBe('9007199254740993');
    expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
      'https://data-api.binance.vision/api/v3/time',
      'https://data-api.binance.vision/api/v3/depth?symbol=BTCUSDT&limit=100',
    ]);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: 'GET',
      redirect: 'manual',
      credentials: 'omit',
    });
  });
  it.each([403, 418, 451, 302])('halts on access restrictions or redirect %i', async (status) => {
    const transport = new BinancePublicStream(
      { ...config, provider: 'binance-public' },
      vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status })),
    );
    await expect(transport.clock(1, new AbortController().signal)).rejects.toMatchObject({
      reason: 'ACCESS_DENIED',
    });
  });
  it('honors rate limit Retry-After and rejects oversized REST bodies', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '120' } }))
      .mockResolvedValueOnce(new Response('x'.repeat(262145)));
    const transport = new BinancePublicStream({ ...config, provider: 'binance-public' }, fetcher);
    await expect(transport.clock(1, new AbortController().signal)).rejects.toMatchObject({
      reason: 'RATE_LIMIT',
      retryAfterMs: 120000,
    });
    await expect(transport.snapshot(1, new AbortController().signal)).rejects.toMatchObject({
      reason: 'MALFORMED',
    });
    expect(retryAfterMs('Thu, 01 Jan 2026 00:01:00 GMT', Number(1767225600000n))).toBe(60000);
    expect(retryAfterMs(null, 0)).toBe(60000);
    expect(() => retryAfterMs('999999999', 0)).toThrow();
  });
  it('limits request spacing, total weight, total requests and cooldown', () => {
    const budget = new StreamRequestBudget();
    expect(budget.allow(0, 5)).toBe(true);
    expect(budget.allow(249, 5)).toBe(false);
    budget.cooldown(0, 120000);
    expect(budget.allow(119999, 5)).toBe(false);
    expect(budget.allow(120000, 95)).toBe(true);
    expect(budget.allow(120250, 6)).toBe(false);
    for (let i = 1; i <= 10; i++) budget.allow(180000 + i * 250, 1);
    expect(budget.exhausted).toBe(true);
    expect(budget.allow(999999, 1)).toBe(false);
  });
  it('bounds reconnection attempts and always records stopped state', async () => {
    const open = vi
      .fn<MarketStream['open']>()
      .mockRejectedValue(new StreamTransportError('NETWORK'));
    const transport: MarketStream = { open, clock: vi.fn(), snapshot: vi.fn() };
    const collected: StreamStep[] = [];
    const running = (async () => {
      for await (const event of runMarketStream(config, transport, 6000)) collected.push(event);
    })();
    await running;
    expect(open).toHaveBeenCalledTimes(4);
    expect(
      collected
        .filter((s) => s.input.kind === 'RETRY')
        .map((s) => s.input.kind === 'RETRY' && s.input.delayMs),
    ).toEqual([250, 500, 1000]);
    expect(collected.at(-2)?.input).toMatchObject({ kind: 'FAULT', reason: 'EXHAUSTED' });
    expect(collected.at(-1)?.input.kind).toBe('STOPPED');
  });
  it('preserves receipts queued during REST recovery and stops cleanly', async () => {
    let receive: (event: StreamInput) => void = () => undefined;
    const snapshot = vi.fn<MarketStream['snapshot']>(async (connection) => {
      receive({
        ...syntheticStreamSteps()[2]!.input,
        connection,
        observedAt: streamNow(),
        ...{ occurredAt: streamNow() },
      });
      await delay(5);
      return { ...syntheticStreamSteps()[3]!.input, connection, observedAt: streamNow() };
    });
    const transport: MarketStream = {
      open: vi.fn<MarketStream['open']>((_connection, callback) => {
        receive = callback;
        return Promise.resolve(() => undefined);
      }),
      clock: vi.fn<MarketStream['clock']>((connection) =>
        Promise.resolve({
          kind: 'CLOCK',
          connection,
          sentAt: streamNow(),
          observedAt: streamNow(),
          providerAt: streamNow(),
          raw: 'synthetic runtime clock',
        }),
      ),
      snapshot,
    };
    const events: StreamStep[] = [];
    for await (const event of runMarketStream(config, transport, 400)) events.push(event);
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(events.at(-1)?.input.kind).toBe('STOPPED');
    expect(events.map((e) => e.input.observedAt)).toEqual(
      [...events.map((e) => e.input.observedAt)].sort(),
    );
    const state = new DepthStreamState(config),
      views = events.map((e) => state.consume(e));
    const recovered = views.find((v) => v.usable);
    expect(recovered).toBeDefined();
    expect(recovered!.availableAt > recovered!.observedAt!).toBe(true);
  });
  it('retries a rejected clock sample without weakening the uncertainty gate', async () => {
    let calls = 0;
    const transport: MarketStream = {
      open: () => Promise.resolve(() => undefined),
      clock: (connection) => {
        calls++;
        return Promise.resolve({
          kind: 'CLOCK',
          connection,
          sentAt: calls === 1 ? fromEpoch(BigInt(Date.now() - 2000), 'milliseconds') : streamNow(),
          observedAt: streamNow(),
          providerAt: streamNow(),
          raw: 'synthetic delayed clock sample',
        });
      },
      snapshot: (connection) =>
        Promise.resolve({
          ...syntheticStreamSteps()[3]!.input,
          connection,
          observedAt: streamNow(),
        }),
    };
    const events: StreamStep[] = [];
    for await (const event of runMarketStream(config, transport, 1600)) events.push(event);
    expect(calls).toBe(2);
    const state = new DepthStreamState(config);
    const clockViews = events
      .map((event) => ({ event, view: state.consume(event) }))
      .filter((v) => v.event.input.kind === 'CLOCK')
      .map((v) => v.view);
    expect(clockViews[0]?.clockOffsetNs).toBe(null);
    expect(clockViews[1]?.clockOffsetNs).not.toBe(null);
  });
  it('retains packets already received when a duration stop aborts REST', async () => {
    let receive: (input: StreamInput) => void = () => undefined;
    const transport: MarketStream = {
      open: (_connection, callback) => {
        receive = callback;
        return Promise.resolve(() => undefined);
      },
      clock: (connection, signal) => {
        const input = syntheticStreamSteps()[2]!.input;
        receive({ ...input, connection, observedAt: streamNow() });
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('Stopped')), { once: true });
        });
      },
      snapshot: vi.fn(),
    };
    const events: StreamStep[] = [];
    for await (const event of runMarketStream(config, transport, 100)) events.push(event);
    expect(events.map((event) => event.input.kind)).toEqual(['CONNECTED', 'DELTA', 'STOPPED']);
    expect(events[1]!.processedAt > events[1]!.input.observedAt).toBe(true);
  });
  it('records heartbeat silence, reconnects conservatively, and bounds the run', async () => {
    const transport: MarketStream = {
      open: () => Promise.resolve(() => undefined),
      clock: (connection) =>
        Promise.resolve({
          kind: 'CLOCK',
          connection,
          sentAt: streamNow(),
          observedAt: streamNow(),
          providerAt: streamNow(),
          raw: 'synthetic clock',
        }),
      snapshot: (connection) =>
        Promise.resolve({
          ...syntheticStreamSteps()[3]!.input,
          connection,
          observedAt: streamNow(),
        }),
    };
    const events: StreamStep[] = [];
    for await (const event of runMarketStream(
      { ...config, heartbeatAfterMs: 1000 },
      transport,
      1600,
    ))
      events.push(event);
    expect(
      events.some((e) => e.input.kind === 'FAULT' && e.input.reason === 'HEARTBEAT_TIMEOUT'),
    ).toBe(true);
    expect(events.filter((e) => e.input.kind === 'CONNECTED')).toHaveLength(2);
    expect(events.at(-1)?.input.kind).toBe('STOPPED');
  });
  it('honors provider cooldowns inside the runner and fails closed on queue overflow', async () => {
    const clock = vi
      .fn<MarketStream['clock']>()
      .mockRejectedValue(new StreamTransportError('RATE_LIMIT', 120000));
    const transport: MarketStream = {
      open: () => Promise.resolve(() => undefined),
      clock,
      snapshot: vi.fn(),
    };
    const events: StreamStep[] = [];
    for await (const event of runMarketStream(config, transport, 400)) events.push(event);
    expect(clock).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.input.kind === 'FAULT' && e.input.retryAfterMs === 120000)).toBe(
      true,
    );
    transport.open = (connection, receive) => {
      for (let i = 0; i < 513; i++) receive({ kind: 'TICK', connection, observedAt: streamNow() });
      return Promise.resolve(() => undefined);
    };
    const overflow: StreamStep[] = [];
    for await (const event of runMarketStream(config, transport, 400)) overflow.push(event);
    expect(overflow.at(-2)?.input).toMatchObject({ kind: 'FAULT', reason: 'OVERFLOW' });
    expect(overflow.filter((e) => e.input.kind === 'TICK')).toHaveLength(512);
    const state = new DepthStreamState(config);
    expect(overflow.map((e) => state.consume(e)).every((v) => !v.usable)).toBe(true);
  });
});

describe('immutable recording and deterministic replay', () => {
  it('round-trips receipt order, exact states, hashes and immutable reuse', async () => {
    const root = await temporary(),
      input = syntheticStreamSteps();
    const result = await writeStreamRecording(config, input, root, 'synthetic-test.v1');
    const replay = await replayStreamRecording(result.directory);
    expect(replay.records.map((r) => r.step)).toEqual(input);
    expect(replay.records.map((r) => r.view)).toEqual(result.records.map((r) => r.view));
    expect(replay.metadataHash).toBe(result.metadataHash);
    expect((await writeStreamRecording(config, input, root, 'synthetic-test.v1')).directory).toBe(
      result.directory,
    );
    expect(
      (await writeStreamRecording(config, input, await temporary(), 'synthetic-test.v1'))
        .metadataHash,
    ).toBe(result.metadataHash);
    expect(replay.records.at(-1)?.view.usable).toBe(false);
    expect(replay.manifest.configHash).toBe(canonicalHash(StreamConfigSchema.parse(config)));
  });
  it('refuses mutated evidence, metadata and incomplete captures', async () => {
    const root = await temporary();
    const result = await writeStreamRecording(
      config,
      syntheticStreamSteps(),
      root,
      'synthetic-test.v1',
    );
    const path = join(result.directory, 'observations.jsonl'),
      bytes = await readFile(path, 'utf8');
    await writeFile(path, bytes.replace('synthetic delta 101', 'synthetic delta 999'));
    await expect(replayStreamRecording(result.directory)).rejects.toThrow('hash');
    await expect(
      writeStreamRecording(config, syntheticStreamSteps(), root, 'synthetic-test.v1'),
    ).rejects.toThrow();
    await writeFile(path, bytes);
    const manifestPath = join(result.directory, 'manifest.json');
    const manifest: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
    await writeFile(manifestPath, JSON.stringify({ ...(manifest as object), count: 1 }));
    await expect(replayStreamRecording(result.directory)).rejects.toThrow('Metadata');
    await expect(
      writeStreamRecording(config, syntheticStreamSteps().slice(0, 4), root, 'synthetic-test.v1'),
    ).rejects.toThrow('Incomplete');
  });
  it('runs synthetic capture and replay CLI, and rejects secret or endpoint flags', async () => {
    const execute = promisify(execFile),
      root = await temporary();
    const result = await execute(process.execPath, [
      '--import',
      'tsx',
      'apps/cli/src/market.ts',
      'stream',
      '--out',
      root,
    ]);
    const report = JSON.parse(result.stdout) as {
      directory: string;
      provider: string;
      usableObservations: number;
    };
    expect(report.provider).toBe('synthetic');
    expect(report.usableObservations).toBeGreaterThan(0);
    const replay = await execute(process.execPath, [
      '--import',
      'tsx',
      'apps/cli/src/market.ts',
      'replay',
      '--recording',
      report.directory,
    ]);
    expect(JSON.parse(replay.stdout)).toMatchObject({ verified: true, count: 12 });
    for (const flag of ['--api-key', '--url']) {
      let stderr = '';
      try {
        await execute(process.execPath, [
          '--import',
          'tsx',
          'apps/cli/src/market.ts',
          'stream',
          flag,
          'do-not-echo-secret',
        ]);
      } catch (error) {
        if (error && typeof error === 'object' && 'stderr' in error) stderr = String(error.stderr);
      }
      expect(stderr).toContain('Market stream/replay failed');
      expect(stderr).not.toContain('do-not-echo-secret');
    }
  });
});
