import { z } from 'zod';
import { MarketBarSchema } from './domain.js';
import { MarketSnapshotManifestSchema } from './market-import.js';
import { EventStudySeriesSchema } from './event-study.js';
import {
  DecimalStringSchema,
  HashSchema,
  IdSchema,
  NonNegativeDecimalSchema,
  UnitDecimalSchema,
  UtcTimestampSchema,
  utcNanoseconds,
} from './primitives.js';

const period = z.number().int().min(1).max(500);
export const TechnicalFeatureConfigSchema = z.strictObject({
  schemaVersion: z.literal('technical-feature-config.v1'),
  smaPeriod: period,
  emaPeriod: period,
  volatilityPeriod: period,
  atrPeriod: period,
  relativeVolumePeriod: period,
  zScorePeriod: period,
  breakoutPeriod: period,
  returnHorizonsBars: z
    .array(z.number().int().min(1).max(1000))
    .min(1)
    .max(20)
    .refine((v) => new Set(v).size === v.length, 'Duplicate return horizon')
    .transform((v) => [...v].sort((a, b) => a - b)),
  minimumBaseVolume: NonNegativeDecimalSchema,
  lowRelativeVolumeThreshold: UnitDecimalSchema,
  candleGapThresholdBps: z.number().int().min(0).max(10000),
  staleAfterSeconds: z.number().int().min(1).max(86400),
});
export type TechnicalFeatureConfig = z.infer<typeof TechnicalFeatureConfigSchema>;
export const TechnicalFeatureDatasetSchema = z.strictObject({
  schemaVersion: z.literal('technical-feature-dataset.v1'),
  bars: z.array(MarketBarSchema).max(200000),
  marketSnapshots: z.array(MarketSnapshotManifestSchema).max(10).default([]),
});
export type TechnicalFeatureDataset = z.infer<typeof TechnicalFeatureDatasetSchema>;
const common = {
  series: EventStudySeriesSchema,
  intervalSeconds: z.number().int().min(1).max(86400),
  historyStartCloseAt: UtcTimestampSchema,
  config: TechnicalFeatureConfigSchema,
};
export const TechnicalFeatureQuerySchema = z
  .strictObject({
    schemaVersion: z.literal('technical-feature-query.v1'),
    ...common,
    featureAsOf: UtcTimestampSchema,
  })
  .superRefine((v, ctx) => {
    if (
      !UtcTimestampSchema.safeParse(v.historyStartCloseAt).success ||
      !UtcTimestampSchema.safeParse(v.featureAsOf).success ||
      !Number.isSafeInteger(v.intervalSeconds) ||
      v.intervalSeconds < 1
    )
      return;
    const span = utcNanoseconds(v.featureAsOf) - utcNanoseconds(v.historyStartCloseAt);
    if (span < 0n || span / (BigInt(v.intervalSeconds) * 1000000000n) > 9999n)
      ctx.addIssue({
        code: 'custom',
        message: 'Require history start <= as-of and at most 10000 close slots',
      });
  });
