import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { LivePaperStore } from '@crypto/db';
import { TelegramStore } from '../packages/db/src/telegram-store.js';
import { TelegramClient } from '../apps/api/src/telegram-client.js';
import { telegramDelivery } from '../apps/api/src/telegram-jobs.js';
import { telegramFixture } from './helpers/telegram.js';
import { liveTestMarket, LIVE_TEST_TIME as T } from './helpers/live-paper.js';
import { stepLiveRun } from '@crypto/paper';

describe('Telegram durable notifications (synthetic positions, no Telegram network)', () => {
  let ledger: LivePaperStore, store: TelegramStore;
  const url = () => {
    if (!process.env.TEST_DATABASE_URL) throw Error('Isolated TEST_DATABASE_URL required');
    return process.env.TEST_DATABASE_URL;
  };
  beforeEach(async () => {
    const id = randomUUID().replaceAll('-', '');
    ledger = new LivePaperStore(url(), 'crypto_live_test_' + id);
    await ledger.migrate();
    store = new TelegramStore(
      url(),
      'synthetic-channel',
      'https://example.com/live-paper',
      'crypto_telegram_test_' + id,
      ledger.schema,
    );
    await store.migrate();
    await store.initialize();
  });
  afterEach(async () => {
    await store.pool.query(`DROP SCHEMA ${store.schema} CASCADE`);
    await store.close();
    await ledger.pool.query(`DROP SCHEMA ${ledger.schema} CASCADE`);
    await ledger.close();
  });
  async function start() {
    const fixture = telegramFixture();
    await ledger.change(() => ({
      state: fixture.run,
      positions: [],
      sources: [],
      event: { kind: 'SYNTHETIC_START' },
    }));
    return fixture;
  }
  async function rows() {
    return (
      await store.pool.query<{ id: string; event_key: string; status: string; text: string }>(
        `SELECT * FROM ${store.schema}.outbox ORDER BY sequence`,
      )
    ).rows;
  }
  it('captures rapid opens and closes, orders delivery, and survives restart without replay', async () => {
    const f = await start();
    await ledger.change(() => f.opened);
    await ledger.change(() => f.closed);
    expect(await store.collect()).toBe(2);
    const events = await rows();
    expect(events.map((r) => r.event_key)).toEqual([
      'OPEN:' + f.position.id,
      'CLOSE:' + f.position.id,
    ]);
    expect((await store.pending()).map((r) => r.id)).toEqual([events[0]!.id]);
    await store.sent(events[0]!.id, 1);
    expect((await store.pending()).map((r) => r.id)).toEqual([events[1]!.id]);
    const schema = store.schema;
    await store.close();
    store = new TelegramStore(
      url(),
      'synthetic-channel',
      'https://example.com/live-paper',
      schema,
      ledger.schema,
    );
    await store.initialize();
    expect(await store.collect()).toBe(0);
    expect(await rows()).toHaveLength(2);
  });
  it('skips pre-installation history but not future closes of an existing position', async () => {
    const f = await start();
    await ledger.change(() => f.opened);
    const fresh = new TelegramStore(
      url(),
      'new-install',
      'https://example.com',
      store.schema,
      ledger.schema,
    );
    try {
      await fresh.initialize();
      expect(await fresh.collect()).toBe(0);
      await ledger.change(() => f.closed);
      expect(await fresh.collect()).toBe(1);
      expect(await fresh.pending()).toHaveLength(1);
    } finally {
      await fresh.close();
    }
  });
  it('ignores partial closes until the position is fully closed', async () => {
    const f = await start();
    await ledger.change(() => f.opened);
    const partial = stepLiveRun(
      f.opened.state,
      [liveTestMarket(T + 3000, 'BINANCE', 'SOL', 94, '0.001')],
      T + 3000,
    );
    expect(partial.positions[0]!.lifecycle).not.toBe('CLOSED');
    await ledger.change(() => partial);
    expect(await store.collect()).toBe(1);
    await ledger.change((current) =>
      stepLiveRun(current!, [liveTestMarket(T + 4000, 'BINANCE', 'SOL', 94)], T + 4000),
    );
    expect(await store.collect()).toBe(1);
    expect((await rows()).map((r) => r.event_key.split(':')[0])).toEqual(['OPEN', 'CLOSE']);
  });
  it('atomically rolls back cursor progress when a committed event has no position', async () => {
    const f = await start();
    await ledger.change(() => ({ ...f.opened, positions: [] }));
    await expect(store.collect()).rejects.toThrow('TELEGRAM_POSITION_MISSING');
    expect(await rows()).toHaveLength(0);
    expect((await store.pool.query(`SELECT * FROM ${store.schema}.cursors`)).rowCount).toBe(0);
    await ledger.change(() => f.closed);
    expect(await store.collect()).toBe(2);
  });
  it('silently ignores outsiders, persists update offset, and deduplicates owner commands', async () => {
    await start();
    const update = (id: number, sender: number, chat = sender) => ({
      update_id: id,
      message: {
        from: { id: sender, is_bot: false },
        chat: { id: chat, type: 'private' },
        text: '/status',
      },
    });
    await store.command(update(10, 8), '7');
    await store.command(update(11, 7, 8), '7');
    expect(await rows()).toHaveLength(0);
    await store.command(update(12, 7), '7');
    await store.command(update(12, 7), '7');
    expect(await rows()).toHaveLength(1);
    expect(await store.offset()).toBe(13);
    expect((await rows())[0]!.text).toContain('SIMULATED');
    await store.failed((await rows())[0]!.id, 'TELEGRAM_403', true);
    await store.command(
      { ...update(13, 7), message: { ...update(13, 7).message, text: '/start' } },
      '7',
    );
    expect((await rows())[0]!.status).toBe('PENDING');
  });
  it('fences a second notifier and delivers queued alerts through real Redis exactly once in normal operation', async () => {
    await store.acquire();
    const other = new TelegramStore(
      url(),
      store.channel,
      store.dashboardUrl,
      store.schema,
      ledger.schema,
    );
    try {
      await expect(other.acquire()).rejects.toThrow('TELEGRAM_ALREADY_RUNNING');
    } finally {
      await other.close();
    }
    const f = await start();
    await ledger.change(() => f.opened);
    await ledger.change(() => f.closed);
    await store.collect();
    await store.setReady(true);
    const client = new TelegramClient('123456:abcdefghijklmnopqrstuvwx', '7');
    const send = vi.spyOn(client, 'send').mockResolvedValueOnce(101).mockResolvedValueOnce(102);
    const jobs = telegramDelivery(
      store,
      client,
      process.env.TEST_REDIS_URL!,
      'telegram-test-' + randomUUID(),
    );
    try {
      await jobs.worker.waitUntilReady();
      for (let i = 0; i < 80 && (await rows()).some((r) => r.status !== 'SENT'); i++) {
        await jobs.reconcile();
        await delay(100);
      }
      expect((await rows()).map((r) => r.status)).toEqual(['SENT', 'SENT']);
      expect(send).toHaveBeenCalledTimes(2);
      await store.collect();
      await jobs.reconcile();
      expect(send).toHaveBeenCalledTimes(2);
      expect(send.mock.calls[0]![0]).toContain('OPENED');
      expect(send.mock.calls[1]![0]).toContain('CLOSED');
    } finally {
      await jobs.worker.close();
      await jobs.queue.obliterate({ force: true });
      await jobs.queue.close();
      send.mockRestore();
    }
  });
});
