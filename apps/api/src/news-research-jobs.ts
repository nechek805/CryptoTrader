import { NEWS_V3_ENGINE_HASH } from '../../../packages/backtest/src/news-history-v3.js';
import { executeNewsV3 } from './news-research-v3-job.js';
import { NEWS_V4_ENGINE_HASH } from '../../../packages/backtest/src/news-history-v4.js';
import { executeNewsV4 } from './news-research-v4-job.js';
import { NEWS_V5_ENGINE_HASH } from '../../../packages/backtest/src/news-history-v5.js';
import { executeNewsV5 } from './news-research-v5-job.js';
import { NEWS_V6_ENGINE_HASH } from '../../../packages/backtest/src/news-history-v6.js';
import { executeNewsV6 } from './news-research-v6-job.js';
import { Queue, Worker, UnrecoverableError } from 'bullmq';
import { writeFile, mkdir, readFile, rename, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { canonicalHash } from '@crypto/core';
import { MARKET_ASSETS } from '../../../packages/contracts/src/market-tests.js';
import {
  downloadMarketMetadata,
  downloadMarketHistory,
  loadMarketHistory,
  saveMarketHistory,
} from '../../../packages/research/src/market-test-history.js';
import {
  buildNewsHistoryReport,
  NEWS_RESEARCH_ENGINE_HASH,
} from '../../../packages/backtest/src/news-history-replay.js';
import type { NewsResearchStore } from '../../../packages/db/src/news-research-store.js';
import { paperRedisConnection } from './live-paper-queue.js';

export const NEWS_RESEARCH_QUEUE = 'crypto-news-research-v1';
export function createNewsResearchQueue(url: string, name = NEWS_RESEARCH_QUEUE) {
  const queue = new Queue(name, {
    connection: paperRedisConnection(url, true),
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: 'exponential', delay: 60000 },
      removeOnComplete: { age: 604800, count: 50 },
      removeOnFail: { age: 604800, count: 50 },
    },
  });
  queue.on('error', () => {});
  return queue;
}
export async function reconcileNewsResearch(store: NewsResearchStore, queue: Queue) {
  for (const run of await store.runs()) {
    if (!['QUEUED', 'RUNNING'].includes(run.state)) continue;
    const job = await queue.getJob(run.id);
    if (!job)
      await queue.add(
        'research',
        { runId: run.id, ...(store.kind !== 'legacy' ? { kind: store.kind } : {}) },
        { jobId: run.id },
      );
    else if ((await job.getState()) === 'failed')
      await store.update(
        run.id,
        'FAILED',
        'Research stopped after bounded retries',
        'RESEARCH_JOB_FAILED',
      );
  }
}
export function createNewsResearchWorker(
  baseStore: NewsResearchStore,
  redisUrl: string,
  root: string,
  name = NEWS_RESEARCH_QUEUE,
  v3Store?: NewsResearchStore,
  v4Store?: NewsResearchStore,
  v5Store?: NewsResearchStore,
  v6Store?: NewsResearchStore,
) {
  const worker = new Worker(
    name,
    async (job) => {
      const { runId, kind } = z
        .object({
          runId: z.string().uuid(),
          kind: z.enum(['legacy', 'v3', 'v4', 'v5', 'v6']).default('legacy'),
        })
        .parse(job.data);
      const store =
        kind === 'v6'
          ? v6Store
          : kind === 'v5'
            ? v5Store
            : kind === 'v4'
              ? v4Store
              : kind === 'v3'
                ? v3Store
                : baseStore;
      if (!store) throw new UnrecoverableError('RESEARCH_WORKER_KIND_UNAVAILABLE');
      const run = await store.run(runId);
      if (!run) throw new UnrecoverableError('RESEARCH_RUN_NOT_FOUND');
      if (run.state === 'COMPLETE') return { reportHash: run.reportHash };
      if (
        run.engineHash !==
        (kind === 'v6'
          ? NEWS_V6_ENGINE_HASH
          : kind === 'v5'
            ? NEWS_V5_ENGINE_HASH
            : kind === 'v4'
              ? NEWS_V4_ENGINE_HASH
              : kind === 'v3'
                ? NEWS_V3_ENGINE_HASH
                : NEWS_RESEARCH_ENGINE_HASH)
      )
        throw new UnrecoverableError('RESEARCH_CODE_VERSION_CHANGED');
      const progress = async (stage: string) => {
        await store.update(runId, 'RUNNING', stage);
        await heartbeat(store);
      };
      try {
        if (kind === 'v6') return await executeNewsV6(store, runId, root, progress);
        if (kind === 'v5') return await executeNewsV5(store, runId, root, progress);
        if (kind === 'v4') return await executeNewsV4(store, runId, root, progress);
        if (kind === 'v3') return await executeNewsV3(store, runId, root, progress);
        await progress(
          'Verifying the frozen news corpus and preparing ten real hourly market datasets',
        );
        await mkdir(join(root, 'market'), { recursive: true });
        const snapshot = await store.snapshot(runId),
          markets = [];
        // Metadata is frozen with the request window, and reused across retries and all tokens.
        const metadataPath = join(root, 'metadata-' + run.plan.to + '.json');
        let metadata;
        try {
          metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as unknown;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
          metadata = await downloadMarketMetadata();
          const temporary = metadataPath + '.' + randomUUID() + '.tmp';
          await writeFile(temporary, JSON.stringify(metadata), { flag: 'wx' });
          await rename(temporary, metadataPath);
        }
        for (const asset of MARKET_ASSETS) {
          const pointer = join(root, `${asset}-${run.plan.to}.json`);
          await progress(`${asset}: checking/downloading six months of public hourly candles`);
          try {
            let stored;
            try {
              const stat = await lstat(pointer);
              if (!stat.isFile() || stat.size > 1000) throw new Error('Market pointer rejected');
              const { id } = z
                .object({ id: z.string().regex(/^sha256:[a-f0-9]{64}$/) })
                .parse(JSON.parse(await readFile(pointer, 'utf8')) as unknown);
              stored = await loadMarketHistory(join(root, 'market'), id);
            } catch (e) {
              if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
              const history = await downloadMarketHistory(
                asset,
                run.plan.from,
                run.plan.to,
                metadata,
              );
              stored = await saveMarketHistory(join(root, 'market'), history);
              const temp = pointer + '.' + runId + '.tmp';
              await writeFile(temp, JSON.stringify({ id: stored.id }));
              await rename(temp, pointer);
            }
            markets.push({ asset, history: stored.dataset, hash: stored.id, error: null });
          } catch {
            markets.push({
              asset,
              history: null,
              hash: null,
              error:
                'Public hourly market snapshot failed verification or could not be downloaded; no synthetic replacement.',
            });
          }
        }
        const report = await buildNewsHistoryReport(snapshot, run.plan, markets, progress);
        if (report.rows.filter((r) => r.status === 'COMPLETE').length !== 10)
          throw new Error('Incomplete market universe; retry preserves fixed inputs');
        const reportHash = await store.complete(runId, report);
        return { reportHash, snapshotHash: canonicalHash(snapshot) };
      } catch (e) {
        await store.update(
          runId,
          'RUNNING',
          'Attempt failed; bounded queue retry pending',
          'RESEARCH_INPUT_OR_COMPUTATION_FAILED',
        );
        throw e;
      }
    },
    {
      connection: paperRedisConnection(redisUrl),
      concurrency: 1,
      lockDuration: 300000,
      maxStalledCount: 1,
    },
  );
  worker.on('error', () => {});
  return worker;
}
export async function heartbeat(store: NewsResearchStore) {
  await store.news.heartbeat('research', {
    engineHash: NEWS_RESEARCH_ENGINE_HASH,
    v3EngineHash: NEWS_V3_ENGINE_HASH,
    v4EngineHash: NEWS_V4_ENGINE_HASH,
    v5EngineHash: NEWS_V5_ENGINE_HASH,
    v6EngineHash: NEWS_V6_ENGINE_HASH,
  });
  await writeFile('/tmp/news-research-heartbeat', String(Date.now()), { mode: 0o600 });
}
