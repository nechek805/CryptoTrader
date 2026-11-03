import { z } from 'zod';
import { MarketDatasetSchema, UniverseResultSchema } from './market-data.js';
import { TechnicalFeatureDatasetSchema } from './technical-features.js';
import { EventStudySeriesSchema } from './event-study.js';
import {
  AvailabilityShape,
  DecimalStringSchema,
  NonNegativeDecimalSchema,
  UnitDecimalSchema,
  HashSchema,
  IdSchema,
  ProvenanceSchema,
  UtcTimestampSchema,
  utcNanoseconds,
  validateTemporal,
  compareDecimal,
} from './primitives.js';

export const DerivativeFeatureObservationSchema = z
  .strictObject({
    schemaVersion: z.literal('derivative-feature-observation.v1'),
    id: IdSchema,
    sourceId: IdSchema,
    instrumentKey: IdSchema,
    metric: z.enum(['FUNDING_RATE', 'OPEN_INTEREST']),
    value: DecimalStringSchema,
    measurementAt: UtcTimestampSchema,
    publishedAt: UtcTimestampSchema,
    observedAt: UtcTimestampSchema,
    ...AvailabilityShape,
    provenance: ProvenanceSchema,
  })
  .superRefine((v, ctx) => {
    validateTemporal(v, ctx);
    if (
      v.measurementAt > v.publishedAt ||
      v.publishedAt > v.observedAt ||
      (v.availableAt !== null && v.observedAt > v.availableAt)
    )
      ctx.addIssue({ code: 'custom', message: 'Derivative publication/receipt order invalid' });
    if (
      v.metric === 'OPEN_INTEREST' &&
      DecimalStringSchema.safeParse(v.value).success &&
      compareDecimal(v.value, DecimalStringSchema.parse('0')) < 0
    )
      ctx.addIssue({ code: 'custom', message: 'Open interest cannot be negative' });
  });
