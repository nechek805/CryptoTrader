import { join } from 'node:path';
import { canonicalHash } from '@crypto/core';
import { NewsV6Run } from '../../../packages/contracts/src/news-research-v6.js';
import { NewsV5Report } from '../../../packages/contracts/src/news-research-v5.js';
import { NewsResearchStore } from '../../../packages/db/src/news-research-store.js';
import { loadFrozenNewsMarket } from '../../../packages/research/src/news-frozen-markets-v5.js';
import { buildNewsV6Report } from '../../../packages/backtest/src/news-history-v6.js';
export async function executeNewsV6(
  store: NewsResearchStore,
  id: string,
  root: string,
  progress: (s: string) => Promise<void>,
) {
  const run = NewsV6Run.parse(await store.run(id)),
    parent = NewsV5Report.parse(
      await new NewsResearchStore(store.news, 'v5').report(run.baselineRunId),
    );
  const corpus = await new NewsResearchStore(store.news, 'v4').corpus(parent.referenceV4RunId);
  if (
    !corpus ||
    canonicalHash(corpus) !== parent.corpusHash ||
    canonicalHash(corpus.snapshot) !== parent.snapshotHash ||
    canonicalHash(await store.snapshot(id)) !== parent.snapshotHash ||
    canonicalHash(run.plan) !== parent.planHash
  )
    throw new Error('V6 frozen parent inputs mismatch');
  const markets = [];
  for (const manifest of parent.markets) {
    await progress(`${manifest.asset}: verify parent candle hashes without downloads`);
    markets.push(await loadFrozenNewsMarket(join(root, 'v4-cache'), manifest));
  }
  const report = await buildNewsV6Report(parent, run.baselineRunId, corpus, markets, progress);
  return { reportHash: await store.complete(id, report) };
}
