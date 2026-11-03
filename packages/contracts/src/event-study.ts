import { z } from 'zod';
import { MarketBarSchema } from './domain.js';
import { MarketSnapshotManifestSchema } from './market-import.js';
import { NewsEventSnapshotSchema, NewsTemporalEventSchema } from './news-events.js';
import {
  CurrencySchema,
  DecimalStringSchema,
  HashSchema,
  IdSchema,
  SymbolSchema,
  UtcTimestampSchema,
} from './primitives.js';

export const EventStudySeriesSchema = z.strictObject({
  asset: CurrencySchema,
  exchange: IdSchema,
  instrumentId: SymbolSchema,
  marketType: z.enum(['SPOT', 'PERPETUAL']),
});
export const EventStudyRequestSchema = z
  .strictObject({
    schemaVersion: z.literal('event-study-request.v1'),
    events: z
      .array(z.strictObject({ eventId: IdSchema, decisionAt: UtcTimestampSchema }))
      .min(1)
      .max(20),
    assets: z.array(EventStudySeriesSchema).min(1).max(10),
    benchmark: EventStudySeriesSchema,
    intervalSeconds: z.union([z.literal(60), z.literal(300), z.literal(900), z.literal(3600)]),
    analysisAsOf: UtcTimestampSchema,
    generatedAt: UtcTimestampSchema,
    roundTripCostBps: z.number().int().min(0).max(10000),
    clock: z.literal('UTC_24_7_EXACT_CLOSE'),
  })
  .superRefine((v, ctx) => {
    if (v.generatedAt < v.analysisAsOf || v.events.some((e) => e.decisionAt > v.analysisAsOf))
      ctx.addIssue({ code: 'custom', message: 'Invalid study time order' });
    if (new Set(v.assets.map((a) => a.asset)).size !== v.assets.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate asset selection' });
    if (new Set(v.events.map((e) => `${e.eventId}:${e.decisionAt}`)).size !== v.events.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate event decision' });
  });
export type EventStudyRequest = z.infer<typeof EventStudyRequestSchema>;
export type EventStudySeries = z.infer<typeof EventStudySeriesSchema>;
export const EventStudyInputSchema = z.strictObject({
  schemaVersion: z.literal('event-study-input.v1'),
  newsSnapshot: NewsEventSnapshotSchema,
  marketSnapshots: z.array(MarketSnapshotManifestSchema).max(10).default([]),
  bars: z.array(MarketBarSchema).max(200000),
});
export type EventStudyInput = z.infer<typeof EventStudyInputSchema>;
export const EventStudyWindowSchema = z.strictObject({
  label: z.enum(['-24h', '-1h', '+1m', '+5m', '+15m', '+1h', '+4h', '+24h', '+72h', '+7d']),
  from: UtcTimestampSchema,
  to: UtcTimestampSchema,
  status: z.enum(['COMPLETE', 'PARTIAL', 'MISSING', 'NOT_YET_OBSERVABLE', 'UNSUPPORTED_INTERVAL']),
  expectedBars: z.number().int().nonnegative(),
  observedBars: z.number().int().nonnegative(),
  missingCloseTimes: z.array(UtcTimestampSchema).max(10081),
  startBarId: IdSchema.nullable(),
  endBarId: IdSchema.nullable(),
  barIds: z.array(IdSchema).max(10081),
  excludedBarIds: z.array(IdSchema).max(200000),
  grossReturn: DecimalStringSchema.nullable(),
  netReturn: DecimalStringSchema.nullable(),
  absoluteReturn: DecimalStringSchema.nullable(),
  benchmarkReturn: DecimalStringSchema.nullable(),
  benchmarkAdjustedReturn: DecimalStringSchema.nullable(),
  maxAdverseExcursion: DecimalStringSchema.nullable(),
  maxFavorableExcursion: DecimalStringSchema.nullable(),
  realizedVolatility: DecimalStringSchema.nullable(),
  maxDrawdown: DecimalStringSchema.nullable(),
});
export type EventStudyWindow = z.infer<typeof EventStudyWindowSchema>;
export const EventStudyResultSchema = z.strictObject({
  schemaVersion: z.literal('event-study-result.v1'),
  execution: z.literal('DISABLED'),
  interpretation: z.literal('DESCRIPTIVE_ASSOCIATION_NOT_CAUSAL_OR_EXECUTABLE'),
  inputHash: HashSchema,
  configHash: HashSchema,
  request: EventStudyRequestSchema,
  events: z
    .array(
      z.strictObject({
        event: NewsTemporalEventSchema,
        decisionAt: UtcTimestampSchema,
        responses: z
          .array(
            z.strictObject({
              series: EventStudySeriesSchema,
              windows: z.array(EventStudyWindowSchema).length(10),
            }),
          )
          .min(1)
          .max(10),
        benchmarkWindows: z.array(EventStudyWindowSchema).length(10),
      }),
    )
    .min(1)
    .max(20),
});
export type EventStudyResult = z.infer<typeof EventStudyResultSchema>;
export const EventStudyArtifactSchema = z.strictObject({
  schemaVersion: z.literal('event-study-artifact.v1'),
  algorithmVersion: z.literal('exact-close-event-study.v1'),
  clockSemantics: z.literal('utc-nanoseconds.v1'),
  randomSeed: z.literal(0),
  codeVersion: z.string().min(1).max(200),
  input: EventStudyInputSchema,
  result: EventStudyResultSchema,
});
export interface EventStudy {
  run(request: unknown): EventStudyResult;
}