export type TechnicalFeatureQuery = z.infer<typeof TechnicalFeatureQuerySchema>;
export const TechnicalFeatureRequestSchema = z
  .strictObject({
    schemaVersion: z.literal('technical-feature-request.v1'),
    ...common,
    featureAsOf: z.array(UtcTimestampSchema).min(1).max(128),
    generatedAt: UtcTimestampSchema,
  })
  .superRefine((v, ctx) => {
    if (new Set(v.featureAsOf).size !== v.featureAsOf.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate feature timestamp' });
    let work = 0;
    for (const at of v.featureAsOf) {
      const query = TechnicalFeatureQuerySchema.safeParse({
        schemaVersion: 'technical-feature-query.v1',
        series: v.series,
        intervalSeconds: v.intervalSeconds,
        historyStartCloseAt: v.historyStartCloseAt,
        config: v.config,
        featureAsOf: at,
      });
      if (!query.success) {
        ctx.addIssue({ code: 'custom', message: 'Invalid feature history window' });
        continue;
      }
      if (v.generatedAt < at)
        ctx.addIssue({ code: 'custom', message: 'Generation precedes feature as-of' });
      if (
        UtcTimestampSchema.safeParse(at).success &&
        UtcTimestampSchema.safeParse(v.historyStartCloseAt).success &&
        Number.isSafeInteger(v.intervalSeconds) &&
        v.intervalSeconds > 0
      )
        work +=
          Number(
            (utcNanoseconds(at) - utcNanoseconds(v.historyStartCloseAt)) /
              (BigInt(v.intervalSeconds) * 1000000000n),
          ) + 1;
    }
    if (work > 250000)
      ctx.addIssue({ code: 'custom', message: 'Feature batch work budget exceeded' });
  });
export type TechnicalFeatureRequest = z.infer<typeof TechnicalFeatureRequestSchema>;
export const TechnicalFeatureValueSchema = z
  .strictObject({
    featureId: IdSchema,
    status: z.enum([
      'READY',
      'WARMUP',
      'GAP',
      'MISSING_CURRENT_BAR',
      'ZERO_DENOMINATOR',
      'ZERO_VARIANCE',
    ]),
    value: DecimalStringSchema.nullable(),
    requiredBars: z.number().int().positive(),
    observedBars: z.number().int().nonnegative(),
    inputBarIds: z.array(IdSchema).max(10000),
    maxInputAvailableAt: UtcTimestampSchema.nullable(),
    maxInputCloseAt: UtcTimestampSchema.nullable(),
  })
  .superRefine((v, ctx) => {
    if (
      (v.status === 'READY') !== (v.value !== null) ||
      v.observedBars !== v.inputBarIds.length ||
      new Set(v.inputBarIds).size !== v.inputBarIds.length ||
      (v.inputBarIds.length > 0 &&
        (v.maxInputAvailableAt === null || v.maxInputCloseAt === null)) ||
      (v.status === 'READY' && v.observedBars < v.requiredBars)
    )
      ctx.addIssue({ code: 'custom', message: 'Feature value/coverage/audit fields disagree' });
  });
export type TechnicalFeatureValue = z.infer<typeof TechnicalFeatureValueSchema>;
export const TechnicalFeatureDefinitionSchema = z.strictObject({
  featureId: IdSchema,
  version: z.literal('technical-features.v1'),
  formula: z.string().min(1).max(1000),
  inputs: z.array(z.enum(['open', 'high', 'low', 'close', 'volume'])).min(1),
  warmupBars: z.number().int().positive(),
  historyPolicy: z.enum(['FIXED_WINDOW', 'CONSECUTIVE_SEGMENT_FROM_DECLARED_START']),
  availabilityLag: z.literal('VARIABLE_SOURCE_LAG_MAX_INPUT_AVAILABLE_AT_COMPUTE_LAG_UNMODELED'),
  nanPolicy: z.literal('NULL_WITH_REASON_NEVER_NAN_OR_INFINITY'),
  units: z.enum(['PRICE', 'FRACTION', 'DIMENSIONLESS']),
});
export const TechnicalFeatureRowSchema = z
  .strictObject({
    schemaVersion: z.literal('technical-feature-row.v1'),
    datasetHash: HashSchema,
    configHash: HashSchema,
    request: TechnicalFeatureQuerySchema,
    anchorCloseAt: UtcTimestampSchema,
    currentBarId: IdSchema.nullable(),
    features: z.array(TechnicalFeatureValueSchema).min(10).max(29),
    inputBarIds: z.array(IdSchema).max(10000),
    sourceIds: z.array(IdSchema),
    sourceVersions: z.array(z.string()),
    parentIds: z.array(IdSchema),
    maxInputAvailableAt: UtcTimestampSchema.nullable(),
    maxInputCloseAt: UtcTimestampSchema.nullable(),
    coverage: z.strictObject({
      expectedBars: z.number().int().positive(),
      availableBars: z.number().int().nonnegative(),
      missingCloseTimes: z.array(UtcTimestampSchema).max(10000),
      excluded: z
        .array(
          z.strictObject({
            barId: IdSchema,
            reason: z.enum([
              'NOT_AVAILABLE_AT_ASOF',
              'DESCRIPTIVE_ONLY',
              'SOURCE_QUALITY',
              'SUPERSEDED',
            ]),
          }),
        )
        .max(200000),
    }),
    liquidity: z.strictObject({
      status: z.literal('CANDLE_PROXY_ONLY_ORDER_BOOK_UNAVAILABLE'),
      flags: z.array(
        z.enum([
          'ORDER_BOOK_UNAVAILABLE',
          'MISSING_CURRENT_BAR',
          'MISSING_CANDLES',
          'STALE_PRICE',
          'ZERO_VOLUME',
          'LOW_BASE_VOLUME',
          'LOW_RELATIVE_VOLUME',
          'CANDLE_PRICE_GAP',
        ]),
      ),
      currentBaseVolume: NonNegativeDecimalSchema.nullable(),
      lastKnownCloseAt: UtcTimestampSchema.nullable(),
    }),
  })
  .superRefine((v, ctx) => {
    for (const feature of [v, ...v.features])
      if (
        (feature.maxInputAvailableAt !== null &&
          feature.maxInputAvailableAt > v.request.featureAsOf) ||
        (feature.maxInputCloseAt !== null && feature.maxInputCloseAt > v.request.featureAsOf)
      )
        ctx.addIssue({ code: 'custom', message: 'Feature input exceeds as-of cutoff' });
    if (v.anchorCloseAt > v.request.featureAsOf)
      ctx.addIssue({ code: 'custom', message: 'Feature anchor is unfinished' });
    if (
      new Set(v.features.map((f) => f.featureId)).size !== v.features.length ||
      new Set(v.inputBarIds).size !== v.inputBarIds.length ||
      (v.inputBarIds.length > 0 &&
        (v.maxInputAvailableAt === null || v.maxInputCloseAt === null)) ||
      v.features.some((f) => f.inputBarIds.some((id) => !v.inputBarIds.includes(id)))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Feature row provenance is incomplete or ambiguous',
      });
  });
export type TechnicalFeatureRow = z.infer<typeof TechnicalFeatureRowSchema>;
export const TechnicalFeatureArtifactSchema = z.strictObject({
  schemaVersion: z.literal('technical-feature-artifact.v1'),
  algorithmVersion: z.literal('technical-features.v1'),
  execution: z.literal('DISABLED'),
  clockSemantics: z.literal('utc-nanoseconds.v1'),
  randomSeed: z.literal(0),
  codeVersion: z.string().min(1).max(200),
  input: TechnicalFeatureDatasetSchema,
  inputHash: HashSchema,
  request: TechnicalFeatureRequestSchema,
  configHash: HashSchema,
  catalog: z.array(TechnicalFeatureDefinitionSchema),
  rows: z.array(TechnicalFeatureRowSchema).min(1).max(128),
});