export type DerivativeFeatureObservation = z.infer<typeof DerivativeFeatureObservationSchema>;
export const CrossFeatureDatasetSchema = z.strictObject({
  schemaVersion: z.literal('cross-feature-dataset.v1'),
  technical: TechnicalFeatureDatasetSchema,
  market: MarketDatasetSchema,
  bindings: z
    .array(
      z.strictObject({
        sourceId: IdSchema,
        instrumentKey: IdSchema,
        series: EventStudySeriesSchema,
      }),
    )
    .max(100),
  derivatives: z.array(DerivativeFeatureObservationSchema).max(10000).default([]),
});
export type CrossFeatureDataset = z.infer<typeof CrossFeatureDatasetSchema>;
export const CrossFeatureRequestSchema = z
  .strictObject({
    schemaVersion: z.literal('cross-feature-request.v1'),
    sourceId: IdSchema,
    quoteAssetId: IdSchema,
    marketType: z.enum(['SPOT', 'PERPETUAL']),
    targets: z.array(IdSchema).min(1).max(10),
    btcInstrumentKey: IdSchema,
    intervalSeconds: z.number().int().min(1).max(86400),
    historyStartCloseAt: UtcTimestampSchema,
    featureAsOf: z.array(UtcTimestampSchema).min(1).max(64),
    generatedAt: UtcTimestampSchema,
    lookbackBars: z.number().int().min(3).max(100),
    returnHorizonBars: z.number().int().min(1).max(100),
    minimumPairs: z.number().int().min(3).max(100),
    lagBars: z.array(z.number().int().min(-10).max(10)).min(1).max(11),
    joinToleranceMs: z.number().int().min(0).max(30000),
    universe: z.strictObject({
      lookbackBars: z.number().int().min(1).max(100),
      count: z.number().int().min(1).max(20),
      minQuoteVolume: NonNegativeDecimalSchema,
      minLiquidityQuote: NonNegativeDecimalSchema,
      minCoverageFraction: UnitDecimalSchema,
      maxWindowAgeMs: z.number().int().min(0).max(86400000),
      maxObservationAgeMs: z.number().int().min(0).max(86400000),
      maxAbsDriftMs: z.number().int().min(0).max(600000),
    }),
    regime: z.strictObject({
      trendEfficiencyThreshold: UnitDecimalSchema,
      highVolatilityThreshold: NonNegativeDecimalSchema,
    }),
    derivativeMaxAgeSeconds: z.number().int().min(0).max(604800),
  })
  .superRefine((v, ctx) => {
    if (
      new Set(v.targets).size !== v.targets.length ||
      new Set(v.featureAsOf).size !== v.featureAsOf.length ||
      new Set(v.lagBars).size !== v.lagBars.length
    )
      ctx.addIssue({ code: 'custom', message: 'Duplicate targets, lags or cutoffs' });
    if (
      v.returnHorizonBars > v.lookbackBars ||
      v.minimumPairs > v.lookbackBars ||
      v.joinToleranceMs >= v.intervalSeconds * 1000
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid horizon, pair count or tolerance' });
    if (!Number.isSafeInteger(v.intervalSeconds) || v.intervalSeconds < 1) return;
    for (const at of v.featureAsOf) {
      if (
        !UtcTimestampSchema.safeParse(at).success ||
        !UtcTimestampSchema.safeParse(v.historyStartCloseAt).success
      )
        continue;
      const span = utcNanoseconds(at) - utcNanoseconds(v.historyStartCloseAt);
      if (
        span < 0n ||
        span / (BigInt(v.intervalSeconds) * 1000000000n) > 9999n ||
        v.generatedAt < at
      )
        ctx.addIssue({ code: 'custom', message: 'Invalid cross-feature timing' });
      if (
        utcNanoseconds(at) <
        BigInt(Math.max(v.lookbackBars, v.universe.lookbackBars) * v.intervalSeconds) * 1000000000n
      )
        ctx.addIssue({ code: 'custom', message: 'Lookback predates supported epoch' });
    }
    if (
      v.featureAsOf.length *
        (v.targets.length + v.universe.count + 1) *
        (v.lookbackBars + 1) *
        (v.lagBars.length + 1) >
      250000
    )
      ctx.addIssue({ code: 'custom', message: 'Cross-feature work budget exceeded' });
  });
export type CrossFeatureRequest = z.infer<typeof CrossFeatureRequestSchema>;
const nullableDecimal = DecimalStringSchema.nullable();
const SlotSchema = z
  .strictObject({
    nominalCloseAt: UtcTimestampSchema,
    barId: IdSchema.nullable(),
    actualCloseAt: UtcTimestampSchema.nullable(),
    availableAt: UtcTimestampSchema.nullable(),
    metadataId: IdSchema.nullable(),
    status: z.enum([
      'JOINED',
      'WARMUP',
      'NO_BINDING',
      'NO_KNOWN_LISTING',
      'NOT_LISTED',
      'DELISTED',
      'METADATA_MISMATCH',
      'MISSING',
      'NOT_AVAILABLE',
      'SOURCE_QUALITY',
      'AMBIGUOUS_SLOT',
      'PRECISION',
    ]),
  })
  .superRefine((v, ctx) => {
    const complete = [v.barId, v.actualCloseAt, v.availableAt, v.metadataId].every(
      (x) => x !== null,
    );
    if (
      (v.status === 'JOINED') !== complete ||
      (v.status !== 'JOINED' &&
        [v.barId, v.actualCloseAt, v.availableAt, v.metadataId].some((x) => x !== null))
    )
      ctx.addIssue({ code: 'custom', message: 'Joined slot audit fields disagree' });
  });
const OptionalDerivativeSchema = z
  .strictObject({
    status: z.enum(['AVAILABLE', 'UNAVAILABLE', 'NOT_APPLICABLE', 'STALE']),
    value: nullableDecimal,
    id: IdSchema.nullable(),
    measurementAt: UtcTimestampSchema.nullable(),
    publishedAt: UtcTimestampSchema.nullable(),
    availableAt: UtcTimestampSchema.nullable(),
  })
  .superRefine((v, ctx) => {
    if (
      (v.status === 'AVAILABLE') !== (v.value !== null) ||
      ((v.status === 'AVAILABLE' || v.status === 'STALE') &&
        (v.id === null ||
          v.measurementAt === null ||
          v.publishedAt === null ||
          v.availableAt === null)) ||
      (v.measurementAt !== null && v.publishedAt !== null && v.measurementAt > v.publishedAt) ||
      (v.publishedAt !== null && v.availableAt !== null && v.publishedAt > v.availableAt)
    )
      ctx.addIssue({ code: 'custom', message: 'Derivative value or timing fields disagree' });
  });
const CorrelationSchema = z
  .strictObject({
    lagBars: z.number().int(),
    direction: z.enum(['BTC_LEADS_ASSET', 'ASSET_LEADS_BTC', 'CONTEMPORANEOUS_GRID']),
    status: z.enum(['COMPUTED', 'INSUFFICIENT_PAIRS', 'ZERO_VARIANCE']),
    value: nullableDecimal,
    expectedPairs: z.number().int().nonnegative(),
    completeCoverage: z.boolean(),
    pairs: z
      .array(
        z.strictObject({
          btcNominalAt: UtcTimestampSchema,
          assetNominalAt: UtcTimestampSchema,
          btcActualAt: UtcTimestampSchema,
          assetActualAt: UtcTimestampSchema,
          knownAt: UtcTimestampSchema,
          barIds: z.array(IdSchema).length(4),
        }),
      )
      .max(100),
  })
  .superRefine((v, ctx) => {
    if (
      (v.status === 'COMPUTED') !== (v.value !== null) ||
      (v.status === 'COMPUTED' && v.pairs.length < 3) ||
      v.pairs.length > v.expectedPairs ||
      v.completeCoverage !== (v.pairs.length === v.expectedPairs)
    )
      ctx.addIssue({ code: 'custom', message: 'Correlation value/pair coverage disagree' });
  });
export type CrossCorrelation = z.infer<typeof CorrelationSchema>;
export const CrossAssetFeatureSchema = z.strictObject({
  instrumentKey: IdSchema,
  series: EventStudySeriesSchema.nullable(),
  metadataId: IdSchema.nullable(),
  status: z.enum([
    'AVAILABLE',
    'NO_BINDING',
    'NO_KNOWN_LISTING',
    'NOT_LISTED',
    'DELISTED',
    'METADATA_MISMATCH',
  ]),
  inLiquidUniverse: z.boolean(),
  slots: z.array(SlotSchema).max(101),
  grossReturn: nullableDecimal,
  btcReturn: nullableDecimal,
  relativeToBtc: nullableDecimal,
  correlations: z.array(CorrelationSchema).max(12),
  regime: z.strictObject({
    status: z.enum(['READY', 'WARMUP_OR_GAP']),
    trend: z.enum(['TRENDING', 'RANGING', 'UNKNOWN']),
    direction: z.enum(['UP', 'DOWN', 'FLAT', 'UNKNOWN']),
    highVolatility: z.boolean().nullable(),
    efficiency: nullableDecimal,
    volatility: nullableDecimal,
  }),
  derivatives: z.strictObject({
    fundingRate: OptionalDerivativeSchema,
    openInterest: OptionalDerivativeSchema,
  }),
});
export type CrossAssetFeature = z.infer<typeof CrossAssetFeatureSchema>;
export const CrossFeatureRowSchema = z
  .strictObject({
    schemaVersion: z.literal('cross-feature-row.v1'),
    featureAsOf: UtcTimestampSchema,
    anchorCloseAt: UtcTimestampSchema,
    universe: UniverseResultSchema,
    universePolicy: z.literal('POINT_IN_TIME_BOOK_REQUIRED_EMPTY_OR_PARTIAL_NO_STATIC_REPLACEMENT'),
    btc: CrossAssetFeatureSchema,
    assets: z.array(CrossAssetFeatureSchema).max(10),
    members: z.array(CrossAssetFeatureSchema).max(20),
    breadth: z.strictObject({
      selectedCount: z.number().int().nonnegative(),
      measuredCount: z.number().int().nonnegative(),
      advancing: z.number().int().nonnegative(),
      declining: z.number().int().nonnegative(),
      unchanged: z.number().int().nonnegative(),
      advancingFraction: nullableDecimal,
      decliningFraction: nullableDecimal,
      coverageFraction: nullableDecimal,
    }),
    concentration: z.strictObject({
      interpretation: z.literal('SELECTED_EXCHANGE_TURNOVER_NOT_MARKET_CAP_OR_RISK'),
      largestShare: nullableDecimal,
      herfindahl: nullableDecimal,
      shares: z.array(z.strictObject({ instrumentKey: IdSchema, share: DecimalStringSchema })),
    }),
    inputBarIds: z.array(IdSchema),
    inputMetadataIds: z.array(IdSchema),
    inputMarketObservationIds: z.array(IdSchema),
    inputDerivativeIds: z.array(IdSchema),
    sourceIds: z.array(IdSchema),
    parentIds: z.array(IdSchema),
    maxInputAvailableAt: UtcTimestampSchema.nullable(),
    maxInputEventAt: UtcTimestampSchema.nullable(),
  })
  .superRefine((v, ctx) => {
    const issue = () =>
      ctx.addIssue({
        code: 'custom',
        message: 'Cross-feature input exceeds shared cutoff or join direction',
      });
    if (
      v.anchorCloseAt > v.featureAsOf ||
      (v.maxInputAvailableAt !== null && v.maxInputAvailableAt > v.featureAsOf) ||
      (v.maxInputEventAt !== null && v.maxInputEventAt > v.featureAsOf)
    )
      issue();
    for (const a of [v.btc, ...v.assets, ...v.members]) {
      for (const s of a.slots)
        if (
          (s.actualCloseAt !== null && s.actualCloseAt > s.nominalCloseAt) ||
          (s.availableAt !== null && s.availableAt > v.featureAsOf)
        )
          issue();
      for (const c of a.correlations)
        for (const p of c.pairs)
          if (
            p.knownAt > v.featureAsOf ||
            (c.lagBars > 0 && p.btcActualAt >= p.assetActualAt) ||
            (c.lagBars < 0 && p.assetActualAt >= p.btcActualAt)
          )
            issue();
      for (const d of [a.derivatives.fundingRate, a.derivatives.openInterest])
        if (d.availableAt !== null && d.availableAt > v.featureAsOf) issue();
    }
  });
export const CrossFeatureArtifactSchema = z.strictObject({
  schemaVersion: z.literal('cross-feature-artifact.v1'),
  algorithmVersion: z.literal('cross-features.v1'),
  execution: z.literal('DISABLED'),
  clockSemantics: z.literal('utc-nanoseconds.v1'),
  randomSeed: z.literal(0),
  codeVersion: z.string().min(1).max(200),
  input: CrossFeatureDatasetSchema,
  inputHash: HashSchema,
  request: CrossFeatureRequestSchema,
  configHash: HashSchema,
  catalog: z.array(
    z.strictObject({
      featureId: IdSchema,
      formula: z.string().min(1),
      availabilityPolicy: z.string().min(1),
      missingPolicy: z.string().min(1),
    }),
  ),
  rows: z.array(CrossFeatureRowSchema).max(64),
});
