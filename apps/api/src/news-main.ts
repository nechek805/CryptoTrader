import { LiveNewsStore } from '../../../packages/db/src/live-news-store.js';
import { initialLiveNewsSources } from '../../../packages/news/src/live-source-catalog.js';
import { createNewsQueues } from './live-news-queue.js';
import { buildLiveNewsApi } from './live-news-api.js';
import { NewsResearchStore } from '../../../packages/db/src/news-research-store.js';
import { createNewsResearchQueue } from './news-research-jobs.js';

async function main() {
  const store = new LiveNewsStore(
      process.env.NEWS_DATABASE_URL ?? process.env.LIVE_PAPER_DATABASE_URL ?? '',
    ),
    queues = createNewsQueues(process.env.REDIS_URL ?? '');
  await store.migrate();
  await store.seed(initialLiveNewsSources());
  const researchStore = new NewsResearchStore(store),
    v3Store = new NewsResearchStore(store, 'v3'),
    v4Store = new NewsResearchStore(store, 'v4'),
    v5Store = new NewsResearchStore(store, 'v5'),
    v6Store = new NewsResearchStore(store, 'v6'),
    researchQueue = createNewsResearchQueue(process.env.REDIS_URL ?? '');
  await researchStore.migrate();
  await v3Store.migrate();
  await v4Store.migrate();
  await v5Store.migrate();
  await v6Store.migrate();
  const app = buildLiveNewsApi(
    store,
    queues,
    {
      proxySecret: process.env.OPS_PROXY_SECRET ?? '',
      readerToken: process.env.OPS_READ_TOKEN ?? '',
      adminToken: process.env.OPS_ADMIN_TOKEN ?? '',
      origins: (process.env.OPS_ALLOWED_ORIGINS ?? '').split(',').filter(Boolean),
    },
    { store: researchStore, queue: researchQueue, v3Store, v4Store, v5Store, v6Store },
  );
  app.addHook('onClose', async () => {
    await queues.close();
    await researchQueue.close();
    await store.close();
  });
  process.once('SIGINT', () => {
    void app.close();
  });
  process.once('SIGTERM', () => {
    void app.close();
  });
  await app.listen({ host: process.env.NEWS_BIND_HOST ?? '0.0.0.0', port: 3103 });
  process.stdout.write('Live news API ready; authenticated collection and source management.\n');
}
void main().catch(() => {
  process.stderr.write('Live news API startup failed; check private configuration.\n');
  process.exit(1);
});
