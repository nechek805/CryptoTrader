import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { canonicalHash } from '@crypto/core';
import { LivePaperStore } from '@crypto/db';
import { LiveQuerySchema, LiveRunSchema } from '@crypto/contracts';
import { stepLiveRun, verifyLiveRecording } from '@crypto/paper';
import { liveTestRun, liveTestMarket, LIVE_TEST_TIME as T } from './helpers/live-paper.js';
describe('live-paper PostgreSQL persistence', () => {
  let store: LivePaperStore,
    other: LivePaperStore | null = null;
  beforeEach(async () => {
    const url = process.env.TEST_DATABASE_URL;
    if (!url) throw new Error('Integration tests require an isolated TEST_DATABASE_URL');
    store = new LivePaperStore(url, 'crypto_live_test_' + randomUUID().replaceAll('-', ''));
    await store.migrate();
  });
  afterEach(async () => {
    if (other) {
      await other.close();
      other = null;
    }
    await store.pool.query(`DROP SCHEMA ${store.schema} CASCADE`);
    await store.close();
  });
  async function start() {
    const { run } = liveTestRun();
    return (await store.change(() => ({
      state: run,
      positions: [],
      sources: [],
      event: { kind: 'START', state: run },
    })))!;
  }
  function market(at: number, price = 100) {
    const m = liveTestMarket(at, 'BINANCE', 'SOL', price);
    const sources = [m.book!.source, m.instrument!.source, m.bars!.source];
    const raw = [
      { lastUpdateId: at, bids: m.book!.bids, asks: m.book!.asks },
      {
        symbols: [
          {
            symbol: 'SOLUSDT',
            baseAsset: 'SOL',
            quoteAsset: 'USDT',
            status: 'TRADING',
            filters: [
              { filterType: 'PRICE_FILTER', tickSize: '0.01' },
              { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001' },
              { filterType: 'MIN_NOTIONAL', minNotional: '1' },
            ],
          },
        ],
      },
      m.bars!.bars.map((b) => [b.at, b.open, b.high, b.low, b.close, b.volume]),
    ];
    sources.forEach((s, i) => {
      s.raw = JSON.stringify(raw[i]);
      s.rawHash = canonicalHash(s.raw);
    });
    m.book!.source.providerAt = null;
    return m;
  }
  it('serializes concurrent starts and enforces one active run', async () => {
    const results = await Promise.allSettled([start(), start()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await store.listRuns()).toHaveLength(1);
  });
  it('fences a second worker and releases the lease for recovery', async () => {
    expect(await store.acquireWorker()).toBe(true);
    other = new LivePaperStore(process.env.TEST_DATABASE_URL!, store.schema);
    expect(await other.acquireWorker()).toBe(false);
    await store.close();
    store = other;
    other = null;
    expect(await store.acquireWorker()).toBe(true);
  });
  it('atomically saves evidence, positions and balances; resumes without duplicate fills', async () => {
    let run = await start();
    run.pending['BINANCE:SOL'] = {
      side: 'LONG',
      createdAt: T,
      expiresAt: T + 90000,
      atr: '1',
      stopAtr: '2.5',
      targetAtr: '5',
      volume: '10000',
      decision: { origin: 'SYNTHETIC' },
    };
    // Proposal is persisted in its own audited synthetic test transition.
    run = (await store.change(() => ({
      state: run,
      positions: [],
      sources: [],
      event: { kind: 'TEST_PROPOSAL' },
    })))!;
    const m = market(T + 1000);
    const opened = (await store.change((current) => stepLiveRun(current!, [m], T + 1000)))!;
    const restored = await store.read(opened.id);
    expect(restored).toEqual(opened);
    const next = (await store.change((current) => stepLiveRun(current!, [m], T + 1001)))!;
    expect(next.positions).toHaveLength(1);
    expect(next.positions[0]!.fills).toHaveLength(1);
    expect(
      (
        await store.positions(
          LiveQuerySchema.parse({ runId: run.id, exchange: 'BINANCE', status: 'WORKING' }),
        )
      ).total,
    ).toBe(1);
    expect(await store.evidence(run.id, m.book!.source.id)).not.toBeNull();
    const before = canonicalHash(await store.read());
    await expect(
      store.change((current) => ({
        state: current!,
        positions: [{ ...current!.positions[0]!, runId: randomUUID() }],
        sources: [],
        event: { kind: 'INVALID' },
      })),
    ).rejects.toThrow('run mismatch');
    expect(canonicalHash(await store.read())).toBe(before);
  });
  it('rejects edits to source and event evidence and verifies persisted hashes', async () => {
    await start();
    const m = market(T + 1000);
    await store.change((current) => stepLiveRun(current!, [m], T + 1000));
    await expect(store.pool.query(`DELETE FROM ${store.schema}.events`)).rejects.toThrow(
      'Immutable',
    );
    await expect(store.pool.query(`UPDATE ${store.schema}.sources SET data='{}'`)).rejects.toThrow(
      'Immutable',
    );
    await store.pool.query(
      `UPDATE ${store.schema}.runs SET state=state||'{"status":"PAUSED"}'::jsonb`,
    );
    await expect(store.read()).rejects.toThrow('integrity');
  });
  it('re-executes recorded public inputs and validates ledger hashes through pause/resume', async () => {
    await start();
    await store.change((current) => stepLiveRun(current!, [market(T + 1000)], T + 1000));
    await store.change((current) => {
      const state = LiveRunSchema.parse({
        ...current,
        status: 'PAUSED',
        heartbeatAt: T + 2000,
        pending: {},
      });
      return { state, positions: [], sources: [], event: { kind: 'CONTROL', action: 'PAUSE' } };
    });
    await store.change((current) => stepLiveRun(current!, [market(T + 3000)], T + 3000));
    const verified = await verifyLiveRecording(store);
    expect(verified.verified).toBe(true);
    expect(verified.revisions).toBe(4);
    expect(verified.accounts.every((a) => a.cash === '10000')).toBe(true);
  });
  it('sorts numerically and applies exact filters and export pagination', async () => {
    const run = await start();
    run.pending['BINANCE:SOL'] = {
      side: 'LONG',
      createdAt: T,
      expiresAt: T + 90000,
      atr: '1',
      stopAtr: '2.5',
      targetAtr: '5',
      volume: '10000',
      decision: { origin: 'SYNTHETIC' },
    };
    const opened = stepLiveRun(run, [market(T + 1000)], T + 1000),
      p = opened.positions[0]!;
    const positions = [
      p,
      {
        ...p,
        id: randomUUID(),
        status: 'LOSS' as const,
        lifecycle: 'CLOSED' as const,
        closedAt: T + 2000,
        remaining: '0',
        netPnl: '-10',
      },
      {
        ...p,
        id: randomUUID(),
        status: 'WIN' as const,
        lifecycle: 'CLOSED' as const,
        closedAt: T + 3000,
        remaining: '0',
        netPnl: '2',
      },
    ];
    await store.change(() => ({ ...opened, positions }));
    const q = LiveQuerySchema.parse({
      runId: run.id,
      sort: 'netPnl',
      direction: 'asc',
      pageSize: 1,
    });
    const first = await store.positions(q);
    expect(first.total).toBe(3);
    expect(first.positions[0]!.netPnl).toBe('-10');
    const all = await store.positions(q, true);
    expect(all.positions).toHaveLength(3);
    expect(all.positions.at(-1)!.netPnl).toBe('2');
    expect(
      (
        await store.positions(
          LiveQuerySchema.parse({
            status: 'WIN',
            from: T + 2500,
            dateField: 'closedAt',
            runId: run.id,
          }),
        )
      ).total,
    ).toBe(1);
    expect(
      (await store.positions(LiveQuerySchema.parse({ minPnl: '0', maxPnl: '5', runId: run.id })))
        .total,
    ).toBe(1);
  });
  it('replays an hourly proposal, entry and closing fill against the saved account exactly', async () => {
    await start();
    const now = T + 3600000 + 5000,
      signal = market(now, 300);
    signal.bars!.bars = signal.bars!.bars.map((b, i) => {
      const close = i === 298 ? 300 : i < 240 ? 100 + i * 0.1 : 124 - (i - 240) * 0.3;
      return {
        ...b,
        at: T - (298 - i) * 3600000,
        open: String(close) as typeof b.open,
        high: String(close + 1) as typeof b.high,
        low: String(close - 1) as typeof b.low,
        close: String(close) as typeof b.close,
      };
    });
    signal.bars!.source.raw = JSON.stringify(
      signal.bars!.bars.map((b) => [b.at, b.open, b.high, b.low, b.close, b.volume]),
    );
    signal.bars!.source.rawHash = canonicalHash(signal.bars!.source.raw);
    const proposal = await store.change((current) => stepLiveRun(current!, [signal], now));
    expect(proposal!.pending['BINANCE:SOL']?.side).toBe('LONG');
    const entry = { ...signal, book: market(now + 1000, 300).book };
    const opened = await store.change((current) => stepLiveRun(current!, [entry], now + 1000));
    expect(opened!.positions).toHaveLength(1);
    await store.change((current) => {
      const state = LiveRunSchema.parse({
        ...current,
        status: 'STOPPING',
        heartbeatAt: now + 2000,
        pending: {},
      });
      return { state, positions: [], sources: [], event: { kind: 'CONTROL', action: 'STOP' } };
    });
    const closed = await store.change((current) =>
      stepLiveRun(current!, [{ ...signal, book: market(now + 3000, 305).book }], now + 3000),
    );
    expect(closed!.status).toBe('ENDED');
    const verified = await verifyLiveRecording(store);
    expect(verified.closed).toBe(1);
    expect(verified.open).toBe(0);
    expect(verified.accounts).toEqual(closed!.accounts);
  });
});
