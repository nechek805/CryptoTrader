import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { LiveNewsStore } from '../packages/db/src/live-news-store.js';
import { NewsResearchStore } from '../packages/db/src/news-research-store.js';
import { NewsV5Run } from '../packages/contracts/src/news-research-v5.js';
import { NEWS_V5_ENGINE_HASH } from '../packages/backtest/src/news-history-v5.js';
import { newsV4Plan } from '../packages/research/src/news-long-history.js';
import {
  createNewsResearchQueue,
  createNewsResearchWorker,
  reconcileNewsResearch,
} from '../apps/api/src/news-research-jobs.js';
import { buildLiveNewsApi } from '../apps/api/src/live-news-api.js';
import type { LiveNewsQueues } from '../apps/api/src/live-news-queue.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  'V5 immutable corpus and versioned research jobs',
  () => {
    let news: LiveNewsStore,
      legacy: NewsResearchStore,
      v3: NewsResearchStore,
      v4: NewsResearchStore,
      v5: NewsResearchStore;
    beforeEach(async () => {
      news = new LiveNewsStore(
        process.env.TEST_DATABASE_URL!,
        'crypto_news_test_' + randomUUID().replaceAll('-', ''),
      );
      await news.migrate();
      legacy = new NewsResearchStore(news);
      v3 = new NewsResearchStore(news, 'v3');
      v4 = new NewsResearchStore(news, 'v4');
      v5 = new NewsResearchStore(news, 'v5');
      for (const store of [legacy, v3, v4, v5]) await store.migrate();
    });
    afterEach(async () => {
      await news.pool.query(`DROP SCHEMA ${news.schema} CASCADE`);
      await news.close();
    });
    it('freezes the seed, parent, protocol and exact parent snapshot without changing V1–V3 storage', async () => {
      const plan = newsV4Plan(Date.UTC(2026, 10, 7, 9)),
        seed = await v5.capture(),
        parent = randomUUID();
      const run = NewsV5Run.parse(await v5.request(plan, NEWS_V5_ENGINE_HASH, seed, parent));
      expect(await v5.snapshot(run.id)).toEqual(seed);
      await expect(
        news.pool.query(
          `UPDATE ${news.schema}.research_v5_runs SET snapshot='{}'::jsonb WHERE id=$1`,
          [run.id],
        ),
      ).rejects.toThrow('Immutable');
      await expect(
        news.pool.query(
          `UPDATE ${news.schema}.research_v5_runs SET data=jsonb_set(data,'{baselineRunId}',to_jsonb($2::text)) WHERE id=$1`,
          [run.id, randomUUID()],
        ),
      ).rejects.toThrow('Immutable');
      expect(await legacy.runs()).toHaveLength(0);
      expect(await v3.runs()).toHaveLength(0);
      expect(await v4.runs()).toHaveLength(0);
      await expect(v5.request(plan, NEWS_V5_ENGINE_HASH, seed, randomUUID())).rejects.toThrow(
        'V5_FROZEN_PARENT_CONFLICT',
      );
      expect((await v5.request(plan, NEWS_V5_ENGINE_HASH, seed, parent)).id).toBe(run.id);
    });
    it('protects V5 endpoints and refuses to create a study without a completed V4 reference', async () => {
      const add = vi.fn().mockResolvedValue({}),
        queue = { getJob: vi.fn().mockResolvedValue(null), add } as unknown as ReturnType<
          typeof createNewsResearchQueue
        >;
      const security = {
        proxySecret: 'synthetic-proxy-000000000000000000000000',
        readerToken: 'synthetic-reader-0000000000000000000000',
        adminToken: 'synthetic-admin-000000000000000000000000',
        origins: ['https://research.example.test'],
      };
      const app = buildLiveNewsApi(news, { collect: {}, analyze: {} } as LiveNewsQueues, security, {
        store: legacy,
        v3Store: v3,
        v4Store: v4,
        v5Store: v5,
        queue,
      });
      try {
        expect((await app.inject('/news/research/v5/status')).statusCode).toBe(401);
        expect(
          (
            await app.inject({
              url: '/news/research/v5/run',
              method: 'POST',
              payload: {},
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
              url: '/news/research/v5/run',
              method: 'POST',
              payload: {},
              headers: { ...admin, origin: 'https://evil.test' },
            })
          ).statusCode,
        ).toBe(403);
        expect(
          (
            await app.inject({
              url: '/news/research/v5/run',
              method: 'POST',
              payload: {},
              headers: admin,
            })
          ).statusCode,
        ).toBe(409);
        expect(add).not.toHaveBeenCalled();
        expect(await v5.runs()).toHaveLength(0);
      } finally {
        await app.close();
      }
    });
    it.skipIf(!process.env.TEST_REDIS_URL)(
      'consumes a real V5 job through the V5 store and reuses completed evidence',
      async () => {
        const queueName = 'fixture-news-v5-' + randomUUID(),
          queue = createNewsResearchQueue(process.env.TEST_REDIS_URL!, queueName);
        const run = NewsV5Run.parse(
          await v5.request(
            newsV4Plan(Date.UTC(2026, 10, 7, 9)),
            NEWS_V5_ENGINE_HASH,
            await v5.capture(),
            randomUUID(),
          ),
        );
        const done = NewsV5Run.parse({
            ...run,
            state: 'COMPLETE',
            reportHash: 'sha256:' + 'c'.repeat(64),
          }),
          lookup = vi.fn().mockResolvedValue(done),
          cached = { run: lookup } as unknown as NewsResearchStore;
        const wrong = vi.spyOn(v3, 'run'),
          worker = createNewsResearchWorker(
            legacy,
            process.env.TEST_REDIS_URL!,
            '/tmp/synthetic-unused',
            queueName,
            v3,
            v4,
            cached,
          );
        try {
          await worker.waitUntilReady();
          await reconcileNewsResearch(v5, queue);
          const job = (await queue.getJob(run.id))!;
          expect(job.data).toEqual({ runId: run.id, kind: 'v5' });
          const deadline = Date.now() + 8000;
          while ((await job.getState()) !== 'completed' && Date.now() < deadline)
            await new Promise((r) => setTimeout(r, 50));
          expect(await job.getState()).toBe('completed');
          expect((await queue.getJob(run.id))!.returnvalue).toEqual({
            reportHash: done.reportHash,
          });
          expect(wrong).not.toHaveBeenCalled();
          expect(lookup).toHaveBeenCalledWith(run.id);
        } finally {
          await worker.close();
          await queue.obliterate({ force: true });
          await queue.close();
        }
      },
    );
  },
);
