import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canonicalHash } from '@crypto/core';
import type { MarketAsset, MarketHistory } from '../../contracts/src/market-tests.js';
import { NewsLongMarketManifest } from '../../contracts/src/news-research-v4.js';
import { HashSchema } from '../../contracts/src/primitives.js';
import type { ResearchPlan } from '../../contracts/src/news-research.js';
import { newsResearchPlan, shiftNewsMonth } from './news-history-study.js';
import {
  downloadMarketHistory,
  downloadMarketMetadata,
  saveMarketHistory,
  loadMarketHistory,
} from './market-test-history.js';

export type NewsLongPrices = {
  version: 'chunked-news-price-view.v4';
  origin: MarketHistory['origin'];
  instrument: MarketHistory['instrument'];
  from: number;
  to: number;
  bars: MarketHistory['bars'];
};
/** Internal price-only adapter for legacy pure arithmetic. Never stored/hashed/parsed as market-history.v1. */
export const legacyNewsPrices = (prices: NewsLongPrices) => prices as unknown as MarketHistory;
export function newsV4Plan(to: number) {
  return {
    ...newsResearchPlan(to, true),
    from: shiftNewsMonth(to, -36),
    trainEnd: shiftNewsMonth(to, -12),
    validationEnd: shiftNewsMonth(to, -6),
  };
}
export async function loadNewsLongMarket(
  root: string,
  asset: MarketAsset,
  plan: ResearchPlan,
  progress: (s: string) => Promise<void> = async () => {},
) {
  await mkdir(root, { recursive: true });
  const marketRoot = join(root, 'market');
  let metadata: unknown;
  const metadataPath = join(root, `metadata-${plan.to}.json`);
  try {
    metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as unknown;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    metadata = await downloadMarketMetadata();
    const temp = metadataPath + '.' + randomUUID() + '.tmp';
    await writeFile(temp, JSON.stringify(metadata));
    await rename(temp, metadataPath);
  }
  const chunks: MarketHistory[] = [],
    manifestChunks: { id: z.infer<typeof HashSchema>; from: number; to: number }[] = [];
  for (let from = plan.from; from < plan.to;) {
    const to = Math.min(shiftNewsMonth(from, 6), plan.to),
      pointer = join(root, `${asset}-${from}-${to}.json`);
    await progress(
      `${asset}: verify/download hourly history ${new Date(from).toISOString().slice(0, 10)} to ${new Date(to).toISOString().slice(0, 10)}`,
    );
    let saved;
    try {
      const p = z
        .strictObject({ id: HashSchema })
        .parse(JSON.parse(await readFile(pointer, 'utf8')) as unknown);
      saved = await loadMarketHistory(marketRoot, p.id);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      saved = await saveMarketHistory(
        marketRoot,
        await downloadMarketHistory(asset, from, to, metadata),
      );
      const temp = pointer + '.' + randomUUID() + '.tmp';
      await writeFile(temp, JSON.stringify({ id: saved.id }));
      await rename(temp, pointer);
    }
    if (
      saved.dataset.origin !== 'PUBLIC_HISTORICAL' ||
      saved.dataset.instrument.asset !== asset ||
      saved.dataset.from !== from ||
      saved.dataset.to !== to
    )
      throw new Error('Long history chunk mismatch');
    chunks.push(saved.dataset);
    manifestChunks.push({ id: saved.id, from, to });
    from = to;
  }
  const prices: NewsLongPrices = {
    version: 'chunked-news-price-view.v4',
    origin: 'PUBLIC_HISTORICAL',
    instrument: chunks[0]!.instrument,
    from: plan.from,
    to: plan.to,
    bars: chunks.flatMap((c) => c.bars),
  };
  if (
    prices.bars.length !== (plan.to - plan.from) / 3600000 ||
    prices.bars.some((b, i) => b.at !== plan.from + i * 3600000)
  )
    throw new Error('Long market has a gap');
  const manifest = NewsLongMarketManifest.parse({
    version: 'chunked-news-market.v4',
    asset,
    from: plan.from,
    to: plan.to,
    chunks: manifestChunks,
    bars: prices.bars.length,
    priceHash: canonicalHash(prices.bars),
  });
  return { prices, manifest, hash: canonicalHash(manifest) };
}
