import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { LiveNewsStore } from '../packages/db/src/live-news-store.js';
import { NewsResearchStore } from '../packages/db/src/news-research-store.js';
import { NewsV3Run } from '../packages/contracts/src/news-research-v3.js';
import { newsResearchPlan } from '../packages/research/src/news-history-study.js';
import { NEWS_V3_ENGINE_HASH } from '../packages/backtest/src/news-history-v3.js';
import { NEWS_RESEARCH_ENGINE_HASH } from '../packages/backtest/src/news-history-replay.js';
import {
  createNewsResearchQueue,
  createNewsResearchWorker,
  reconcileNewsResearch,
} from '../apps/api/src/news-research-jobs.js';
import { buildLiveNewsApi } from '../apps/api/src/live-news-api.js';
import type { LiveNewsQueues } from '../apps/api/src/live-news-queue.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('separate immutable V3 news research', () => {
  let news: LiveNewsStore, legacy: NewsResearchStore, v3: NewsResearchStore;
  beforeEach(async () => {
    news = new LiveNewsStore(
      process.env.TEST_DATABASE_URL!,
      'crypto_news_test_' + randomUUID().replaceAll('-', ''),
    );
    await news.migrate();
    legacy = new NewsResearchStore(news);
    v3 = new NewsResearchStore(news, 'v3');
    await legacy.migrate();
    await v3.migrate();
  });
  afterEach(async () => {
    await news.pool.query(`DROP SCHEMA ${news.schema} CASCADE`);
    await news.close();
  });
  it('isolates V3 runs and freezes their parent, corpus and protocol', async () => {
    const plan = newsResearchPlan(),
      snapshot = await legacy.capture();
    const parent = await legacy.request(plan, NEWS_RESEARCH_ENGINE_HASH, snapshot);
    const run = NewsV3Run.parse(await v3.request(plan, NEWS_V3_ENGINE_HASH, snapshot, parent.id));
    expect((await legacy.runs()).map((r) => r.id)).toEqual([parent.id]);
    expect((await v3.runs()).map((r) => r.id)).toEqual([run.id]);
    expect(await legacy.run(run.id)).toBeNull();
    expect(await v3.snapshot(run.id)).toEqual(snapshot);
    expect((await v3.request(plan, NEWS_V3_ENGINE_HASH, snapshot, parent.id)).id).toBe(run.id);
    await expect(
      news.pool.query(
        `UPDATE ${news.schema}.research_v3_runs SET data=jsonb_set(data,'{baselineRunId}',to_jsonb($2::text)) WHERE id=$1`,
        [run.id, randomUUID()],
      ),
    ).rejects.toThrow('Immutable research request');
    await v3.update(run.id, 'RUNNING', 'Synthetic V3 progress');
    expect(await legacy.run(parent.id)).toEqual(parent);
    expect(
      (
        await news.pool.query(`SELECT * FROM ${news.schema}.research_v3_events WHERE run_id=$1`, [
          run.id,
        ])
      ).rowCount,
    ).toBe(2);
    await expect(
      news.pool.query(`DELETE FROM ${news.schema}.research_v3_events WHERE run_id=$1`, [run.id]),
    ).rejects.toThrow('Immutable');
  });
  it('requires operator and Origin authorization plus a completed baseline', async () => {
    const add = vi.fn().mockResolvedValue({});
    const queue = {
      getJob: vi.fn().mockResolvedValue(null),
      add,
    } as unknown as ReturnType<typeof createNewsResearchQueue>;
    const security = {
      proxySecret: 'synthetic-proxy-000000000000000000000000',
      readerToken: 'synthetic-reader-0000000000000000000000',
      adminToken: 'synthetic-admin-000000000000000000000000',
      origins: ['https://research.example.test'],
    };
    const app = buildLiveNewsApi(news, { collect: {}, analyze: {} } as LiveNewsQueues, security, {
      store: legacy,
      v3Store: v3,
      queue,
    });
    try {
      expect((await app.inject('/news/research/v3/status')).statusCode).toBe(401);
      const payload = {};
      expect(
        (
          await app.inject({
            url: '/news/research/v3/run',
            method: 'POST',
            payload,
            headers: {
              authorization: 'Bearer ' + security.readerToken,
              origin: security.origins[0]!,
            },
          })
        ).statusCode,
      ).toBe(403);
      const admin = { 'x-crypto-proxy-auth': security.proxySecret, origin: security.origins[0]! };
      expect(
        (
          await app.inject({
            url: '/news/research/v3/run',
            method: 'POST',
            payload,
            headers: { ...admin, origin: 'https://evil.test' },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            url: '/news/research/v3/run',
            method: 'POST',
            payload,
            headers: admin,
          })
        ).statusCode,
      ).toBe(409);
      const pending = await legacy.request(
        newsResearchPlan(),
        NEWS_RESEARCH_ENGINE_HASH,
        await legacy.capture(),
      );
      expect(
        (
          await app.inject({
            url: '/news/research/v3/run',
            method: 'POST',
            payload: { baselineRunId: pending.id },
            headers: admin,
          })
        ).statusCode,
      ).toBe(409);
      expect(await v3.runs()).toHaveLength(0);
      expect(add).not.toHaveBeenCalled();
      expect(
        (await app.inject({ url: '/news/research/v3/status', headers: admin })).statusCode,
      ).toBe(200);
    } finally {
      await app.close();
    }
  });
  it.skipIf(!process.env.TEST_REDIS_URL)(
    'routes real BullMQ V3 jobs to the V3 store without using legacy inputs',
    async () => {
      const name = 'fixture-news-v3-' + randomUUID(),
        queue = createNewsResearchQueue(process.env.TEST_REDIS_URL!, name);
      const parent = await legacy.request(
        newsResearchPlan(),
        NEWS_RESEARCH_ENGINE_HASH,
        await legacy.capture(),
      );
      const run = NewsV3Run.parse(
        await v3.request(
          parent.plan,
          NEWS_V3_ENGINE_HASH,
          await legacy.snapshot(parent.id),
          parent.id,
        ),
      );
      const completed = NewsV3Run.parse({
        ...run,
        state: 'COMPLETE',
        reportHash: 'sha256:' + 'b'.repeat(64),
      });
      const cached = { run: vi.fn().mockResolvedValue(completed) } as unknown as NewsResearchStore;
      const legacyRead = vi.spyOn(legacy, 'run');
      const worker = createNewsResearchWorker(
        legacy,
        process.env.TEST_REDIS_URL!,
        '/tmp/synthetic-unused',
        name,
        cached,
      );
      try {
        await worker.waitUntilReady();
        await reconcileNewsResearch(v3, queue);
        const job = (await queue.getJob(run.id))!;
        expect(job.data).toEqual({ runId: run.id, kind: 'v3' });
        const deadline = Date.now() + 8000;
        while ((await job.getState()) !== 'completed' && Date.now() < deadline)
          await new Promise((r) => setTimeout(r, 50));
        expect(await job.getState()).toBe('completed');
        expect((await queue.getJob(run.id))!.returnvalue).toEqual({
          reportHash: completed.reportHash,
        });
        expect(legacyRead).not.toHaveBeenCalled();
      } finally {
        await worker.close();
        await queue.obliterate({ force: true });
        await queue.close();
      }
    },
  );
});
