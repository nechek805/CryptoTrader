import { z } from 'zod';
import {
  AvailabilityShape,
  CurrencySchema,
  DecimalStringSchema,
  HashSchema,
  IdSchema,
  NonNegativeDecimalSchema,
  PositiveDecimalSchema,
  UnitDecimalSchema,
  UtcTimestampSchema,
  utcNanoseconds,
  validateTemporal,
} from './primitives.js';

const marketType = z.enum(['SPOT', 'PERPETUAL']);
const temporal = { observedAt: UtcTimestampSchema, ...AvailabilityShape };
const derivativeStatus = z.enum(['AVAILABLE', 'UNAVAILABLE', 'NOT_APPLICABLE']);
export const InstrumentRevisionSchema = z
  .strictObject({
    schemaVersion: z.literal('instrument-revision.v1'),
    id: IdSchema,
    instrumentKey: IdSchema,
    revision: z.number().int().positive(),
    sourceId: IdSchema,
    venue: IdSchema,
    baseAssetId: IdSchema,
    quoteAssetId: IdSchema,
    baseCode: CurrencySchema,
    quoteCode: CurrencySchema,
    assetName: z.string().min(1).max(100),
    marketType,
    providerSymbol: z.string().regex(/^[A-Za-z0-9._:/-]{1,100}$/),
    effectiveFrom: UtcTimestampSchema,
    listedAt: UtcTimestampSchema,
    delistedAt: UtcTimestampSchema.nullable(),
    tickSize: PositiveDecimalSchema,
    quantityStep: PositiveDecimalSchema,
    derivatives: z.strictObject({
      fundingRate: derivativeStatus,
      openInterest: derivativeStatus,
      markPrice: derivativeStatus,
    }),
    ...temporal,
  })
  .superRefine((v, ctx) => {
    validateTemporal(v, ctx);
    if (v.availableAt !== null && v.availableAt < v.observedAt)
      ctx.addIssue({ code: 'custom', message: 'Availability precedes observation' });
    if (v.delistedAt !== null && v.delistedAt <= v.listedAt)
      ctx.addIssue({ code: 'custom', message: 'Invalid listing lifetime' });
    if (
      Object.values(v.derivatives).some((s) =>
        v.marketType === 'SPOT' ? s !== 'NOT_APPLICABLE' : s === 'NOT_APPLICABLE',
      )
    )
      ctx.addIssue({ code: 'custom', message: 'Derivative status must match market type' });
  });
export type InstrumentRevision = z.infer<typeof InstrumentRevisionSchema>;
const metric = (value: typeof DecimalStringSchema | typeof NonNegativeDecimalSchema) =>
  z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('KNOWN'), value }),
    z.strictObject({
      status: z.enum(['UNAVAILABLE', 'NOT_APPLICABLE']),
      reason: z.string().min(1).max(200),
    }),
  ]);
export const MarketObservationSchema = z
  .strictObject({
    schemaVersion: z.literal('market-observation.v1'),
    id: IdSchema,
    instrumentKey: IdSchema,
    sourceId: IdSchema,
    providerSymbol: z.string().regex(/^[A-Za-z0-9._:/-]{1,100}$/),
    revision: z.number().int().positive(),
    quality: z.enum(['CANDLE_ONLY', 'ORDER_BOOK']),
    evidence: z.strictObject({ id: IdSchema, contentHash: HashSchema }),
    windowStart: UtcTimestampSchema,
    windowEnd: UtcTimestampSchema,
    intervalSeconds: z.number().int().min(1).max(86400),
    providerAt: UtcTimestampSchema,
    price: PositiveDecimalSchema,
    quoteVolume: NonNegativeDecimalSchema.nullable(),
    liquidityQuote: NonNegativeDecimalSchema.nullable(),
    derivatives: z.strictObject({
      fundingRate: metric(DecimalStringSchema),
      openInterest: metric(NonNegativeDecimalSchema),
      markPrice: metric(PositiveDecimalSchema),
    }),
    ...temporal,
  })
  .superRefine((v, ctx) => {
    validateTemporal(v, ctx);
    if (v.quality === 'CANDLE_ONLY' && v.liquidityQuote !== null)
      ctx.addIssue({ code: 'custom', message: 'Candle-only data cannot establish book liquidity' });
    if ((v.availableAt !== null && v.availableAt < v.observedAt) || v.observedAt < v.windowEnd)
      ctx.addIssue({
        code: 'custom',
        message: 'Observation/availability precedes completed window',
      });
    if (
      UtcTimestampSchema.safeParse(v.windowEnd).success &&
      UtcTimestampSchema.safeParse(v.windowStart).success &&
      utcNanoseconds(v.windowEnd) - utcNanoseconds(v.windowStart) !==
        BigInt(v.intervalSeconds) * 1000000000n
    )
      ctx.addIssue({ code: 'custom', message: 'Observation window duration mismatch' });
  });
