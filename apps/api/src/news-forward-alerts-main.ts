import { setTimeout as delay } from 'node:timers/promises';
import { writeFile } from 'node:fs/promises';
import { telegramSettings } from '../../../packages/contracts/src/telegram.js';
import { TelegramStore } from '../../../packages/db/src/telegram-store.js';
import { TelegramClient } from './telegram-client.js';
import { telegramDelivery } from './telegram-jobs.js';
async function main() {
  const c = telegramSettings(process.env),
    client = new TelegramClient(c.token, c.userId),
    identity = await client.identity();
  if (!c.enabled) throw Error('NEWS_ALERTS_DISABLED');
  const store = new TelegramStore(
    c.databaseUrl,
    `${identity.id}:${c.userId}:news`,
    c.dashboardUrl,
    'crypto_telegram_v1',
    'crypto_news_forward_v1',
  );
  await store.migrate();
  const lease = await store.acquire();
  await store.initialize();
  const jobs = telegramDelivery(store, client, c.redisUrl, 'crypto-telegram-news-notifications-v1');
  await Promise.all([jobs.queue.waitUntilReady(), jobs.worker.waitUntilReady()]);
  let closing = false,
    checked = 0;
  const abort = new AbortController(),
    stop = () => {
      closing = true;
      abort.abort();
    };
  lease.on('error', stop);
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    while (!closing) {
      try {
        await lease.query('SELECT 1');
        if (Date.now() - checked > 60000) {
          await store.setReady(await client.ownerChatAccessible());
          checked = Date.now();
        }
        await store.collect();
        await jobs.reconcile();
        await writeFile('/tmp/news-forward-alerts-heartbeat', String(Date.now()), { mode: 0o600 });
      } catch {
        process.stderr.write('News Telegram scan unavailable; retained outbox will be retried.\n');
      }
      await delay(5000, undefined, { signal: abort.signal }).catch(() => {});
    }
  } finally {
    await jobs.close();
    await store.close();
  }
}
void main().catch(() => {
  process.stderr.write('News Telegram notifier failed; inspect private configuration.\n');
  process.exit(1);
});
