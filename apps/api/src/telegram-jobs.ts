import { Queue, Worker } from 'bullmq';
import { z } from 'zod';
import type { TelegramStore } from '../../../packages/db/src/telegram-store.js';
import { TelegramFailure } from './telegram-client.js';
import type { TelegramClient } from './telegram-client.js';
import { paperRedisConnection } from './live-paper-queue.js';
export const TELEGRAM_QUEUE = 'crypto-telegram-notifications-v1';
export function telegramDelivery(
  store: TelegramStore,
  client: TelegramClient,
  redisUrl: string,
  name = TELEGRAM_QUEUE,
) {
  const queue = new Queue(name, {
    connection: paperRedisConnection(redisUrl, true),
    defaultJobOptions: {
      attempts: 8,
      backoff: { type: 'telegram', delay: 2000 },
      removeOnComplete: { age: 86400, count: 500 },
      removeOnFail: { age: 604800, count: 500 },
    },
  });
  const worker = new Worker(
    name,
    async (job) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(job.data);
      if (!(await store.ready())) throw new TelegramFailure('TELEGRAM_WAITING_FOR_START', 60000);
      const row = await store.beginSend(id);
      if (!row) return { skipped: true };
      try {
        const messageId = await client.send(row.text);
        await store.sent(id, messageId);
        return { messageId };
      } catch (e) {
        const safe =
          e instanceof TelegramFailure
            ? e
            : new TelegramFailure('TELEGRAM_DELIVERY_OR_DATABASE_ERROR');
        await store.failed(id, safe.code);
        throw safe;
      }
    },
    {
      connection: paperRedisConnection(redisUrl),
      concurrency: 1,
      lockDuration: 60000,
      limiter: { max: 1, duration: 1100 },
      settings: {
        backoffStrategy: (attempts, _type, error) =>
          error instanceof TelegramFailure && error.retryAfterMs !== undefined
            ? error.retryAfterMs
            : Math.min(60000, 2000 * 2 ** Math.min(attempts, 5)),
      },
    },
  );
  queue.on('error', () => {});
  worker.on('error', () => {});
  const reconcile = async () => {
    if (!(await store.ready())) return;
    for (const row of await store.pending()) {
      const job = await queue.getJob(row.id);
      if (!job) await queue.add('deliver', { id: row.id }, { jobId: row.id });
      else if ((await job.getState()) === 'failed') {
        // /start resets blocked deliveries; otherwise retain the exhausted failure.
        const records = await store.pool.query<{ attempts: number }>(
          `SELECT attempts FROM ${store.schema}.outbox WHERE id=$1 AND channel=$2`,
          [row.id, store.channel],
        );
        if (records.rows[0]?.attempts === 0) {
          await job.remove();
          await queue.add('deliver', { id: row.id }, { jobId: row.id });
        } else await store.failed(row.id, 'TELEGRAM_RETRIES_EXHAUSTED', true);
      }
    }
  };
  return {
    queue,
    worker,
    reconcile,
    close: async () => {
      await worker.close();
      await queue.close();
    },
  };
}