export type MarketObservation = z.infer<typeof MarketObservationSchema>;
export const MarketDatasetSchema = z.strictObject({
  schemaVersion: z.literal('market-dataset.v1'),
  sources: z
    .array(
      z.strictObject({
        id: IdSchema,
        venue: IdSchema,
        origin: z.enum(['SYNTHETIC', 'PUBLIC_READ_ONLY']),
        version: z.string().min(1).max(100),
        reference: z.string().min(1).max(2000),
        termsReference: z.string().min(1).max(2000),
        license: z.enum(['SYNTHETIC', 'UNDETERMINED']),
        liquidityDefinition: z.literal('MIN_BID_ASK_NOTIONAL_WITHIN_100BPS'),
      }),
    )
    .min(1)
    .max(20),
  instruments: z.array(InstrumentRevisionSchema).max(1000),
  observations: z.array(MarketObservationSchema).max(10000),
});
export type MarketDataset = z.infer<typeof MarketDatasetSchema>;
const window = {
  decisionAt: UtcTimestampSchema,
  from: UtcTimestampSchema,
  to: UtcTimestampSchema,
  intervalSeconds: z.number().int().min(1).max(86400),
};
function validWindow(
  v: { from: string; to: string; decisionAt: string; intervalSeconds: number },
  ctx: z.RefinementCtx,
) {
  if (v.from >= v.to || v.to > v.decisionAt)
    ctx.addIssue({ code: 'custom', message: 'Require from < to <= decisionAt' });
  if (UtcTimestampSchema.safeParse(v.from).success && UtcTimestampSchema.safeParse(v.to).success) {
    const duration =
      utcNanoseconds(UtcTimestampSchema.parse(v.to)) -
      utcNanoseconds(UtcTimestampSchema.parse(v.from));
    if (!Number.isSafeInteger(v.intervalSeconds) || v.intervalSeconds < 1) return;
    const interval = BigInt(v.intervalSeconds) * 1000000000n;
    if (duration <= 0n || duration % interval !== 0n || duration / interval > 2000n)
      ctx.addIssue({ code: 'custom', message: 'Require a whole grid of at most 2000 slots' });
  }
}
export const MarketDataQuerySchema = z
  .strictObject({
    schemaVersion: z.literal('market-data-query.v1'),
    sourceId: IdSchema,
    instrumentKey: IdSchema,
    mode: z.enum(['ELIGIBLE', 'DESCRIPTIVE_ONLY']),
    ...window,
  })
  .superRefine(validWindow);
export type MarketDataQuery = z.infer<typeof MarketDataQuerySchema>;
export const MarketHistoryQuerySchema = z.strictObject({
  schemaVersion: z.literal('market-history-query.v1'),
  sourceId: IdSchema,
  instrumentKey: IdSchema,
  decisionAt: UtcTimestampSchema,
});
export const MarketResolveQuerySchema = z
  .strictObject({
    schemaVersion: z.literal('market-resolve-query.v1'),
    sourceId: IdSchema,
    providerSymbol: z.string().min(1).max(100),
    marketType,
    marketAt: UtcTimestampSchema,
    decisionAt: UtcTimestampSchema,
  })
  .refine((v) => v.marketAt <= v.decisionAt);
