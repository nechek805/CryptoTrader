import { Queue, Worker, UnrecoverableError } from 'bullmq';
import { paperRedisConnection } from './live-paper-queue.js';
import { backupPaperDatabase } from './queue-backup.js';
const url = process.env.REDIS_URL ?? '',
  name = 'crypto-paper-maintenance-v1';
const queue = new Queue(name, {
  connection: paperRedisConnection(url, true),
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 60000 },
    removeOnComplete: { count: 30, age: 2592000 },
    removeOnFail: { count: 30, age: 2592000 },
  },
});
const worker = new Worker(
  name,
  async (job) => {
    if (job.name !== 'database-backup') throw new UnrecoverableError('Unknown maintenance job');
    const paper = await backupPaperDatabase(
      process.env.LIVE_PAPER_DATABASE_URL ?? '',
      process.env.BACKUP_DIRECTORY ?? '/backups',
      job.id ?? 'unknown',
    );
    const news = process.env.NEWS_DATABASE_URL
      ? await backupPaperDatabase(
          process.env.NEWS_DATABASE_URL,
          (process.env.BACKUP_DIRECTORY ?? '/backups') + '/news',
          job.id ?? 'unknown',
        )
      : null;
    return { paper, news };
  },
  { connection: paperRedisConnection(url), concurrency: 1, lockDuration: 60000 },
);
queue.on('error', () => {
  process.stderr.write('Maintenance producer unavailable.\n');
});
worker.on('error', () => {
  process.stderr.write('Maintenance worker connection unavailable.\n');
});
worker.on('failed', () => {
  process.stderr.write('Database backup job failed; retry or retained failed job.\n');
});
await Promise.all([queue.waitUntilReady(), worker.waitUntilReady()]);
await queue.upsertJobScheduler(
  'daily-paper-database-backup',
  { pattern: '0 35 2 * * *', tz: 'UTC' },
  { name: 'database-backup', data: { version: 1 } },
);
let closing = false;
const stop = () => {
  if (closing) return;
  closing = true;
  void worker
    .close()
    .then(() => queue.close())
    .catch(() => {
      process.exitCode = 1;
    });
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
process.stdout.write('BullMQ daily database backup worker ready.\n');
