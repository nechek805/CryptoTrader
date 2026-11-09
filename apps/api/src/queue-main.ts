import { createPaperQueueWorker } from './live-paper-queue.js';
function fatal() {
  process.stderr.write('Paper queue worker lost its database lease; restarting safely.\n');
  setImmediate(() => process.exit(1));
}
async function main() {
  const service = await createPaperQueueWorker({
    databaseUrl: process.env.LIVE_PAPER_DATABASE_URL ?? '',
    redisUrl: process.env.REDIS_URL ?? '',
    rpcToken: process.env.WORKER_RPC_TOKEN ?? '',
    onFatal: fatal,
  });
  let closing = false;
  const stop = () => {
    if (closing) return;
    closing = true;
    void service.close().catch(() => {
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.stdout.write('BullMQ paper worker ready; public feeds and simulated positions only.\n');
}
void main().catch(() => {
  process.stderr.write(
    'Paper queue worker startup failed: check private Redis/database configuration.\n',
  );
  process.exit(1);
});
