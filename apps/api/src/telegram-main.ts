import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { telegramSettings } from '../../../packages/contracts/src/telegram.js';
import { TelegramStore } from '../../../packages/db/src/telegram-store.js';
import { TelegramClient, TelegramFailure } from './telegram-client.js';
import { telegramDelivery } from './telegram-jobs.js';
async function main() {
  if (process.env.TELEGRAM_ENABLED !== '1') {
    process.stdout.write('Telegram notifications disabled.\n');
    return;
  }
  const config = telegramSettings(process.env),
    client = new TelegramClient(config.token, config.userId),
    identity = await client.identity();
  if (await client.webhookConfigured()) throw Error('TELEGRAM_EXISTING_WEBHOOK');
  const store = new TelegramStore(
    config.databaseUrl,
    `${identity.id}:${config.userId}`,
    config.dashboardUrl,
  );
  await store.migrate();
  const lease = await store.acquire();
  await store.initialize();
  let closing = false,
    scanBusy = false,
    lastScan = 0,
    lastPoll = 0,
    lastError: string | null = null;
  const delivery = telegramDelivery(store, client, config.redisUrl);
  const abort = new AbortController();
  const stop = () => {
    closing = true;
    abort.abort();
  };
  lease.on('error', () => {
    lastError = 'TELEGRAM_DATABASE_LEASE_LOST';
    stop();
  });
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  await delivery.worker.waitUntilReady();
  await delivery.queue.waitUntilReady();
  await store.setReady(await client.ownerChatAccessible());
  await store.welcome();
  const scan = async () => {
    if (scanBusy || closing) return;
    scanBusy = true;
    try {
      await lease.query('SELECT 1');
      await store.collect();
      await delivery.reconcile();
      lastScan = Date.now();
    } catch {
      lastError = 'TELEGRAM_SCAN_OR_QUEUE_ERROR';
    } finally {
      scanBusy = false;
    }
  };
  const poll = async () => {
    while (!closing) {
      try {
        const updates = await client.updates(await store.offset());
        for (const update of updates) await store.command(update, config.userId);
        lastPoll = Date.now();
      } catch (e) {
        lastError = e instanceof TelegramFailure ? e.code : 'TELEGRAM_UPDATE_ERROR';
        await delay(5000, undefined, { signal: abort.signal }).catch(() => {});
      }
    }
  };
  await scan();
  const poller = poll();
  const timer = setInterval(() => {
    void scan();
  }, 5000);
  try {
    process.stdout.write(
      `Telegram notifier ready: @${identity.username}; private allowlist and simulated positions only.\n`,
    );
    while (!closing) {
      const now = Date.now();
      if (now - lastScan < 90000 && now - lastPoll < 90000)
        await writeFile('/tmp/telegram-heartbeat', String(now), { mode: 0o600 });
      await writeFile(
        '/tmp/telegram-status.json',
        JSON.stringify({
          bot: identity.username,
          lastScan,
          lastPoll,
          lastError,
          ready: await store.ready(),
        }),
        { mode: 0o600 },
      );
      await delay(5000, undefined, { signal: abort.signal }).catch(() => {});
    }
  } finally {
    clearInterval(timer);
    await poller;
    while (scanBusy) await delay(50);
    await delivery.close();
    await store.close();
  }
}
void main().catch(() => {
  process.stderr.write(
    'Telegram service failed; check private configuration and restricted database permissions.\n',
  );
  process.exit(1);
});
