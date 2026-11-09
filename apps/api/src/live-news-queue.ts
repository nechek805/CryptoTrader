import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { paperRedisConnection } from './live-paper-queue.js';
import type { LiveNewsStore } from '../../../packages/db/src/live-news-store.js';
import { z } from 'zod';

export const NEWS_COLLECT_QUEUE = 'crypto-news-collect-v1',
  NEWS_ANALYZE_QUEUE = 'crypto-news-analyze-v1';
export function createNewsQueues(
  redisUrl: string,
  names = { collect: NEWS_COLLECT_QUEUE, analyze: NEWS_ANALYZE_QUEUE },
) {
  const connection = paperRedisConnection(redisUrl, true);
  const options = {
    connection,
    defaultJobOptions: {
      priority: 10,
      attempts: 3,
      backoff: { type: 'exponential', delay: 60000 },
      removeOnComplete: { count: 500, age: 172800 },
      removeOnFail: { count: 200, age: 604800 },
    },
  };
  const collect = new Queue(names.collect, options),
    analyze = new Queue(names.analyze, options);
  collect.on('error', () => {
    /* No Redis URL/credentials in logs. */
  });
  analyze.on('error', () => {});
  return {
    collect,
    analyze,
    async close() {
      await Promise.all([collect.close(), analyze.close()]);
    },
  };
}
export type LiveNewsQueues = ReturnType<typeof createNewsQueues>;
export async function reconcileNewsSchedules(store: LiveNewsStore, queues: LiveNewsQueues) {
  const sources = await store.sources(),
    existing = await queues.collect.getJobSchedulers(0, 200),
    wanted = new Set<string>();
  for (const { config: s } of sources) {
    if (!s.enabled || !s.collectionApproved || s.adapter === 'SETUP_REQUIRED') continue;
    const key = 'source-' + s.id;
    wanted.add(key);
    const prior = existing.find((v) => v.key === key);
    if (
      z.object({ revision: z.number() }).safeParse(prior?.template?.data).data?.revision ===
        s.revision &&
      Number(prior?.every) === s.pollIntervalSeconds * 1000
    )
      continue;
    await queues.collect.upsertJobScheduler(
      key,
      { every: s.pollIntervalSeconds * 1000 },
      { name: 'collect', data: { sourceId: s.id, revision: s.revision }, opts: { priority: 10 } },
    );
  }
  for (const previous of existing)
    if (previous.key.startsWith('source-') && !wanted.has(previous.key))
      await queues.collect.removeJobScheduler(previous.key);
  const analyzer = await store.runtime('analyzer');
  const enabled = z.object({ enabled: z.literal(true) }).safeParse(analyzer?.data).success;
  for (const versionId of enabled ? await store.pendingAi() : [])
    await queues.analyze.add(
      'analyze',
      { versionId },
      { jobId: 'auto-' + new Date().toISOString().slice(0, 10) + '-' + versionId },
    );
  return { enabled: sources.filter((s) => s.config.enabled).length };
}
export async function requestNewsReconcile(queues: LiveNewsQueues) {
  await queues.collect.add('reconcile', {}, { jobId: randomUUID(), priority: 1 });
}
