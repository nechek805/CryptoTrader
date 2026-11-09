import { canonicalHash } from '@crypto/core';
import { createNewsForwardRun } from '../../packages/paper/src/news-forward-engine.js';
import {
  ForwardManifest,
  NewsBook,
  NewsInstrument,
} from '../../packages/contracts/src/news-forward.js';
import type { LiveAsset } from '../../packages/contracts/src/news-forward.js';
import { MARKET_ASSETS } from '../../packages/contracts/src/market-tests.js';
import {
  LiveNewsVersionSchema,
  LiveNewsSourceView,
} from '../../packages/contracts/src/live-news.js';
import { initialLiveNewsSources } from '../../packages/news/src/live-source-catalog.js';
import { liveTestMarket, LIVE_TEST_TIME as T } from './live-paper.js';
export { T };
export function forwardFixture() {
  const profile = {
    config: {
      id: 'SYNTHETIC_ONLY',
      horizonHours: 1,
      minSamples: 3,
      edgeBuffer: 1,
      uncertaintyZ: 0,
    },
    rules: [
      {
        group: 'ADOPTION',
        count: 10,
        side: 'LONG' as const,
        meanExcessReturn: 0.1,
        standardError: 0,
      },
      {
        group: 'SECURITY',
        count: 10,
        side: 'SHORT' as const,
        meanExcessReturn: -0.1,
        standardError: 0,
      },
    ],
    modelHash: canonicalHash('SYNTHETIC_PROFILE'),
    selectedCase: 'V2_BASELINE',
  };
  const manifest = ForwardManifest.parse({
    reportRunId: '11111111-1111-4111-8111-111111111111',
    reportHash: canonicalHash('SYNTHETIC_REPORT'),
    engineHash: canonicalHash('SYNTHETIC_RESEARCH'),
    profiles: Object.fromEntries(MARKET_ASSETS.map((a) => [a, profile])),
    interpretation: 'EXPLORATORY_FORWARD_PAPER_ONLY',
    historicalQualification: false,
  });
  const run = createNewsForwardRun(T, manifest, canonicalHash('SYNTHETIC_FORWARD'));
  const source = LiveNewsSourceView.parse({
    config: initialLiveNewsSources().find((s) => s.id === 'federal-reserve'),
    health: {
      lastAttemptAt: T + 1000,
      lastSuccessAt: T + 1000,
      nextAllowedAt: 0,
      lastError: null,
      lastHttpStatus: 200,
      consecutiveFailures: 0,
      lastItemCount: 1,
      totalArticles: 1,
      requestsToday: 1,
      state: 'HEALTHY',
    },
  });
  const version = LiveNewsVersionSchema.parse({
    id: 'a'.repeat(64),
    articleId: 'b'.repeat(64),
    sourceId: source.config.id,
    sourceRevision: source.config.revision,
    revision: 1,
    publisher: 'SYNTHETIC TEST SOURCE',
    independenceGroup: source.config.independenceGroup,
    title: 'Synthetic ETH adoption launch',
    url: 'https://www.federalreserve.gov/synthetic-test-only',
    providerItemId: 'synthetic-only',
    excerpt: 'Synthetic fixture, never collected or sent to Telegram.',
    language: 'en',
    publishedAt: T + 500,
    firstSeenAt: T + 1000,
    fetchedAt: T + 1000,
    availableAt: T + 1001,
    publisherUpdatedAt: null,
    contentHash: 'c'.repeat(64),
    feedHash: 'd'.repeat(64),
    duplicateGroup: 'e'.repeat(64),
    timestampStatus: 'VALID',
    captureKind: 'LIVE_POLL',
    aiAllowed: true,
  });
  return { run, source, version };
}
export function forwardMarket(at: number, asset: LiveAsset = 'ETH', price = 100, size = '1000') {
  const m = liveTestMarket(at, 'BINANCE', 'SOL', price, size);
  return {
    book: NewsBook.parse({ ...m.book, asset }),
    instrument: NewsInstrument.parse({ ...m.instrument, asset }),
    bars: null,
  };
}
