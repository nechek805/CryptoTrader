import { z } from 'zod';
import { HashSchema, DecimalStringSchema } from './primitives.js';
import {
  NewsResearchRun,
  NewsResearchModel,
  NewsResearchReport,
  NewsResearchPlan,
  NewsResearchSnapshot,
} from './news-research.js';
import { NewsV3Model, NewsV3Report, NewsV3Event } from './news-research-v3.js';
import { MarketAssetSchema } from './market-tests.js';
const time = z.number().int().nonnegative();
export const FreeHistoryCoverage = z.strictObject({
  sourceId: z.string(),
  status: z.enum(['COMPLETE', 'LIMITED', 'UNAVAILABLE']),
  attempts: z.number().int().nonnegative(),
  scanned: z.number().int().nonnegative(),
  records: z.number().int().nonnegative(),
  dated: z.number().int().nonnegative(),
  earliest: time.nullable(),
  latest: time.nullable(),
  captureHashes: z.array(HashSchema).max(600),
  notes: z.array(z.string()).max(12),
});
export const NewsV4Corpus = z.strictObject({
  version: z.literal('free-news-corpus.v4'),
  origin: z.enum(['PUBLIC_HISTORICAL', 'SYNTHETIC']),
  collectorHash: HashSchema,
  from: time,
  to: time,
  snapshot: NewsResearchSnapshot,
  coverage: z.array(FreeHistoryCoverage).max(30),
});
export const NewsLongMarketManifest = z.strictObject({
  version: z.literal('chunked-news-market.v4'),
  asset: MarketAssetSchema,
  from: time,
  to: time,
  chunks: z
    .array(z.strictObject({ id: HashSchema, from: time, to: time }))
    .min(1)
    .max(8),
  bars: z.number().int().positive(),
  priceHash: HashSchema,
});
export const NewsV4Event = NewsV3Event.extend({
  featureSign: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
  featureKind: z.enum(['EVENT_STATUS', 'LAGGED_RELEASE_DEVIATION', 'NONE']),
  baseline: z
    .strictObject({
      method: z.literal('MEDIAN_OF_PREVIOUS_THREE_ORIGINAL_RELEASES_NOT_MARKET_CONSENSUS'),
      value: DecimalStringSchema,
      previousEventIds: z.array(HashSchema).length(3),
      latestPriorPublicationAt: time,
    })
    .nullable(),
});
export const NewsV4Model = NewsV3Model.extend({
  version: z.literal('LEARNED_V4'),
  trainingMethod: z.literal('TOKEN_SPECIFIC_SIGNED_EVENT_REACTIONS'),
});
export const NewsV4Report = z
  .strictObject({
    version: z.literal('news-history-comparison.v4'),
    origin: z.literal('PUBLIC_HISTORICAL'),
    interpretation: z.literal('DESCRIPTIVE_ONLY_NOT_A_TRADABLE_BACKTEST'),
    generatedAt: time,
    engineHash: HashSchema,
    referenceV3RunId: z.string().uuid(),
    referenceV3ReportHash: HashSchema,
    referenceLegacyReportHash: HashSchema,
    plan: NewsResearchPlan,
    planHash: HashSchema,
    snapshotHash: HashSchema,
    seedSnapshotHash: HashSchema,
    corpusHash: HashSchema,
    protocol: z.strictObject({
      months: z.literal(36),
      trainingMonths: z.literal(24),
      validationMonths: z.literal(6),
      testMonths: z.literal(6),
      feeMode: z.literal('ON'),
      candidates: z.literal(6),
      minimumSamples: z.tuple([z.literal(12), z.literal(20)]),
      uncertaintyZ: z.literal(1.96),
      costBuffer: z.literal(2),
      validationTrades: z.literal(5),
      macroFeature: z.literal('LAGGED_RELEASE_DEVIATION_NOT_MARKET_CONSENSUS'),
      execution: z.literal('HOURLY_BASELINE_ASSUMPTIONS'),
      selection: z.literal('FIXED_UNIVERSE_ALREADY_INSPECTED_HOLDOUT'),
    }),
    coverage: z.array(FreeHistoryCoverage).max(30),
    markets: z.array(NewsLongMarketManifest).length(10),
    events: z.array(NewsV4Event).max(20000),
    legacyEvents: NewsResearchReport.shape.events,
    rows: z
      .array(
        NewsResearchReport.shape.rows.element.omit({ models: true }).extend({
          models: z.array(z.union([NewsResearchModel, NewsV3Model, NewsV4Model])).max(4),
          v4Coverage: NewsV3Report.shape.rows.element.shape.v3Coverage,
        }),
      )
      .length(11),
    limitations: z.array(z.string()).max(25),
  })
  .superRefine((r, c) => {
    if (
      new Set(r.rows.map((x) => x.asset)).size !== 11 ||
      new Set(r.markets.map((x) => x.asset)).size !== 10
    )
      c.addIssue({ code: 'custom', message: 'Complete market universe required' });
    for (const row of r.rows) {
      if (row.asset === 'USDT') {
        if (row.models.length || row.status !== 'CASH_CONTROL')
          c.addIssue({ code: 'custom', message: 'USDT stays cash' });
      } else if (
        row.status !== 'COMPLETE' ||
        row.models.map((x) => x.version).join(',') !== 'RULES_V1,LEARNED_V2,LEARNED_V3,LEARNED_V4'
      )
        c.addIssue({ code: 'custom', message: 'Four comparable models required' });
    }
  });
export const NewsV4Run = NewsResearchRun.extend({ baselineRunId: z.string().uuid() });
export const NewsV4Status = z.strictObject({
  runs: z.array(NewsV4Run).max(20),
  workerHealthy: z.boolean(),
});
export type V4Report = z.infer<typeof NewsV4Report>;
export type V4Event = z.infer<typeof NewsV4Event>;
export type V4Model = z.infer<typeof NewsV4Model>;
export type V4Corpus = z.infer<typeof NewsV4Corpus>;
export type FreeCoverage = z.infer<typeof FreeHistoryCoverage>;
export type LongMarketManifest = z.infer<typeof NewsLongMarketManifest>;
