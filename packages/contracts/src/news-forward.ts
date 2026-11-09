import { z } from 'zod';
import {
  LiveBookSchema,
  LiveBarsSchema,
  LiveInstrumentSchema,
  LivePositionSchema,
  LiveRunSchema,
  LiveOverviewSchema,
  LiveFeedSchema,
  LivePageSchema,
  LiveQuerySchema,
} from './live-paper.js';
import { MarketAssetSchema } from './market-tests.js';
import { NewsResearchConfig, NewsResearchRule } from './news-research.js';
import { HashSchema } from './primitives.js';
export { LIVE_EXCHANGES, LiveExchangeSchema } from './live-paper.js';
export type { LiveExchange, LiveSource } from './live-paper.js';
export { MARKET_ASSETS as LIVE_ASSETS } from './market-tests.js';
export type { MarketAsset as LiveAsset } from './market-tests.js';
export const NewsBook = LiveBookSchema.extend({ asset: MarketAssetSchema });
export const NewsBars = LiveBarsSchema.extend({ asset: MarketAssetSchema });
export const NewsInstrument = LiveInstrumentSchema.extend({ asset: MarketAssetSchema });
export const NewsPosition = LivePositionSchema.extend({
  asset: MarketAssetSchema,
  strategy: z.literal('NEWS_V6'),
});
export const ForwardProfile = z.strictObject({
  config: NewsResearchConfig,
  rules: z.array(NewsResearchRule).max(100),
  modelHash: HashSchema,
  selectedCase: z.string().max(80),
});
export const ForwardManifest = z.strictObject({
  reportRunId: z.string().uuid(),
  reportHash: HashSchema,
  engineHash: HashSchema,
  profiles: z.record(MarketAssetSchema, ForwardProfile),
  interpretation: z.literal('EXPLORATORY_FORWARD_PAPER_ONLY'),
  historicalQualification: z.literal(false),
});
const time = z.number().int().nonnegative();
export const ForwardSignal = z.strictObject({
  side: z.enum(['LONG', 'SHORT']),
  createdAt: time,
  notBefore: time,
  expiresAt: time,
  horizonHours: z.number().int().min(1).max(168),
  decision: z.record(z.string(), z.unknown()),
});
export const ForwardRun = LiveRunSchema.extend({
  version: z.literal('news-forward.v1'),
  config: LiveRunSchema.shape.config.extend({
    annualBorrowRate: z.literal('0.02628'),
    profiles: z.record(MarketAssetSchema, ForwardProfile),
  }),
  positions: z.array(NewsPosition).max(50),
  pending: z.record(z.string(), ForwardSignal),
  manifest: ForwardManifest,
  processed: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(20000),
  deduplicated: z.record(z.string(), time),
  commands: z.record(z.string(), z.boolean()),
  counters: z.record(z.string(), z.number().int().nonnegative()),
});
export const ForwardQuery = z
  .strictObject({ ...LiveQuerySchema.shape, asset: MarketAssetSchema.optional() })
  .refine(
    (q) => q.from === undefined || q.to === undefined || q.from <= q.to,
    'Invalid date interval',
  );
export const ForwardFeed = LiveFeedSchema.extend({
  asset: MarketAssetSchema,
  book: NewsBook.nullable(),
  instrument: NewsInstrument.nullable(),
});
export const ForwardOverview = LiveOverviewSchema.extend({
  version: z.literal('news-forward.v1'),
  run: ForwardRun.nullable(),
  feeds: z.array(ForwardFeed).max(50),
});
export const ForwardPage = LivePageSchema.extend({ positions: z.array(NewsPosition) });
export type LiveBook = z.infer<typeof NewsBook>;
export type LiveBars = z.infer<typeof NewsBars>;
export type LiveInstrument = z.infer<typeof NewsInstrument>;
export type LivePosition = z.infer<typeof NewsPosition>;
export type LiveRun = z.infer<typeof ForwardRun>;
export type LiveQuery = z.infer<typeof ForwardQuery>;
export type Manifest = z.infer<typeof ForwardManifest>;
export type Profile = z.infer<typeof ForwardProfile>;
