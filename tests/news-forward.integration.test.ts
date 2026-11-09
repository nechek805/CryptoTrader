import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, it, expect } from 'vitest';
import { canonicalHash } from '@crypto/core';
import { NewsForwardStore } from '../packages/db/src/news-forward-store.js';
import { TelegramStore } from '../packages/db/src/telegram-store.js';
import { ForwardQuery } from '../packages/contracts/src/news-forward.js';
import { stageForwardNews, stepNewsForward } from '../packages/paper/src/news-forward-engine.js';
import { forwardFixture, forwardMarket, T } from './helpers/news-forward.js';
import { NewsForwardService } from '../apps/api/src/news-forward-service.js';
let store: NewsForwardStore;
beforeEach(async () => {
  if (!process.env.TEST_DATABASE_URL) throw Error('Isolated TEST_DATABASE_URL required');
  store = new NewsForwardStore(
    process.env.TEST_DATABASE_URL,
    'crypto_news_forward_test_' + randomUUID().replaceAll('-', ''),
  );
  await store.migrate();
});
afterEach(async () => {
  await store.pool.query(`DROP SCHEMA ${store.schema} CASCADE`);
  await store.close();
});
async function start() {
  const f = forwardFixture();
  await store.change(() => ({
    state: f.run,
    positions: [],
    sources: [],
    event: { kind: 'SYNTHETIC_START' },
  }));
  return f;
}
async function open() {
  const f = await start();
  const staged = stageForwardNews(f.run, [f], T + 2000);
  await store.change(() => ({
    state: staged.run,
    positions: [],
    sources: [],
    event: { kind: 'NEWS_DECISION', decisions: staged.decisions },
  }));
  await store.change((current) =>
    stepNewsForward(current!, [forwardMarket(T + 3601000)], T + 3601000),
  );
  return f;
}
it('serializes starts and fences duplicate workers without touching the market-paper schema', async () => {
  const results = await Promise.allSettled([start(), start()]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(await store.acquireWorker()).toBe(true);
  const other = new NewsForwardStore(process.env.TEST_DATABASE_URL!, store.schema);
  try {
    expect(await other.acquireWorker()).toBe(false);
  } finally {
    await other.close();
  }
});
it('persists command receipts so a retried START or control cannot create another account or reset its deadline', async () => {
  const f = forwardFixture(),
    service = new NewsForwardService(
      process.env.TEST_DATABASE_URL!,
      f.run.manifest.reportRunId,
      f.run.manifest.reportHash,
      store.schema,
    );
  service.manifest = f.run.manifest;
  try {
    expect(await service.store.acquireWorker()).toBe(true);
    const startId = randomUUID(),
      run = (await service.control('START', startId))!;
    const replay = (await service.control('START', startId))!;
    expect(replay.id).toBe(run.id);
    expect(replay.revision).toBe(run.revision);
    await expect(service.control('START', randomUUID())).rejects.toThrow('ALREADY_ACTIVE');
    const pauseId = randomUUID(),
      paused = (await service.control('PAUSE', pauseId))!;
    expect((await service.control('PAUSE', pauseId))!.revision).toBe(paused.revision);
    const resumed = (await service.control('RESUME', randomUUID()))!;
    expect(resumed.deadlineAt).toBe(run.deadlineAt);
    await service.control('STOP', randomUUID());
    await expect(service.control('RESUME', randomUUID())).rejects.toThrow('CANNOT_RESUME');
  } finally {
    await service.close();
  }
});
it('persists news decisions, entries and original deadline; restarting does not duplicate fills', async () => {
  const f = await open(),
    saved = await store.read();
  expect(saved!.processed).toEqual([f.version.id]);
  expect(saved!.positions).toHaveLength(1);
  const schema = store.schema;
  await store.close();
  store = new NewsForwardStore(process.env.TEST_DATABASE_URL!, schema);
  expect(await store.read()).toEqual(saved);
  await store.change((current) =>
    stepNewsForward(current!, [forwardMarket(T + 3602000)], T + 3602000),
  );
  const restored = await store.read();
  expect(restored!.positions[0]!.fills).toHaveLength(1);
  expect(restored!.deadlineAt).toBe(f.run.deadlineAt);
  expect(
    (await store.positions(ForwardQuery.parse({ asset: 'ETH', lifecycle: 'OPEN' }))).total,
  ).toBe(1);
});
it('makes immutable event/source evidence and rolls back invalid position transitions', async () => {
  await open();
  const before = canonicalHash(await store.read());
  await expect(store.pool.query(`DELETE FROM ${store.schema}.events`)).rejects.toThrow('Immutable');
  await expect(store.pool.query(`DELETE FROM ${store.schema}.sources`)).rejects.toThrow(
    'Immutable',
  );
  await expect(
    store.change((current) => ({
      state: current!,
      positions: [{ ...current!.positions[0]!, runId: randomUUID() }],
      sources: [],
      event: { kind: 'SYNTHETIC_INVALID' },
    })),
  ).rejects.toThrow('run mismatch');
  expect(canonicalHash(await store.read())).toBe(before);
});
it('retains closed trades, supports exact numeric filtered exports and verifies the persisted event hash chain', async () => {
  await open();
  await store.change((current) =>
    stepNewsForward(current!, [forwardMarket(T + 3603000, 'ETH', 106)], T + 3603000),
  );
  const run = (await store.read())!,
    page = await store.positions(
      ForwardQuery.parse({
        runId: run.id,
        asset: 'ETH',
        status: 'WIN',
        sort: 'netPnl',
        direction: 'desc',
      }),
      true,
    );
  expect(page.total).toBe(1);
  expect(page.positions[0]!.lifecycle).toBe('CLOSED');
  let previous = '';
  for (const row of await store.eventPage(run.id, -1, run.revision)) {
    expect(row.previous_hash).toBe(previous);
    expect(row.hash).toBe(
      canonicalHash({ runId: run.id, revision: row.revision, previous, payload: row.data }),
    );
    previous = row.hash;
  }
  expect(previous).toBe(run.lastEventHash);
});
it('notifies new multi-asset news opens/closes using a separate durable outbox without Telegram network calls', async () => {
  const alerts = new TelegramStore(
    process.env.TEST_DATABASE_URL!,
    'SYNTHETIC_NEWS',
    'https://example.com/news-paper',
    'crypto_telegram_test_' + randomUUID().replaceAll('-', ''),
    store.schema,
  );
  try {
    await alerts.migrate();
    await alerts.initialize();
    await open();
    await store.change((current) =>
      stepNewsForward(current!, [forwardMarket(T + 3603000, 'ETH', 94)], T + 3603000),
    );
    expect(await alerts.collect()).toBe(2);
    expect(await alerts.collect()).toBe(0);
    const rows = (
      await alerts.pool.query<{ text: string; id: string }>(
        `SELECT id,text FROM ${alerts.schema}.outbox ORDER BY sequence`,
      )
    ).rows;
    expect(rows[0]!.text).toContain('ETH/USDT');
    expect(rows[0]!.text).toContain('NEWS_V6');
    expect(rows[1]!.text).toContain('CLOSED');
    expect(await alerts.pending()).toHaveLength(1);
    await alerts.sent(rows[0]!.id, 101);
    expect((await alerts.pending())[0]!.id).toBe(rows[1]!.id);
  } finally {
    await alerts.pool.query(`DROP SCHEMA ${alerts.schema} CASCADE`);
    await alerts.close();
  }
});
