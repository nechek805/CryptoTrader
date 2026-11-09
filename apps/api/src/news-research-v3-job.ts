import { join } from 'node:path';
import { canonicalHash } from '@crypto/core';
import { NewsV3Run } from '../../../packages/contracts/src/news-research-v3.js';
import { NewsResearchReport } from '../../../packages/contracts/src/news-research.js';
import { NewsResearchStore } from '../../../packages/db/src/news-research-store.js';
import { loadMarketHistory } from '../../../packages/research/src/market-test-history.js';
import { structureNewsV3 } from '../../../packages/research/src/news-events-v3.js';
import { collectNewsMinuteDiagnostics } from '../../../packages/research/src/news-minute-windows.js';
import { buildNewsV3Comparison } from '../../../packages/backtest/src/news-history-v3.js';

export async function executeNewsV3(
  store: NewsResearchStore,
  id: string,
  root: string,
  progress: (s: string) => Promise<void>,
) {
  const run = NewsV3Run.parse(await store.run(id)),
    legacyStore = new NewsResearchStore(store.news);
  const baseline = NewsResearchReport.parse(await legacyStore.report(run.baselineRunId)),
    snapshot = await store.snapshot(id);
  if (canonicalHash(snapshot) !== baseline.snapshotHash)
    throw new Error('V3 baseline news snapshot changed');
  const markets = [];
  for (const row of baseline.rows) {
    if (row.asset === 'USDT') continue;
    if (!row.marketHash) throw new Error('V3 needs complete frozen baseline markets');
    await progress(`${row.asset}: verifying the original market snapshot; V1/V2 remain frozen`);
    const saved = await loadMarketHistory(join(root, 'market'), row.marketHash);
    markets.push({ asset: row.asset, history: saved.dataset, hash: saved.id });
  }
  const structured = structureNewsV3(snapshot, baseline.plan);
  const minutes = await collectNewsMinuteDiagnostics(root, structured, baseline.plan, progress);
  const report = await buildNewsV3Comparison(
    baseline,
    snapshot,
    run.baselineRunId,
    markets,
    minutes,
    progress,
  );
  const reportHash = await store.complete(id, report);
  return { reportHash, baselineReportHash: report.baselineReportHash };
}
