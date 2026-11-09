import { mkdir, readFile, writeFile, rename, lstat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import {
  MARKET_ASSETS,
  MarketAssetSchema,
  HashSchema,
  MarketCaptureSchema,
} from '@crypto/contracts';
import type { MarketAsset, MarketHistory } from '@crypto/contracts';
import { latestBtcDataset } from './btc-history.js';
import {
  downloadMarketMetadata,
  marketInstrument,
  verifyMarketHistory,
  downloadMarketHistory,
  saveMarketHistory,
  loadMarketHistory,
} from './market-test-history.js';
const Cache = z.strictObject({
  anchorId: HashSchema,
  from: z.number().int(),
  to: z.number().int(),
  metadata: MarketCaptureSchema,
  datasets: z.partialRecord(MarketAssetSchema, HashSchema),
});
export async function prepareMarketTestInputs(
  root: string,
  btcRoot: string,
  progress: (text: string) => void = () => {},
) {
  const anchor = await latestBtcDataset(btcRoot);
  if (!anchor || anchor.dataset.origin !== 'PUBLIC_HISTORICAL')
    throw new Error('Load a real BTC snapshot first');
  const directory = join(root, 'inputs');
  await mkdir(directory, { recursive: true });
  const path = join(directory, anchor.id.slice(7) + '.json');
  let cache: z.infer<typeof Cache>;
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size > 32000000) throw new Error('Invalid market input cache');
    cache = Cache.parse(JSON.parse(await readFile(path, 'utf8')) as unknown);
    if (
      cache.anchorId !== anchor.id ||
      cache.from !== anchor.dataset.from ||
      cache.to !== anchor.dataset.to
    )
      throw new Error('Market input anchor mismatch');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    cache = Cache.parse({
      anchorId: anchor.id,
      from: anchor.dataset.from,
      to: anchor.dataset.to,
      metadata: await downloadMarketMetadata(),
      datasets: {},
    });
  }
  const rows: {
    asset: MarketAsset;
    dataset: MarketHistory | null;
    datasetId: string | null;
    error: string | null;
  }[] = [];
  for (const asset of MARKET_ASSETS) {
    try {
      progress(`${asset}: checking frozen inputs`);
      let stored;
      if (cache.datasets[asset])
        stored = await loadMarketHistory(join(root, 'datasets'), cache.datasets[asset]);
      else {
        const dataset =
          asset === 'BTC'
            ? verifyMarketHistory({
                version: 'market-history.v1',
                origin: 'PUBLIC_HISTORICAL',
                instrument: marketInstrument(cache.metadata, asset),
                interval: '1h',
                from: cache.from,
                to: cache.to,
                capturedAt: new Date().toISOString(),
                historicalAvailability: 'UNKNOWN',
                captures: anchor.dataset.captures,
                bars: anchor.dataset.bars,
                referenceBtcDatasetId: anchor.id,
              })
            : await downloadMarketHistory(asset, cache.from, cache.to, cache.metadata, progress);
        stored = await saveMarketHistory(join(root, 'datasets'), dataset);
        cache.datasets[asset] = stored.id;
        const temporary = path + '.' + randomUUID() + '.tmp';
        await writeFile(temporary, JSON.stringify(cache), { flag: 'wx' });
        await rename(temporary, path);
      }
      if (
        stored.dataset.instrument.asset !== asset ||
        stored.dataset.from !== cache.from ||
        stored.dataset.to !== cache.to ||
        stored.dataset.origin !== 'PUBLIC_HISTORICAL'
      )
        throw new Error('Cached market differs from requested range');
      rows.push({ asset, dataset: stored.dataset, datasetId: stored.id, error: null });
    } catch {
      rows.push({
        asset,
        dataset: null,
        datasetId: null,
        error: 'Public market history unavailable or failed verification. Retry this fixed window.',
      });
    }
  }
  return { anchor, rows };
}
