import { join } from 'node:path';
import { canonicalHash } from '@crypto/core';
import { MARKET_ASSETS } from '../../../packages/contracts/src/market-tests.js';
import { NewsV4Run } from '../../../packages/contracts/src/news-research-v4.js';
import { NewsV3Report } from '../../../packages/contracts/src/news-research-v3.js';
import { NewsResearchStore } from '../../../packages/db/src/news-research-store.js';
import { collectFreeNewsHistory } from '../../../packages/research/src/free-news-history.js';
import { loadNewsLongMarket } from '../../../packages/research/src/news-long-history.js';
import { buildNewsV4Report } from '../../../packages/backtest/src/news-history-v4.js';
export async function executeNewsV4(
  store: NewsResearchStore,
  id: string,
  root: string,
  progress: (s: string) => Promise<void>,
) {
  const run = NewsV4Run.parse(await store.run(id)),
    seed = await store.snapshot(id);
  const parent = NewsV3Report.parse(
    await new NewsResearchStore(store.news, 'v3').report(run.baselineRunId),
  );
  const directory = join(root, 'v4-cache');
  const corpus =
    (await store.corpus(id)) ??
    (await store.saveCorpus(id, await collectFreeNewsHistory(directory, run.plan, seed, progress)));
  const markets = [];
  for (const asset of MARKET_ASSETS)
    markets.push({ asset, ...(await loadNewsLongMarket(directory, asset, run.plan, progress)) });
  const report = await buildNewsV4Report(
    parent,
    run.baselineRunId,
    corpus,
    run.plan,
    markets,
    canonicalHash(seed),
    progress,
  );
  const reportHash = await store.complete(id, report);
  return { reportHash, corpusHash: report.corpusHash };
}
