import { z } from 'zod';
import {
  EventStudyInputSchema,
  EventStudyRequestSchema,
  EventStudySeriesSchema,
} from './event-study.js';
import { MarketBarSchema } from './domain.js';
import { NewsEventTypeSchema } from './news-extraction.js';
import {
  DecimalStringSchema,
  NonNegativeDecimalSchema,
  HashSchema,
  IdSchema,
  SeedSchema,
  UtcTimestampSchema,
  utcNanoseconds,
} from './primitives.js';

export const EventStudyPricePathRequestSchema = z
  .strictObject({
    series: EventStudySeriesSchema,
    from: UtcTimestampSchema,
    to: UtcTimestampSchema,
    intervalSeconds: z.union([z.literal(60), z.literal(300), z.literal(900), z.literal(3600)]),
    analysisAsOf: UtcTimestampSchema,
  })
  .refine((v) => {
    if (
      !UtcTimestampSchema.safeParse(v.from).success ||
      !UtcTimestampSchema.safeParse(v.to).success
    )
      return false;
    const span = utcNanoseconds(v.to) - utcNanoseconds(v.from),
      step = BigInt(v.intervalSeconds) * 1000000000n;
    return span >= 0n && span % step === 0n && span / step <= 10080n;
  }, 'Path must contain at most 10080 exact intervals');
export const EventStudyPricePathSchema = z.strictObject({
  request: EventStudyPricePathRequestSchema,
  bars: z.array(MarketBarSchema).max(10081),
  missingCloseTimes: z.array(UtcTimestampSchema).max(10081),
  excludedBarIds: z.array(IdSchema).max(200000),
});
export type EventStudyPricePath = z.infer<typeof EventStudyPricePathSchema>;

export const EventControlsRequestSchema = z
  .strictObject({
    schemaVersion: z.literal('event-controls-request.v1'),
    study: EventStudyRequestSchema,
    horizonSeconds: z.union([
      z.literal(60),
      z.literal(300),
      z.literal(900),
      z.literal(3600),
      z.literal(14400),
      z.literal(86400),
      z.literal(259200),
      z.literal(604800),
    ]),
    fitLookbackBars: z.number().int().min(3).max(1000),
    factor: EventStudySeriesSchema.extend({ asset: z.literal('BTC') }),
    basket: z
      .array(
        z.strictObject({
          series: EventStudySeriesSchema,
          weightBps: z.number().int().min(1).max(10000),
        }),
      )
      .min(1)
      .max(10),
    lags: z.array(z.number().int().min(-20).max(20)).min(1).max(11),
    controls: z.strictObject({
      from: UtcTimestampSchema,
      to: UtcTimestampSchema,
      strideSeconds: z.number().int().min(60).max(604800),
      sampleCount: z.number().int().min(1).max(32),
      seed: SeedSchema,
      blackoutSeconds: z.number().int().min(0).max(604800),
      timeOfDayToleranceSeconds: z.number().int().min(0).max(43200).nullable(),
      volatilityTolerance: NonNegativeDecimalSchema.nullable(),
    }),
    taxonomyFilter: z.array(NewsEventTypeSchema).max(10),
  })
  .superRefine((v, ctx) => {
    if (v.basket.reduce((s, b) => s + b.weightBps, 0) !== 10000)
      ctx.addIssue({ code: 'custom', message: 'Basket weights must sum to 10000 bps' });
    const key = (s: z.infer<typeof EventStudySeriesSchema>) =>
      `${s.exchange}|${s.instrumentId}|${s.marketType}`;
    if (
      new Set(v.basket.map((b) => key(b.series))).size !== v.basket.length ||
      new Set(v.study.assets.map(key)).size !== v.study.assets.length ||
      new Set(v.lags).size !== v.lags.length ||
      new Set(v.taxonomyFilter).size !== v.taxonomyFilter.length
    )
      ctx.addIssue({ code: 'custom', message: 'Duplicate basket, lag or taxonomy selection' });
    if (
      v.horizonSeconds % v.study.intervalSeconds !== 0 ||
      v.controls.strideSeconds % v.study.intervalSeconds !== 0
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Horizon and control stride must align to the study interval',
      });
    if (
      UtcTimestampSchema.safeParse(v.controls.from).success &&
      UtcTimestampSchema.safeParse(v.controls.to).success
    ) {
      if (!Number.isSafeInteger(v.controls.strideSeconds) || v.controls.strideSeconds <= 0) return;
      const span = utcNanoseconds(v.controls.to) - utcNanoseconds(v.controls.from),
        stride = BigInt(v.controls.strideSeconds) * 1000000000n;
      if (span < 0n || span % stride !== 0n || span / stride > 255n)
        ctx.addIssue({
          code: 'custom',
          message: 'Control grid must contain 1–256 exact timestamps',
        });
    }
  });
