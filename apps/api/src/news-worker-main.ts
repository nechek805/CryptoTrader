import { Worker, DelayedError, UnrecoverableError } from 'bullmq';
import { writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { LiveNewsStore } from '../../../packages/db/src/live-news-store.js';
import { initialLiveNewsSources } from '../../../packages/news/src/live-source-catalog.js';
import {
  collectLiveNews,
  LiveNewsCollectionError,
} from '../../../packages/news/src/live-news-collector.js';
import {
  analyzeLiveNews,
  newsAiConfiguration,
  newsAiText,
} from '../../../packages/news/src/live-news-ai.js';
import { liveNewsHash } from '../../../packages/connectors/src/live-news-feed.js';
import { LiveNewsFetchError } from '../../../packages/connectors/src/live-news-fetch.js';
import { paperRedisConnection } from './live-paper-queue.js';
import {
  createNewsQueues,
  reconcileNewsSchedules,
  NEWS_COLLECT_QUEUE,
  NEWS_ANALYZE_QUEUE,
} from './live-news-queue.js';

async function main() {
  const role = z.enum(['collector', 'analyzer']).parse(process.env.NEWS_WORKER_ROLE),
    redisUrl = process.env.REDIS_URL ?? '',
    store = new LiveNewsStore(
      process.env.NEWS_DATABASE_URL ?? process.env.LIVE_PAPER_DATABASE_URL ?? '',
    ),
    queues = createNewsQueues(redisUrl),
    ai = newsAiConfiguration();
  await store.migrate();
  await store.seed(initialLiveNewsSources());
  let nextAiAllowedAt = 0,
    aiError: string | null = null;
  if (role === 'analyzer') {
    const previous = z
      .object({
        profileHash: z.string(),
        nextAllowedAt: z.number(),
        lastError: z.string().nullable(),
      })
      .safeParse((await store.runtime('analyzer'))?.data);
    if (previous.success && previous.data.profileHash === ai.profile.profileHash) {
      nextAiAllowedAt = previous.data.nextAllowedAt;
      aiError = previous.data.lastError;
    }
  }
  async function heartbeat() {
    const data =
      role === 'analyzer'
        ? {
            ...ai.profile,
            requestsToday: await store.aiBudget(),
            lastError: aiError,
            nextAllowedAt: nextAiAllowedAt,
          }
        : { queue: NEWS_COLLECT_QUEUE };
    await store.heartbeat(role, data);
    await writeFile('/tmp/news-' + role + '-heartbeat', String(Date.now()), { mode: 0o600 });
  }
  const worker = new Worker(
    role === 'collector' ? NEWS_COLLECT_QUEUE : NEWS_ANALYZE_QUEUE,
    async (job, token) => {
      if (role === 'collector') {
        if (job.name === 'reconcile') {
          await heartbeat();
          return reconcileNewsSchedules(store, queues);
        }
        if (job.name !== 'collect') throw new UnrecoverableError('Unknown news job');
        const data = z
          .object({ sourceId: z.string(), revision: z.number().int().positive() })
          .parse(job.data);
        try {
          return await collectLiveNews(store, data.sourceId, data.revision);
        } catch (e) {
          if (e instanceof LiveNewsCollectionError && !e.retryable)
            throw new UnrecoverableError(e.message);
          throw new Error('News collection failed; see source status', { cause: e });
        } finally {
          await heartbeat();
        }
      }
      if (job.name === 'heartbeat') {
        await heartbeat();
        return { ok: true };
      }
      if (job.name !== 'analyze') throw new UnrecoverableError('Unknown analysis job');
      if (!ai.profile.enabled) return { skipped: 'AI_NOT_CONFIGURED' };
      if (nextAiAllowedAt > Date.now()) {
        await job.moveToDelayed(nextAiAllowedAt, token);
        throw new DelayedError();
      }
      const { versionId } = z
          .object({ versionId: z.string().regex(/^[a-f0-9]{64}$/) })
          .parse(job.data),
        version = await store.version(versionId);
      if (!version) return { skipped: 'VERSION_MISSING' };
      const inputHash = liveNewsHash(newsAiText(version)),
        reservation = await store.reserveAi(
          versionId,
          ai.profile.profileHash,
          ai.profile.dailyLimit,
          inputHash,
        );
      if ('skip' in reservation) {
        if (reservation.until) {
          await job.moveToDelayed(reservation.until, token);
          throw new DelayedError();
        }
        return reservation;
      }
      const base = {
        id: reservation.requestId,
        provider: ai.profile.provider,
        model: ai.model,
        promptVersion: ai.profile.promptVersion,
        profileHash: ai.profile.profileHash,
        inputHash,
        evidenceStatus:
          version.independenceGroup.startsWith('us-') ||
          ['MACRO', 'OFFICIAL'].includes((await store.source(version.sourceId))?.category ?? '')
            ? 'OFFICIALLY_STATED'
            : 'UNVERIFIED',
      };
      try {
        const result = await analyzeLiveNews(reservation.version, ai),
          at = Date.now();
        await store.completeAi(versionId, ai.profile.profileHash, {
          ...base,
          status: 'ANALYZED',
          result: result.result,
          error: null,
          model: result.actualModel,
          responseHash: result.responseHash,
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens,
          processedAt: at,
          availableAt: at,
        });
        aiError = null;
        return { analyzed: versionId };
      } catch (error) {
        const known = error instanceof LiveNewsFetchError,
          code = known ? error.message : 'AI_RESPONSE_REQUIRES_REVIEW',
          at = Date.now();
        aiError = code;
        if (known)
          nextAiAllowedAt =
            at +
            Math.max(
              error.status === 401 || error.status === 403 ? 900000 : 60000,
              error.retryAfterMs,
            );
        await store.completeAi(versionId, ai.profile.profileHash, {
          ...base,
          status: known ? 'FAILED' : 'REVIEW_REQUIRED',
          result: null,
          error: code,
          responseHash: null,
          promptTokens: null,
          completionTokens: null,
          processedAt: at,
          availableAt: at,
        });
        if (known && error.retryable)
          throw new Error('AI provider temporarily unavailable', { cause: error });
        return { reviewRequired: true };
      } finally {
        await heartbeat();
      }
    },
    {
      connection: paperRedisConnection(redisUrl),
      concurrency: 1,
      lockDuration: 60000,
      maxStalledCount: 2,
      ...(role === 'analyzer' ? { limiter: { max: 20, duration: 60000 } } : {}),
    },
  );
  worker.on('error', () =>
    process.stderr.write(
      JSON.stringify({ service: 'news-' + role, error: 'QUEUE_CONNECTION_UNAVAILABLE' }) + '\n',
    ),
  );
  worker.on('failed', (job) =>
    process.stderr.write(
      JSON.stringify({
        service: 'news-' + role,
        jobId: job?.id,
        error: 'JOB_FAILED_SEE_DASHBOARD',
      }) + '\n',
    ),
  );
  await worker.waitUntilReady();
  await heartbeat();
  if (role === 'collector') {
    await queues.collect.upsertJobScheduler(
      'news-source-registry',
      { every: 30000 },
      { name: 'reconcile', data: { version: 1 }, opts: { priority: 1 } },
    );
    await reconcileNewsSchedules(store, queues);
  } else
    await queues.analyze.upsertJobScheduler(
      'news-analyzer-heartbeat',
      { every: 30000 },
      { name: 'heartbeat', data: { version: 1 }, opts: { priority: 1 } },
    );
  let closing = false;
  const stop = () => {
    if (closing) return;
    closing = true;
    void worker
      .close()
      .then(() => queues.close())
      .then(() => store.close())
      .catch(() => {
        process.exitCode = 1;
      });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.stdout.write(
    JSON.stringify({
      service: 'news-' + role,
      status: 'READY',
      execution: 'COLLECTION_AND_ANALYSIS_ONLY',
    }) + '\n',
  );
}
void main().catch(() => {
  process.stderr.write('News worker startup failed; check private configuration.\n');
  process.exit(1);
});
