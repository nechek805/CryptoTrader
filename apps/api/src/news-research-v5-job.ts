import { join } from 'node:path';
import { canonicalHash } from '@crypto/core';
import { NewsV5Run } from '../../../packages/contracts/src/news-research-v5.js';
import { NewsV4Report } from '../../../packages/contracts/src/news-research-v4.js';
import { NewsResearchStore } from '../../../packages/db/src/news-research-store.js';
import { loadFrozenNewsMarket } from '../../../packages/research/src/news-frozen-markets-v5.js';
import { buildNewsV5Report } from '../../../packages/backtest/src/news-history-v5.js';

export async function executeNewsV5(
  store: NewsResearchStore,
  id: string,
  root: string,
  progress: (s: string) => Promise<void>,
) {
  const run = NewsV5Run.parse(await store.run(id)),
    parentStore = new NewsResearchStore(store.news, 'v4');
  const parent = NewsV4Report.parse(await parentStore.report(run.baselineRunId));
  const corpus = await parentStore.corpus(run.baselineRunId);
  if (
    !corpus ||
    canonicalHash(corpus) !== parent.corpusHash ||
    canonicalHash(corpus.snapshot) !== parent.snapshotHash ||
    canonicalHash(await store.snapshot(id)) !== parent.snapshotHash ||
    canonicalHash(run.plan) !== parent.planHash
  )
    throw new Error('V5 frozen parent corpus mismatch');
  const markets = [];
  for (const manifest of parent.markets) {
    await progress(`${manifest.asset}: verify exact parent candle hashes; no downloads`);
    markets.push(await loadFrozenNewsMarket(join(root, 'v4-cache'), manifest));
  }
  const report = await buildNewsV5Report(parent, run.baselineRunId, markets, progress);
  return { reportHash: await store.complete(id, report) };
}
