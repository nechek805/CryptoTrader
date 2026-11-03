import {
  ReplayInputSchema,
  ReplayRequestSchema,
  MarketBarSchema,
  NewsDocumentSchema,
} from '@crypto/contracts';
import { canonicalHash, fromEpoch } from '@crypto/core';

/** Entirely fictional simultaneous observations, delayed prices/news and a late correction. */
export function replayFixture() {
  const at = (s: number) => fromEpoch(1767225600n + BigInt(s), 'seconds'),
    source = {
      origin: 'FIXTURE',
      sourceIds: ['synthetic:replay-market'],
      parentIds: [],
      sourceVersion: 'synthetic-replay.v1',
      capturedAt: at(60),
      rawTimestamp: null,
    },
    bars = [
      { id: 'synthetic:bar:1', minute: 1, price: '100', available: 60 },
      { id: 'synthetic:bar:2', minute: 2, price: '102', available: 150 },
      { id: 'synthetic:bar:3', minute: 3, price: '103', available: 180 },
      { id: 'synthetic:bar:1-corrected', minute: 1, price: '101', available: 190 },
      { id: 'synthetic:bar:4', minute: 4, price: '104', available: 240 },
    ].map((b) =>
      MarketBarSchema.parse({
        schemaVersion: 'market-bar.v1',
        id: b.id,
        exchange: 'synthetic-replay',
        instrumentId: 'BTC/USDT',
        marketType: 'SPOT',
        interval: { value: 1, unit: 'minutes' },
        openAt: at((b.minute - 1) * 60),
        closeAt: at(b.minute * 60),
        open: '100',
        high: '110',
        low: '90',
        close: b.price,
        volume: '10',
        availableAt: at(b.available),
        availabilityBasis: 'OBSERVED',
        researchUse: 'ELIGIBLE',
        sourceVersion: 'synthetic-replay.v1',
        qualityFlags: ['SYNTHETIC'],
        provenance: { ...source, capturedAt: at(b.available), parentIds: [canonicalHash(b)] },
      }),
    ),
    news = [
      {
        id: 'synthetic:news:1',
        observed: 150,
        available: 150,
        title: 'Synthetic delayed announcement',
      },
      {
        id: 'synthetic:news:1-update',
        observed: 180,
        available: 180,
        title: 'Synthetic announcement correction',
      },
    ].map((n) =>
      NewsDocumentSchema.parse({
        schemaVersion: 'news-document.v1',
        id: n.id,
        sourceId: 'synthetic:replay-news',
        canonicalUrl: 'https://example.invalid/synthetic-replay',
        sourceChain: [
          { sourceId: 'synthetic:replay-news', documentId: n.id, relationship: 'ORIGINAL' },
        ],
        language: 'en',
        publishedAt: at(30),
        firstObservedAt: at(n.observed),
        availableAt: at(n.available),
        availabilityBasis: 'OBSERVED',
        researchUse: 'ELIGIBLE',
        licensing: {
          policy: 'SYNTHETIC',
          reference: 'Locally authored synthetic fixture',
          permitsSnippet: false,
        },
        contentHash: canonicalHash(n),
        title: n.title,
        qualityFlags: ['SYNTHETIC'],
        provenance: {
          ...source,
          sourceIds: ['synthetic:replay-news'],
          capturedAt: at(n.observed),
          parentIds: [canonicalHash(n)],
        },
      }),
    ),
    descriptive = MarketBarSchema.parse({
      ...bars[0],
      id: 'synthetic:bar:descriptive',
      instrumentId: 'ETH/USDT',
      availableAt: null,
      availabilityBasis: 'UNKNOWN',
      researchUse: 'DESCRIPTIVE_ONLY',
    }),
    input = ReplayInputSchema.parse({
      schemaVersion: 'replay-input.v1',
      bars: [...bars, descriptive],
      news,
    }),
    request = ReplayRequestSchema.parse({
      schemaVersion: 'replay-request.v1',
      startAt: at(120),
      endAt: at(240),
      generatedAt: at(300),
      symbols: ['BTC/USDT'],
      randomSeed: 42,
      snapshotEvery: 2,
      maxQueriesPerEvent: 20,
    });
  return { input, request };
}