export type EventControlsRequest = z.infer<typeof EventControlsRequestSchema>;
const nullableDecimal = DecimalStringSchema.nullable();
const FitSchema = z.strictObject({
  status: z.enum(['FITTED', 'INCOMPLETE', 'ZERO_FACTOR_VARIANCE']),
  from: UtcTimestampSchema,
  to: UtcTimestampSchema,
  pairs: z.number().int().nonnegative(),
  alpha: nullableDecimal,
  beta: nullableDecimal,
  assetBarIds: z.array(IdSchema),
  factorBarIds: z.array(IdSchema),
});
const RecoverySchema = z.strictObject({
  status: z.enum([
    'RECOVERED',
    'RIGHT_CENSORED',
    'NO_DRAWDOWN',
    'MISSING_ENTRY',
    'INSUFFICIENT_COVERAGE',
  ]),
  firstBelowAt: UtcTimestampSchema.nullable(),
  recoveredAt: UtcTimestampSchema.nullable(),
  recoverySeconds: z.number().int().nonnegative().nullable(),
  observedUntil: UtcTimestampSchema.nullable(),
  censorAt: UtcTimestampSchema.nullable(),
  censorReason: z.enum(['HORIZON_END', 'ANALYSIS_CUTOFF', 'DATA_GAP']).nullable(),
});
export type EventRecovery = z.infer<typeof RecoverySchema>;
const LagSchema = z.strictObject({
  segment: z.enum(['PRE_EVENT', 'POST_EVENT']),
  lagBars: z.number().int(),
  direction: z.enum(['BTC_LEADS_ASSET', 'ASSET_LEADS_BTC', 'CONTEMPORANEOUS']),
  status: z.enum(['COMPUTED', 'INSUFFICIENT_PAIRS', 'ZERO_VARIANCE']),
  correlation: nullableDecimal,
  pairs: z.array(
    z.strictObject({
      factorBarId: IdSchema,
      assetBarId: IdSchema,
      factorAt: UtcTimestampSchema,
      assetAt: UtcTimestampSchema,
      pairKnownAt: UtcTimestampSchema,
    }),
  ),
});
export type EventLag = z.infer<typeof LagSchema>;
const CoverageSchema = z.strictObject({
  complete: z.boolean(),
  expectedBars: z.number().int().nonnegative(),
  observedBars: z.number().int().nonnegative(),
  barIds: z.array(IdSchema),
  missingCloseTimes: z.array(UtcTimestampSchema),
  excludedBarIds: z.array(IdSchema),
});
const ControlResponseSchema = z.strictObject({
  asset: z.string(),
  grossReturn: nullableDecimal,
  absoluteReturn: nullableDecimal,
});
const CandidateSchema = z.strictObject({
  at: UtcTimestampSchema,
  status: z.enum([
    'SELECTED',
    'ELIGIBLE_NOT_SAMPLED',
    'NEWS_BLACKOUT',
    'AFTER_NEWS_CUTOFF',
    'TIME_OF_DAY_MISMATCH',
    'VOLATILITY_MISMATCH',
    'INCOMPLETE_COVERAGE',
    'EVENT_INCOMPLETE',
  ]),
});
export const EventControlsResultSchema = z.strictObject({
  schemaVersion: z.literal('event-controls-result.v1'),
  execution: z.literal('DISABLED'),
  interpretation: z.literal('DESCRIPTIVE_ASSOCIATION_NOT_CAUSAL_OR_EXECUTABLE'),
  baselineScope: z.literal('NO_OBSERVED_NEWS_IN_FROZEN_CORPUS_NOT_PROOF_OF_NO_EVENT'),
  inputHash: HashSchema,
  configHash: HashSchema,
  request: EventControlsRequestSchema,
  events: z
    .array(
      z.strictObject({
        eventId: IdSchema,
        decisionAt: UtcTimestampSchema,
        lineageIds: z.array(IdSchema),
        taxonomy: z.array(NewsEventTypeSchema),
        eventContextHash: HashSchema,
        cohortComplete: z.boolean(),
        samplingSeed: SeedSchema,
        overlappingControlPairs: z.number().int().nonnegative(),
        factorCoverage: CoverageSchema,
        basketReturn: nullableDecimal,
        responses: z.array(
          z.strictObject({
            series: EventStudySeriesSchema,
            coverage: CoverageSchema,
            grossReturn: nullableDecimal,
            netReturn: nullableDecimal,
            absoluteReturn: nullableDecimal,
            fit: FitSchema,
            btcBetaAdjustedReturn: nullableDecimal,
            marketModelAdjustedReturn: nullableDecimal,
            factorAdjustmentStatus: z.enum([
              'COMPUTED',
              'INCOMPLETE',
              'UNFITTED',
              'INVALID_PROJECTION',
            ]),
            relativeToBasket: nullableDecimal,
            recovery: RecoverySchema,
            lags: z.array(LagSchema),
            baseline: z.strictObject({
              selectedControls: z.number().int().nonnegative(),
              atLeastAsLarge: z.number().int().nonnegative(),
              frequency: nullableDecimal,
            }),
          }),
        ),
        candidates: z.array(CandidateSchema),
        controls: z.array(
          z.strictObject({
            at: UtcTimestampSchema,
            preFactorVolatility: DecimalStringSchema,
            evidenceBarIds: z.array(IdSchema),
            responses: z.array(ControlResponseSchema),
          }),
        ),
      }),
    )
    .max(20),
  excludedByTaxonomy: z.array(
    z.strictObject({ eventId: IdSchema, decisionAt: UtcTimestampSchema }),
  ),
  taxonomyGroups: z.array(
    z.strictObject({
      taxonomy: z.array(NewsEventTypeSchema),
      observations: z.number().int().nonnegative(),
      uniqueEvents: z.number().int().nonnegative(),
      completeResponses: z.number().int().nonnegative(),
      meanAbsoluteReturn: nullableDecimal,
    }),
  ),
  concentration: z.strictObject({
    selectedObservations: z.number().int().nonnegative(),
    uniqueEventIds: z.number().int().nonnegative(),
    overlappingObservationPairs: z.number().int().nonnegative(),
    completeResponses: z.number().int().nonnegative(),
    herfindahl: nullableDecimal,
    largestShare: nullableDecimal,
    groups: z.array(
      z.strictObject({
        groupId: IdSchema,
        eventIds: z.array(IdSchema),
        observations: z.number().int().nonnegative(),
        completeResponses: z.number().int().nonnegative(),
        absoluteMovement: nullableDecimal,
        share: nullableDecimal,
      }),
    ),
  }),
});
export type EventControlsResult = z.infer<typeof EventControlsResultSchema>;
export const EventControlsArtifactSchema = z.strictObject({
  schemaVersion: z.literal('event-controls-artifact.v1'),
  algorithmVersion: z.literal('event-controls.v1'),
  clockSemantics: z.literal('utc-nanoseconds.v1'),
  randomAlgorithm: z.literal('mulberry32.v1'),
  codeVersion: z.string().min(1).max(200),
  input: EventStudyInputSchema,
  result: EventControlsResultSchema,
});
export interface EventControls {
  run(request: unknown): EventControlsResult;
}