export const UniverseRequestSchema = z
  .strictObject({
    schemaVersion: z.literal('market-universe-query.v1'),
    sourceId: IdSchema,
    quoteAssetId: IdSchema,
    marketType,
    ...window,
    count: z.number().int().min(1).max(100),
    minQuoteVolume: NonNegativeDecimalSchema,
    minLiquidityQuote: NonNegativeDecimalSchema,
    minCoverageFraction: UnitDecimalSchema,
    maxWindowAgeMs: z.number().int().min(0).max(86400000),
    maxObservationAgeMs: z.number().int().min(0).max(86400000),
    maxAbsDriftMs: z.number().int().min(0).max(600000),
  })
  .superRefine(validWindow);
export const MarketQualityQuerySchema = z
  .strictObject({
    ...MarketDataQuerySchema.shape,
    schemaVersion: z.literal('market-quality-query.v1'),
    spikeThresholdBps: PositiveDecimalSchema,
    maxAbsDriftMs: z.number().int().min(0).max(600000),
  })
  .superRefine(validWindow);
export const CrossVenueQuerySchema = z
  .strictObject({
    schemaVersion: z.literal('market-cross-venue-query.v1'),
    ...window,
    left: z.strictObject({ sourceId: IdSchema, instrumentKey: IdSchema }),
    right: z.strictObject({ sourceId: IdSchema, instrumentKey: IdSchema }),
    toleranceMs: z.number().int().min(0).max(60000),
    divergenceThresholdBps: NonNegativeDecimalSchema,
  })
  .superRefine(validWindow);
export const MarketQueryResultSchema = z.strictObject({
  schemaVersion: z.literal('market-data-result.v1'),
  datasetHash: HashSchema,
  request: MarketDataQuerySchema,
  rows: z.array(MarketObservationSchema).max(2000),
  excluded: z
    .array(
      z.strictObject({
        id: IdSchema,
        reason: z.enum([
          'NO_METADATA',
          'OUTSIDE_LISTING',
          'PRECISION',
          'DERIVATIVE_STATUS',
          'AMBIGUOUS_MAPPING',
          'METADATA_CHANGE',
          'GRID_ALIGNMENT',
          'MAPPING',
        ]),
      }),
    )
    .max(10000),
});
export const MarketHistoryResultSchema = z.strictObject({
  schemaVersion: z.literal('market-history-result.v1'),
  datasetHash: HashSchema,
  revisions: z.array(InstrumentRevisionSchema).max(1000),
});
export const MarketResolveResultSchema = z.strictObject({
  schemaVersion: z.literal('market-resolve-result.v1'),
  datasetHash: HashSchema,
  instrument: InstrumentRevisionSchema.nullable(),
});
export const UniverseResultSchema = z.strictObject({
  schemaVersion: z.literal('market-universe-result.v1'),
  datasetHash: HashSchema,
  request: UniverseRequestSchema,
  rankingRule: z.literal('QUOTE_VOLUME_DESC_LIQUIDITY_DESC_KEY_ASC.v1'),
  selected: z.array(
    z.strictObject({
      instrument: InstrumentRevisionSchema,
      quoteVolume: NonNegativeDecimalSchema,
      minLiquidityQuote: NonNegativeDecimalSchema,
      coverageFraction: UnitDecimalSchema,
      observationIds: z.array(IdSchema),
      metadataIds: z.array(IdSchema),
    }),
  ),
  excluded: z.array(
    z.strictObject({
      instrumentKey: IdSchema,
      reason: z.enum([
        'NO_METADATA',
        'NOT_LISTED',
        'DELISTED',
        'COVERAGE',
        'MISSING_METRICS',
        'VOLUME',
        'LIQUIDITY',
        'STALE_WINDOW',
        'STALE_OBSERVATION',
        'DRIFT',
        'AMBIGUOUS_MAPPING',
        'RANK',
      ]),
    }),
  ),
});
export const MarketQualityResultSchema = z.strictObject({
  schemaVersion: z.literal('market-quality-result.v1'),
  datasetHash: HashSchema,
  request: MarketQualityQuerySchema,
  expectedSlots: z.number().int().nonnegative(),
  ineligibleSlots: z.number().int().nonnegative(),
  acceptedSlots: z.number().int().nonnegative(),
  missingSlots: z.number().int().nonnegative(),
  missingFraction: UnitDecimalSchema.nullable(),
  missingEnds: z.array(UtcTimestampSchema),
  excluded: MarketQueryResultSchema.shape.excluded,
  spikes: z.array(
    z.strictObject({ previousId: IdSchema, id: IdSchema, changeBps: NonNegativeDecimalSchema }),
  ),
  maxAbsReceiptDriftMs: NonNegativeDecimalSchema.nullable(),
  driftViolationIds: z.array(IdSchema),
  unavailableMetrics: z.strictObject({
    quoteVolume: z.number().int().nonnegative(),
    liquidityQuote: z.number().int().nonnegative(),
    fundingRate: z.number().int().nonnegative(),
    openInterest: z.number().int().nonnegative(),
    markPrice: z.number().int().nonnegative(),
  }),
});
export const CrossVenueResultSchema = z.strictObject({
  schemaVersion: z.literal('market-cross-venue-result.v1'),
  datasetHash: HashSchema,
  request: CrossVenueQuerySchema,
  policy: z.literal('BACKWARD_ASOF_PROVIDER_TIME_ONE_TO_ONE.v1'),
  matches: z.array(
    z.strictObject({
      leftId: IdSchema,
      rightId: IdSchema,
      leftMetadataId: IdSchema,
      rightMetadataId: IdSchema,
      availableAt: UtcTimestampSchema,
      lagMs: NonNegativeDecimalSchema,
      divergenceBps: NonNegativeDecimalSchema,
      divergent: z.boolean(),
    }),
  ),
  unmatchedLeftIds: z.array(IdSchema),
  unmatchedRightIds: z.array(IdSchema),
});
export const MarketQualityReportRequestSchema = z
  .strictObject({
    schemaVersion: z.literal('market-quality-report-request.v1'),
    universe: UniverseRequestSchema,
    quality: z.array(MarketQualityQuerySchema).min(1).max(20),
    comparisons: z.array(CrossVenueQuerySchema).max(10),
    history: z.array(MarketHistoryQuerySchema).max(20),
  })
  .superRefine((v, ctx) => {
    if (
      [...v.quality, ...v.comparisons, ...v.history].some(
        (q) => q.decisionAt !== v.universe.decisionAt,
      ) ||
      [...v.quality, ...v.comparisons].some(
        (q) =>
          q.from !== v.universe.from ||
          q.to !== v.universe.to ||
          q.intervalSeconds !== v.universe.intervalSeconds,
      )
    )
      ctx.addIssue({ code: 'custom', message: 'Report queries must share cutoff and grid' });
  });
