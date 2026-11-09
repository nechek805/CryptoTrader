import { NewsResearchRun } from '../packages/contracts/src/news-research.js';
import {
  createNewsResearchQueue,
  createNewsResearchWorker,
} from '../apps/api/src/news-research-jobs.js';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
type Queue = ReturnType<typeof createNewsResearchQueue>;
import { LiveNewsStore } from '../packages/db/src/live-news-store.js';
import { NewsResearchStore } from '../packages/db/src/news-research-store.js';
import { newsResearchPlan } from '../packages/research/src/news-history-study.js';
import { NEWS_RESEARCH_ENGINE_HASH } from '../packages/backtest/src/news-history-replay.js';
import { initialLiveNewsSources } from '../packages/news/src/live-source-catalog.js';
import { buildLiveNewsApi } from '../apps/api/src/live-news-api.js';
import type { LiveNewsQueues } from '../apps/api/src/live-news-queue.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('news historical research persistence', () => {
  let news: LiveNewsStore, store: NewsResearchStore;
  beforeEach(async () => {
    news = new LiveNewsStore(
      process.env.TEST_DATABASE_URL!,
      'crypto_news_test_' + randomUUID().replaceAll('-', ''),
    );
    await news.migrate();
    store = new NewsResearchStore(news);
    await store.migrate();
    await news.seed(initialLiveNewsSources().filter((s) => s.id === 'ethereum-updates'));
  });
  afterEach(async () => {
    await news.pool.query(`DROP SCHEMA ${news.schema} CASCADE`);
    await news.close();
  });
  it.skipIf(!process.env.TEST_REDIS_URL)(
    'consumes a real queued job with a worker connection and reuses a completed frozen result',
    async () => {
      const name = 'fixture-news-research-' + randomUUID(),
        queue = createNewsResearchQueue(process.env.TEST_REDIS_URL!, name);
      const run = await store.request(
        newsResearchPlan(),
        NEWS_RESEARCH_ENGINE_HASH,
        await store.capture(),
      );
      const completed = NewsResearchRun.parse({
        ...run,
        state: 'COMPLETE',
        reportHash: 'sha256:' + 'a'.repeat(64),
      });
      const cached = { run: vi.fn().mockResolvedValue(completed) } as unknown as NewsResearchStore;
      const worker = createNewsResearchWorker(
        cached,
        process.env.TEST_REDIS_URL!,
        '/tmp/synthetic-unused',
        name,
      );
      try {
        await worker.waitUntilReady();
        const job = await queue.add('research', { runId: run.id }, { jobId: run.id });
        const deadline = Date.now() + 8000;
        while ((await job.getState()) !== 'completed' && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 50));
        expect(await job.getState()).toBe('completed');
        expect((await queue.getJob(run.id))!.returnvalue).toEqual({
          reportHash: completed.reportHash,
        });
      } finally {
        await worker.close();
        await queue.obliterate({ force: true });
        await queue.close();
      }
    },
  );
  it('serializes concurrent starts and freezes one snapshot/protocol per window and engine', async () => {
    const snapshot = await store.capture(),
      plan = newsResearchPlan(undefined, true);
    const runs = await Promise.all(
      Array.from({ length: 4 }, () => store.request(plan, NEWS_RESEARCH_ENGINE_HASH, snapshot)),
    );
    expect(new Set(runs.map((r) => r.id)).size).toBe(1);
    expect((await store.snapshot(runs[0]!.id)).capturedAt).toBe(snapshot.capturedAt);
    const next = { ...snapshot, capturedAt: snapshot.capturedAt + 1000 };
    expect((await store.request(plan, NEWS_RESEARCH_ENGINE_HASH, next)).id).toBe(runs[0]!.id);
    expect(await store.snapshot(runs[0]!.id)).toEqual(snapshot);
    expect(runs[0]!.plan.holdoutPreviouslyViewed).toBe(true);
    await expect(
      news.pool.query(`UPDATE ${news.schema}.research_runs SET snapshot='{}' WHERE id=$1`, [
        runs[0]!.id,
      ]),
    ).rejects.toThrow('Immutable research request');
  });
  it('retains immutable progress history, bounded failures and the original frozen request', async () => {
    const run = await store.request(
      newsResearchPlan(),
      NEWS_RESEARCH_ENGINE_HASH,
      await store.capture(),
    );
    await store.update(run.id, 'RUNNING', 'Synthetic fixture progress');
    await store.update(run.id, 'FAILED', 'Synthetic bounded failure', 'SYNTHETIC_NETWORK_ERROR');
    expect(await store.run(run.id)).toMatchObject({
      state: 'FAILED',
      error: 'SYNTHETIC_NETWORK_ERROR',
    });
    const events = await news.pool.query(
      `SELECT * FROM ${news.schema}.research_events WHERE run_id=$1`,
      [run.id],
    );
    expect(events.rowCount).toBe(3);
    await expect(
      news.pool.query(`DELETE FROM ${news.schema}.research_events WHERE run_id=$1`, [run.id]),
    ).rejects.toThrow('Immutable');
    expect((await store.snapshot(run.id)).total).toBe(0);
    await news.pool.query(`INSERT INTO ${news.schema}.research_reports VALUES($1,$2,$3)`, [
      run.id,
      'synthetic-hash',
      { synthetic: true },
    ]);
    await expect(
      news.pool.query(`UPDATE ${news.schema}.research_reports SET hash='changed' WHERE run_id=$1`, [
        run.id,
      ]),
    ).rejects.toThrow('Immutable');
    await expect(store.report(run.id)).rejects.toThrow();
  });
  it('enforces a durable daily run budget while replays reuse an existing request', async () => {
    const snapshot = await store.capture(),
      p = newsResearchPlan();
    for (let i = 0; i < 3; i++) {
      const run = await store.request(
        { ...p, to: p.to - i * 3600000 },
        NEWS_RESEARCH_ENGINE_HASH,
        snapshot,
      );
      await store.update(run.id, 'FAILED', 'Synthetic fixture finished');
    }
    await expect(
      store.request({ ...p, to: p.to - 4 * 3600000 }, NEWS_RESEARCH_ENGINE_HASH, snapshot),
    ).rejects.toThrow('RESEARCH_DAILY_LIMIT');
    expect(await store.runs()).toHaveLength(3);
    expect((await store.request(p, NEWS_RESEARCH_ENGINE_HASH, snapshot)).plan.to).toBe(p.to);
  });
  it('protects new research endpoints with the existing operator role and Origin checks', async () => {
    const base = { collect: {}, analyze: {} } as LiveNewsQueues;
    const add = vi.fn().mockResolvedValue({});
    const queue = {
      getJob: vi.fn().mockResolvedValue(null),
      add,
    } as unknown as Queue;
    const security = {
      proxySecret: 'synthetic-proxy-000000000000000000000000',
      readerToken: 'synthetic-reader-0000000000000000000000',
      adminToken: 'synthetic-admin-000000000000000000000000',
      origins: ['https://research.example.test'],
    };
    const app = buildLiveNewsApi(news, base, security, { store, queue });
    try {
      expect((await app.inject('/news/research/status')).statusCode).toBe(401);
      expect(
        (
          await app.inject({
            url: '/news/research/run',
            method: 'POST',
            headers: {
              authorization: 'Bearer ' + security.readerToken,
              origin: security.origins[0]!,
            },
            payload: {},
          })
        ).statusCode,
      ).toBe(403);
      const admin = { 'x-crypto-proxy-auth': security.proxySecret, origin: security.origins[0]! };
      expect(
        (
          await app.inject({
            url: '/news/research/run',
            method: 'POST',
            headers: { ...admin, origin: 'https://evil.test' },
            payload: {},
          })
        ).statusCode,
      ).toBe(403);
      const started = await app.inject({
        url: '/news/research/run',
        method: 'POST',
        headers: admin,
        payload: {},
      });
      expect(started.statusCode).toBe(200);
      const data = NewsResearchRun.parse(started.json<unknown>());
      expect(data.state).toBe('QUEUED');
      expect(add).toHaveBeenCalledWith('research', { runId: data.id }, { jobId: data.id });
      const read = await app.inject({ url: '/news/research/status', headers: admin });
      expect(read.statusCode).toBe(200);
      expect(read.body).not.toContain(security.proxySecret);
    } finally {
      await app.close();
    }
  });
});
