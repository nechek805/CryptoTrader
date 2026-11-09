import { canonicalHash } from '@crypto/core';
import { BtcHourSchema } from '../../packages/contracts/src/btc-test.js';
import { NewsResearchEvent } from '../../packages/contracts/src/news-research.js';
import { newsV4Plan } from '../../packages/research/src/news-long-history.js';
import type { NewsLongPrices } from '../../packages/research/src/news-long-history.js';
import { marketHistoryFixture } from './market-history.js';
export function syntheticV5Study() {
  const H = 3600000,
    plan = newsV4Plan(Date.UTC(2026, 10, 7, 9));
  const prices: NewsLongPrices = {
    version: 'chunked-news-price-view.v4',
    origin: 'SYNTHETIC',
    instrument: marketHistoryFixture().instrument,
    from: plan.from,
    to: plan.to,
    bars: Array.from({ length: (plan.to - plan.from) / H }, (_, i) =>
      BtcHourSchema.parse({
        at: plan.from + i * H,
        open: '100',
        high: '100.1',
        low: '99.9',
        close: '100',
        volume: '1000000',
      }),
    ),
  };
  const events = [];
  for (let day = 10; day < (plan.to - plan.from) / (24 * H) - 5; day += 10) {
    const long = day % 20 === 0,
      index = day * 24 + 1;
    for (let j = index; j < index + 4; j++)
      prices.bars[j] = BtcHourSchema.parse({
        ...prices.bars[j]!,
        high: long ? '104' : '100.1',
        low: long ? '99.9' : '96',
        close: long ? '103' : '97',
      });
    events.push(
      NewsResearchEvent.parse({
        id: canonicalHash({ synthetic: day }),
        versionId: 'synthetic-' + day,
        sourceId: 'synthetic-official',
        publisher: 'Synthetic issuer',
        independenceGroup: 'synthetic',
        title: 'Synthetic recurring release',
        url: 'https://example.test/synthetic/' + day,
        assets: ['BTC'],
        group: long ? 'SYNTHETIC_LONG' : 'SYNTHETIC_SHORT',
        publishedAt: plan.from + day * 24 * H,
        availableAt: plan.to + H,
        fixedSide: 'HOLD',
        scope: 'DIRECT',
        timing: 'DESCRIPTIVE_PUBLICATION_PROXY',
      }),
    );
  }
  return { prices, plan, events };
}
