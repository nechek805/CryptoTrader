import { z } from 'zod';
import {
  DecimalStringSchema,
  HashSchema,
  IdSchema,
  NonNegativeDecimalSchema,
  PortfolioSchema,
  PositiveDecimalSchema,
  SeedSchema,
  SymbolSchema,
  UnitDecimalSchema,
  UtcTimestampSchema,
} from './primitives.js';

export const PerformanceCurveSchema = z.strictObject({
  at: UtcTimestampSchema,
  equity: NonNegativeDecimalSchema.nullable(),
  exposureFraction: NonNegativeDecimalSchema.nullable(),
  positionOpen: z.boolean(),
  validUntil: UtcTimestampSchema.nullable(),
});
export const PerformanceTradeSchema = z.strictObject({
  id: IdSchema,
  symbol: SymbolSchema,
  openedAt: UtcTimestampSchema,
  closedAt: UtcTimestampSchema,
  netPnl: DecimalStringSchema,
  grossPnl: DecimalStringSchema,
  fees: NonNegativeDecimalSchema,
  regime: IdSchema,
  newsCategory: IdSchema,
  volatilityTier: IdSchema,
  evidenceIds: z.array(IdSchema).min(1).max(512),
});
export const PerformanceInputSchema = z.strictObject({
  schemaVersion: z.literal('performance-input.v1'),
  portfolio: PortfolioSchema,
  sourceHash: HashSchema,
  initialEquity: PositiveDecimalSchema,
  startAt: UtcTimestampSchema,
  endAt: UtcTimestampSchema,
  curve: z.array(PerformanceCurveSchema).min(1).max(200000),
  trades: z.array(PerformanceTradeSchema).max(10000),
  fills: z
    .array(
      z.strictObject({
        id: IdSchema,
        at: UtcTimestampSchema,
        notional: PositiveDecimalSchema,
        fee: NonNegativeDecimalSchema,
        slippageCost: NonNegativeDecimalSchema,
      }),
    )
    .max(50000),
  acceptedOrders: z.number().int().nonnegative(),
  filledOrders: z.number().int().nonnegative(),
  rejectedSignals: z.number().int().nonnegative(),
  holds: z.number().int().nonnegative(),
  declaredOpportunities: z.number().int().nonnegative(),
  observedOpportunities: z.number().int().nonnegative(),
});
export type PerformanceInput = z.infer<typeof PerformanceInputSchema>;
export const DailyPerformanceSchema = z.strictObject({
  day: z.iso.date(),
  startEquity: NonNegativeDecimalSchema.nullable(),
  endEquity: NonNegativeDecimalSchema.nullable(),
  netPnl: DecimalStringSchema.nullable(),
  netReturn: DecimalStringSchema.nullable(),
  completeCalendarDay: z.boolean(),
  sourceCoverage: z.enum(['COMPLETE', 'MISSING_OR_STALE']),
});
export const PerformanceMetricsSchema = z.strictObject({
  schemaVersion: z.literal('performance-metrics.v1'),
  portfolio: PortfolioSchema,
  initialEquity: PositiveDecimalSchema,
  terminalEquity: NonNegativeDecimalSchema.nullable(),
  netPnl: DecimalStringSchema.nullable(),
  grossPnlBeforeFees: DecimalStringSchema.nullable(),
  netReturn: DecimalStringSchema.nullable(),
  grossReturnBeforeFees: DecimalStringSchema.nullable(),
  closedTrades: z.number().int().nonnegative(),
  winRate: UnitDecimalSchema.nullable(),
  profitFactor: NonNegativeDecimalSchema.nullable(),
  averageWin: PositiveDecimalSchema.nullable(),
  averageLoss: DecimalStringSchema.nullable(),
  expectancyAfterFees: DecimalStringSchema.nullable(),
  maxDrawdown: UnitDecimalSchema.nullable(),
  observedMaxDrawdown: UnitDecimalSchema,
  recoveryFactor: DecimalStringSchema.nullable(),
  dailyReturnVolatility: NonNegativeDecimalSchema.nullable(),
  fees: NonNegativeDecimalSchema,
  slippageCost: NonNegativeDecimalSchema,
  turnoverNotional: NonNegativeDecimalSchema,
  turnoverFraction: NonNegativeDecimalSchema,
  timeInMarketFraction: UnitDecimalSchema,
  timeWeightedExposure: NonNegativeDecimalSchema.nullable(),
  knownValuationFraction: UnitDecimalSchema,
  eventCoverage: UnitDecimalSchema.nullable(),
  rejectedSignals: z.number().int().nonnegative(),
  holds: z.number().int().nonnegative(),
  fillRate: UnitDecimalSchema.nullable(),
  daily: z.array(DailyPerformanceSchema).max(3660),
  trades: z.array(PerformanceTradeSchema).max(10000),
});
export type PerformanceMetrics = z.infer<typeof PerformanceMetricsSchema>;
export const EvaluationPlanSchema = z.strictObject({
  schemaVersion: z.literal('evaluation-plan.v1'),
  frozenAt: UtcTimestampSchema,
  generatedAt: UtcTimestampSchema,
  randomSeed: SeedSchema,
  phase: z.enum(['TEST', 'FORWARD']),
  trialRegistryHash: HashSchema,
  experimentCount: z.number().int().min(1).max(10000),
  hyperparameterTrials: z.number().int().min(1).max(100000),
  familySize: z.number().int().min(3).max(1000000),
  opportunityGrid: z
    .array(z.strictObject({ at: UtcTimestampSchema, symbol: SymbolSchema }))
    .min(1)
    .max(100000),
  blockDays: z.number().int().min(1).max(30),
  overlapHorizonDays: z.number().int().min(0).max(30),
  minimumBlocks: z.number().int().min(2).max(100),
  minimumClosedTrades: z.number().int().min(1).max(10000),
  resamples: z.number().int().min(199).max(20000),
  alpha: z.number().positive().max(0.1),
  maximumTailContribution: UnitDecimalSchema,
  minimumCoverage: UnitDecimalSchema,
  maximumDrawdown: UnitDecimalSchema,
  minimumPairedDailyImprovement: DecimalStringSchema,
  primaryComparison: z
    .literal('NEWS_ONLY_MINUS_MARKET_ONLY')
    .default('NEWS_ONLY_MINUS_MARKET_ONLY'),
  marketObservationCadenceSeconds: z.number().int().min(1).max(3600).default(60),
  scenarios: z
    .array(
      z.strictObject({
        id: IdSchema,
        feeMultiplier: PositiveDecimalSchema,
        slippageMultiplier: PositiveDecimalSchema,
        addedLatencyMs: z.number().int().min(0).max(59000),
      }),
    )
    .min(1)
    .max(6),
});
export type EvaluationPlan = z.infer<typeof EvaluationPlanSchema>;
export const PairedComparisonSchema = z.strictObject({
  left: PortfolioSchema,
  right: PortfolioSchema,
  pairedDays: z.number().int().nonnegative(),
  blockCount: z.number().int().nonnegative(),
  estimate: z.number().nullable(),
  lower: z.number().nullable(),
  upper: z.number().nullable(),
  confidenceLevel: z.number().positive().max(1),
  method: z.literal('CIRCULAR_CONTIGUOUS_DAY_BLOCK_BOOTSTRAP'),
  status: z.enum([
    'INSUFFICIENT_EVIDENCE',
    'MISSING_COVERAGE',
    'ZERO_VARIANCE',
    'CONDITIONAL_APPROXIMATION',
    'MONTE_CARLO_RESOLUTION',
  ]),
  dates: z.array(z.iso.date()).max(3660),
});
export const EvaluationDiagnosticsSchema = z.strictObject({
  declaredExperiments: z.number().int().positive(),
  declaredTrials: z.number().int().positive(),
  familySize: z.number().int().positive(),
  blockDays: z.number().int().positive(),
  maximumHoldingDays: z.number().int().nonnegative(),
  multiplicity: z.literal('BONFERRONI_FAMILYWISE_INTERVALS_DECLARED_SEARCH_ONLY'),
  perArm: z
    .array(
      z.strictObject({
        portfolio: PortfolioSchema,
        closedTrades: z.number().int().nonnegative(),
        completeDays: z.number().int().nonnegative(),
        tailContribution: z.number().min(0).max(1).nullable(),
        warnings: z.array(z.string()),
      }),
    )
    .length(4),
  temporalSplits: z
    .array(
      z.strictObject({
        trainEnd: z.iso.date(),
        testStart: z.iso.date(),
        testEnd: z.iso.date(),
        embargoDays: z.number().int().nonnegative(),
      }),
    )
    .max(3660),
});
export const SensitivityResultSchema = z.strictObject({
  id: IdSchema,
  configHash: HashSchema,
  candidateSidesHash: HashSchema,
  metrics: z.array(PerformanceMetricsSchema).length(4),
  warnings: z.array(z.string()),
});
export const EvaluationAttributionSchema = z.strictObject({
  strata: z
    .array(
      z.strictObject({
        dimension: z.enum(['ASSET', 'MONTH', 'REGIME', 'NEWS_CATEGORY', 'VOLATILITY_TIER']),
        value: z.string().min(1).max(200),
        portfolio: PortfolioSchema,
        closedTrades: z.number().int().nonnegative(),
        grossPnl: DecimalStringSchema,
        netPnl: DecimalStringSchema,
        fees: NonNegativeDecimalSchema,
      }),
    )
    .max(50000),
  conflicts: z
    .array(
      z.strictObject({
        symbol: SymbolSchema,
        at: UtcTimestampSchema,
        newsCandidateId: IdSchema,
        marketCandidateId: IdSchema,
      }),
    )
    .max(10000),
  calibration: z
    .array(
      z.strictObject({
        portfolio: PortfolioSchema,
        boundKnown: z.number().int().nonnegative(),
        uncalibrated: z.number().int().nonnegative(),
        brierScore: z.null(),
        reason: z.literal('NO_MATCHED_FROZEN_HORIZON_LABELS'),
      }),
    )
    .length(4),
  timing: z
    .array(
      z.strictObject({
        candidateId: IdSchema,
        evidenceAvailableAt: UtcTimestampSchema.nullable(),
        firstFillAt: UtcTimestampSchema.nullable(),
        delaySeconds: z.number().nonnegative().nullable(),
        basis: z.literal('LATEST_REQUIRED_EVIDENCE_NOT_PUBLICATION'),
      }),
    )
    .max(10000),
  provenanceFailures: z
    .array(z.strictObject({ code: IdSchema, count: z.number().int().positive() }))
    .max(1000),
  marketCoverage: UnitDecimalSchema.nullable(),
  newsCoverage: UnitDecimalSchema.nullable(),
});
export const EvaluationReportSchema = z.strictObject({
  schemaVersion: z.literal('evaluation-report.v1'),
  id: IdSchema,
  execution: z.literal('SIMULATED'),
  origin: z.enum(['SYNTHETIC', 'PUBLIC_READ_ONLY']),
  paperHash: HashSchema,
  manifestHash: HashSchema,
  plan: EvaluationPlanSchema,
  configHash: HashSchema,
  codeVersion: z.string().min(1).max(200),
  actualStartAt: UtcTimestampSchema,
  actualEndAt: UtcTimestampSchema,
  completePeriod: z.boolean(),
  metrics: z.array(PerformanceMetricsSchema).length(4),
  benchmarks: z.strictObject({
    cashNetReturn: z.literal('0'),
    buyAndHoldNetReturn: DecimalStringSchema.nullable(),
    policy: z.literal('FIRST_COMMON_QUOTE_TO_FINAL_VALID_MARK_WITH_FROZEN_COSTS'),
    reason: z.string(),
  }),
  diagnostics: EvaluationDiagnosticsSchema,
  pairedComparisons: z.array(PairedComparisonSchema).length(3),
  sensitivity: z.array(SensitivityResultSchema).min(1).max(6),
  attribution: EvaluationAttributionSchema,
  memo: z.strictObject({
    recommendation: z.enum(['CONTINUE', 'REVISE', 'STOP']),
    reasons: z.array(z.string()).min(1),
    alphaClaim: z.literal('NOT_ESTABLISHED'),
    realMoneyAuthorized: z.literal(false),
  }),
  evidence: z
    .array(
      z.strictObject({
        id: IdSchema,
        hash: HashSchema,
        file: z.string().regex(/^evidence\/[a-f0-9]{64}\.json$/),
      }),
    )
    .max(100000),
  warnings: z.array(z.string()),
  hash: HashSchema,
});
export type EvaluationReport = z.infer<typeof EvaluationReportSchema>;
