import { LiveNewsStore } from '../../../packages/db/src/live-news-store.js';
import { NewsResearchStore } from '../../../packages/db/src/news-research-store.js';
import {
  createNewsResearchQueue,
  createNewsResearchWorker,
  reconcileNewsResearch,
  heartbeat,
} from './news-research-jobs.js';

async function main() {
  const news = new LiveNewsStore(process.env.NEWS_DATABASE_URL ?? ''),
    store = new NewsResearchStore(news),
    v3Store = new NewsResearchStore(news, 'v3'),
    v4Store = new NewsResearchStore(news, 'v4'),
    v5Store = new NewsResearchStore(news, 'v5'),
    v6Store = new NewsResearchStore(news, 'v6');
  await news.migrate();
  await store.migrate();
  await v3Store.migrate();
  await v4Store.migrate();
  await v5Store.migrate();
  await v6Store.migrate();
  const url = process.env.REDIS_URL ?? '',
    queue = createNewsResearchQueue(url);
  const worker = createNewsResearchWorker(
    store,
    url,
    process.env.NEWS_RESEARCH_DIRECTORY ?? '/news-research',
    undefined,
    v3Store,
    v4Store,
    v5Store,
    v6Store,
  );
  await worker.waitUntilReady();
  const tick = async () => {
    await reconcileNewsResearch(store, queue);
    await reconcileNewsResearch(v3Store, queue);
    await reconcileNewsResearch(v4Store, queue);
    await reconcileNewsResearch(v5Store, queue);
    await reconcileNewsResearch(v6Store, queue);
    await heartbeat(store);
  };
  await tick();
  let ticking = false;
  const timer = setInterval(() => {
    if (!ticking) {
      ticking = true;
      void tick()
        .catch(() => {})
        .finally(() => {
          ticking = false;
        });
    }
  }, 15000);
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    clearInterval(timer);
    await worker.close();
    await queue.close();
    await news.close();
  };
  process.once('SIGTERM', () => {
    void close();
  });
  process.once('SIGINT', () => {
    void close();
  });
  process.stdout.write('News historical research worker ready; bounded research only.\n');
}
void main().catch(() => {
  process.stderr.write('News research startup failed; check private configuration.\n');
  process.exit(1);
});
