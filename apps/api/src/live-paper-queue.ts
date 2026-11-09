import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import Fastify from 'fastify';
import { Queue, QueueEvents, Worker, UnrecoverableError } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';
import { z } from 'zod';
import { canonicalHash } from '@crypto/core';
import { LiveControlSchema, LiveRunSchema } from '@crypto/contracts';
import { createLivePaperService } from './live-paper.js';
import type { LivePaperService } from './live-paper.js';
import {
  executePaperQueueCommand,
  PaperQueueCommandSchema,
  prepareQueueJournal,
} from './queue-command.js';
export function paperRedisConnection(input: string, producer = false): ConnectionOptions {
  const u = new URL(input);
  if (u.protocol !== 'redis:' || !u.hostname || u.search || u.hash || !/^\/\d*$/.test(u.pathname))
    throw new Error('Invalid private Redis configuration');
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    username: decodeURIComponent(u.username) || 'default',
    password: decodeURIComponent(u.password),
    db: Number(u.pathname.slice(1) || 0),
    maxRetriesPerRequest: producer ? 1 : null,
    enableOfflineQueue: !producer,
    connectTimeout: 5000,
    commandTimeout: producer ? 5000 : undefined,
  };
}
export async function createPaperQueueWorker(options: {
  databaseUrl: string;
  redisUrl: string;
  rpcToken: string;
  schema?: string;
  queueName?: string;
  listenHost?: string;
  port?: number;
  runtimeFactory?: () => Promise<LivePaperService>;
  intervalMs?: number;
  onFatal?: () => void;
}) {
  if (options.rpcToken.length < 32) throw new Error('Private worker authentication required');
  const runtime = options.runtimeFactory
      ? await options.runtimeFactory()
      : await createLivePaperService(options.databaseUrl, options.schema),
    name = options.queueName ?? 'crypto-paper-market-v1';
  const adapterHash = canonicalHash(
    await Promise.all(
      ['./live-paper-queue.ts', './queue-command.ts'].map(async (path) => ({
        path,
        source: await readFile(new URL(path, import.meta.url), 'utf8'),
      })),
    ),
  );
  await prepareQueueJournal(runtime.store, adapterHash);
  const queue = new Queue(name, {
    connection: paperRedisConnection(options.redisUrl, true),
    defaultJobOptions: {
      priority: 10,
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: { count: 200, age: 3600 },
      removeOnFail: { count: 200, age: 604800 },
    },
  });
  const events = new QueueEvents(name, { connection: paperRedisConnection(options.redisUrl) });
  let lastTickAt = 0,
    closing = false,
    fatalState = false,
    lastFailure: string | null = null;
  queue.on('error', () => {
    lastFailure = 'Redis producer unavailable';
  });
  events.on('error', () => {
    lastFailure = 'Redis events connection unavailable';
  });
  const worker = new Worker(
    name,
    async (job) => {
      try {
        await runtime.store.assertLease();
      } catch {
        fatalState = true;
        options.onFatal?.();
        throw new UnrecoverableError('Database worker lease lost; process restart required');
      }
      if (job.name === 'tick') {
        if (Date.now() - job.timestamp > 90000) return { skipped: 'STALE_JOB' };
        await runtime.tickOnce();
        try {
          await runtime.store.assertLease();
        } catch {
          fatalState = true;
          options.onFatal?.();
          throw new UnrecoverableError('Database worker lease lost; process restart required');
        }
        const view = await runtime.overview();
        if (view.error) throw new Error('Paper tick failed; durable state preserved');
        lastTickAt = Date.now();
        lastFailure = null;
        return {
          at: lastTickAt,
          runId: view.run?.id ?? null,
          revision: view.run?.revision ?? null,
        };
      }
      if (job.name !== 'command') throw new UnrecoverableError('Unknown paper queue job');
      const command = PaperQueueCommandSchema.parse(job.data);
      return executePaperQueueCommand(runtime.store, command, () =>
        command.action === 'START' ? runtime.startRun() : runtime.control(command.action),
      );
    },
    {
      connection: paperRedisConnection(options.redisUrl),
      concurrency: 1,
      lockDuration: 30000,
      maxStalledCount: 2,
    },
  );
  worker.on('error', () => {
    lastFailure = 'Queue worker connection unavailable';
  });
  worker.on('failed', (_job, error) => {
    lastFailure =
      error instanceof UnrecoverableError
        ? 'Queued command rejected'
        : 'Queued job failed; bounded retry or retained failed job';
  });
  const app = Fastify({ logger: false, bodyLimit: 16384, requestIdHeader: false });
  app.addHook('onRequest', (req, reply, done) => {
    const token = req.headers['x-crypto-worker-auth'];
    if (
      typeof token !== 'string' ||
      token.length > 200 ||
      !timingSafeEqual(
        Buffer.from(canonicalHash(token)),
        Buffer.from(canonicalHash(options.rpcToken)),
      )
    ) {
      void reply.code(401).send({ error: 'PRIVATE_WORKER_AUTH_REQUIRED' });
      return;
    }
    reply.header('cache-control', 'no-store');
    done();
  });
  async function status() {
    try {
      const counts = await queue.getJobCounts(
        'waiting',
        'active',
        'delayed',
        'completed',
        'failed',
      );
      return {
        enabled: true,
        backend: 'BULLMQ_REDIS',
        queue: name,
        connected: true,
        lastTickAt,
        lastFailure,
        healthy: !closing && !fatalState && lastTickAt > 0 && Date.now() - lastTickAt < 30000,
        counts,
        adapterHash,
      };
    } catch {
      return {
        enabled: true,
        backend: 'BULLMQ_REDIS',
        queue: name,
        connected: false,
        lastTickAt,
        lastFailure: 'Redis unavailable',
        healthy: false,
        counts: {},
        adapterHash,
      };
    }
  }
  app.get('/health', async (_req, reply) => {
    const result = await status();
    return reply.code(result.healthy ? 200 : 503).send(result);
  });
  app.get('/queue-status', status);
  app.get('/overview', async (req) => {
    const id = z.strictObject({ runId: z.string().uuid().optional() }).parse(req.query).runId;
    const view = await runtime.overview(id),
      q = await status();
    return q.healthy
      ? view
      : {
          ...view,
          worker: 'ERROR',
          error:
            'Paper queue is unavailable or its heartbeat is delayed; no unrecorded fills are created.',
        };
  });
  app.post('/command', async (req, reply) => {
    const body = z
      .strictObject({
        id: z.string().uuid(),
        action: z.enum(['START', ...LiveControlSchema.shape.action.options]),
      })
      .parse(req.body);
    const existing = await queue.getJob(body.id);
    if (existing) {
      const old = PaperQueueCommandSchema.parse(existing.data);
      if (old.action !== body.action) return reply.code(409).send({ error: 'COMMAND_ID_CONFLICT' });
      return LiveRunSchema.parse(await existing.waitUntilFinished(events, 45000));
    }
    const current = await runtime.store.read(),
      data = { ...body, expectedRunId: current?.id ?? null, requestedAt: Date.now() };
    const job = await queue.add('command', data, { jobId: body.id, priority: 1 });
    return LiveRunSchema.parse(await job.waitUntilFinished(events, 45000));
  });
  app.post('/refresh', async () => {
    const job = await queue.add('tick', {}, { jobId: randomUUID() });
    await job.waitUntilFinished(events, 30000);
    return { ok: true };
  });
  app.setErrorHandler((_error, _req, reply) => {
    void reply.code(409).send({ error: 'QUEUED_OPERATION_UNAVAILABLE' });
  });
  await Promise.all([queue.waitUntilReady(), events.waitUntilReady(), worker.waitUntilReady()]);
  await queue.upsertJobScheduler(
    'public-quotes-5s',
    { every: options.intervalMs ?? 5000 },
    { name: 'tick', data: { version: 1 }, opts: { priority: 10 } },
  );
  await queue.add('tick', {}, { jobId: randomUUID(), priority: 10 });
  await app.listen({ host: options.listenHost ?? '0.0.0.0', port: options.port ?? 3102 });
  return {
    runtime,
    queue,
    worker,
    events,
    app,
    status,
    async close() {
      closing = true;
      await app.close();
      await worker.close();
      await events.close();
      await queue.close();
      await runtime.close();
    },
  };
}