export const MarketQualityArtifactSchema = z.strictObject({
  schemaVersion: z.literal('market-quality-artifact.v1'),
  algorithmVersion: z.literal('market-data.v1'),
  codeVersion: z.string().min(1).max(200),
  clockSemantics: z.literal('utc-nanoseconds.v1'),
  execution: z.literal('DISABLED'),
  dataset: MarketDatasetSchema,
  datasetHash: HashSchema,
  request: MarketQualityReportRequestSchema,
  configHash: HashSchema,
  report: z.strictObject({
    universe: UniverseResultSchema,
    quality: z.array(MarketQualityResultSchema).max(20),
    comparisons: z.array(CrossVenueResultSchema).max(10),
    history: z.array(MarketHistoryResultSchema).max(20),
  }),
});
/** Versioned, read-only handoff for Modules 06/07/08; every method validates unknown input. */
export interface MarketData {
  readonly schemaVersion: 'market-data.v1';
  readonly datasetHash: string;
  query(input: unknown): z.infer<typeof MarketQueryResultSchema>;
  history(input: unknown): z.infer<typeof MarketHistoryResultSchema>;
  resolve(input: unknown): z.infer<typeof MarketResolveResultSchema>;
  universe(input: unknown): z.infer<typeof UniverseResultSchema>;
  quality(input: unknown): z.infer<typeof MarketQualityResultSchema>;
  compare(input: unknown): z.infer<typeof CrossVenueResultSchema>;
}
