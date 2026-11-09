import { join } from 'node:path';
import { canonicalHash } from '@crypto/core';
import { NewsLongMarketManifest } from '../../contracts/src/news-research-v4.js';
import type { LongMarketManifest } from '../../contracts/src/news-research-v4.js';
import type { NewsLongPrices } from './news-long-history.js';
import { loadMarketHistory } from './market-test-history.js';

/** Read only the parent's content-addressed chunks. Missing/corrupt input fails; never downloads. */
export async function loadFrozenNewsMarket(root: string, input: LongMarketManifest) {
  const manifest = NewsLongMarketManifest.parse(input),
    chunks = [];
  let next = manifest.from;
  for (const chunk of manifest.chunks) {
    if (chunk.from !== next || chunk.to <= chunk.from || chunk.to > manifest.to)
      throw new Error('V5 frozen market chunk boundary mismatch');
    const { dataset } = await loadMarketHistory(join(root, 'market'), chunk.id);
    if (
      dataset.origin !== 'PUBLIC_HISTORICAL' ||
      dataset.instrument.asset !== manifest.asset ||
      dataset.from !== chunk.from ||
      dataset.to !== chunk.to ||
      (chunks.length && canonicalHash(dataset.instrument) !== canonicalHash(chunks[0]!.instrument))
    )
      throw new Error('V5 frozen market metadata mismatch');
    chunks.push(dataset);
    next = chunk.to;
  }
  const prices: NewsLongPrices = {
    version: 'chunked-news-price-view.v4',
    origin: 'PUBLIC_HISTORICAL',
    instrument: chunks[0]!.instrument,
    from: manifest.from,
    to: manifest.to,
    bars: chunks.flatMap((c) => c.bars),
  };
  if (
    next !== manifest.to ||
    prices.bars.length !== manifest.bars ||
    prices.bars.length !== (manifest.to - manifest.from) / 3600000 ||
    prices.bars.some((b, i) => b.at !== manifest.from + i * 3600000) ||
    canonicalHash(prices.bars) !== manifest.priceHash
  )
    throw new Error('V5 frozen market price hash/gap mismatch');
  return prices;
}
