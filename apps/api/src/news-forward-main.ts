import { Queue, QueueEvents, Worker } from 'bullmq';
import { writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { paperRedisConnection } from './live-paper-queue.js';
import { NewsForwardService } from './news-forward-service.js';
import { buildNewsForwardApi } from './news-forward-api.js';
async function main() {
  if (process.env.NEWS_FORWARD_ENABLED !== '1') throw Error('NEWS_FORWARD_DISABLED');
  const service = new NewsForwardService(
    process.env.NEWS_FORWARD_DATABASE_URL ?? '',
    process.env.NEWS_FORWARD_REPORT_ID ?? '',
    process.env.NEWS_FORWARD_REPORT_HASH ?? '',
  );
  await service.initialize();
  // Finish the recovery tick before the queue can deliver work to this lease.
  await service.tick();
  const redis = process.env.REDIS_URL ?? '',
    name = 'crypto-news-forward-v1';
  const queue = new Queue(name, {
    connection: paperRedisConnection(redis, true),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: { age: 86400, count: 100 },
      removeOnFail: { age: 604800, count: 100 },
    },
  });
  const events = new QueueEvents(name, { connection: paperRedisConnection(redis) });
  const worker = new Worker(
    name,
    async (job) => {
      if (job.name === 'tick') {
        await service.tick();
        return { at: service.lastTick };
      }
      if (job.name !== 'command') throw Error('INVALID_FORWARD_JOB');
      const c = z
        .strictObject({
          action: z.enum(['START', 'PAUSE', 'RESUME', 'STOP']),
          id: z.string().uuid(),
        })
        .parse(job.data);
      const run = await service.control(c.action, c.id);
      return { runId: run?.id ?? null, status: run?.status ?? null };
    },
    { connection: paperRedisConnection(redis), concurrency: 1, lockDuration: 120000 },
  );
  worker.on('error', () => {
    service.error = 'NEWS_FORWARD_QUEUE_ERROR';
  });
  worker.on('failed', (job) => {
    process.stderr.write(
      JSON.stringify({ service: 'news-forward', job: job?.name, error: 'JOB_FAILED_SEE_STATUS' }) +
        '\n',
    );
  });
  queue.on('error', () => {
    service.error = 'NEWS_FORWARD_QUEUE_ERROR';
  });
  events.on('error', () => {});
  await Promise.all([worker.waitUntilReady(), events.waitUntilReady(), queue.waitUntilReady()]);
  await queue.upsertJobScheduler(
    'news-forward-tick-v1',
    { every: 15000 },
    { name: 'tick', data: {} },
  );
  const app = buildNewsForwardApi(
    service,
    async (action, id) => {
      const job = await queue.add('command', { action, id }, { jobId: id, priority: 1 });
      return job.waitUntilFinished(events, 35000);
    },
    {
      proxySecret: process.env.OPS_PROXY_SECRET ?? '',
      readerToken: process.env.OPS_READ_TOKEN ?? '',
      adminToken: process.env.OPS_ADMIN_TOKEN ?? '',
      origins: (process.env.OPS_ALLOWED_ORIGINS ?? '').split(',').filter(Boolean),
    },
  );
  const heartbeat = setInterval(() => {
    if (Date.now() - service.lastTick < 90000 && !service.error)
      void writeFile('/tmp/news-forward-heartbeat', String(Date.now()), { mode: 0o600 });
  }, 5000);
  await app.listen({ host: '0.0.0.0', port: 3104 });
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    clearInterval(heartbeat);
    await app.close();
    await worker.close();
    await events.close();
    await queue.close();
    await service.close();
  };
  process.once('SIGTERM', () => {
    void close();
  });
  process.once('SIGINT', () => {
    void close();
  });
  process.stdout.write(
    'News forward paper service ready; frozen V6 rules, real public data, simulated execution only.\n',
  );
}
void main().catch(() => {
  process.stderr.write(
    'News forward startup failed; inspect private configuration and frozen report.\n',
  );
  process.exit(1);
});
