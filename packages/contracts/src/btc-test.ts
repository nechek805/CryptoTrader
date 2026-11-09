import { z } from 'zod';
import {
  HashSchema,
  PositiveDecimalSchema,
  NonNegativeDecimalSchema,
  DecimalStringSchema,
  compareDecimal,
} from './primitives.js';

export const BtcHourSchema = z
  .strictObject({
    at: z.number().int().nonnegative(),
    open: PositiveDecimalSchema,
    high: PositiveDecimalSchema,
    low: PositiveDecimalSchema,
    close: PositiveDecimalSchema,
    volume: NonNegativeDecimalSchema,
  })
  .superRefine((b, c) => {
    if (
      compareDecimal(b.low, b.high) > 0 ||
      compareDecimal(b.low, b.open) > 0 ||
      compareDecimal(b.low, b.close) > 0 ||
      compareDecimal(b.high, b.open) < 0 ||
      compareDecimal(b.high, b.close) < 0
    )
      c.addIssue({ code: 'custom', message: 'Invalid OHLC envelope' });
  });
export const BtcDatasetSchema = z.strictObject({
  version: z.literal('btc-history.v1'),
  symbol: z.literal('BTCUSDT'),
  interval: z.literal('1h'),
  origin: z.enum(['PUBLIC_HISTORICAL', 'SYNTHETIC']),
  from: z.number().int(),
  to: z.number().int(),
  capturedAt: z.string().datetime(),
  historicalAvailability: z.literal('UNKNOWN'),
  captures: z
    .array(
      z.strictObject({
        url: z.string().url(),
        receivedAt: z.string().datetime(),
        body: z.string().max(2000000),
        hash: HashSchema,
      }),
    )
    .min(1)
    .max(8),
  bars: z.array(BtcHourSchema).min(100).max(6000),
});
export type BtcDataset = z.infer<typeof BtcDatasetSchema>;
export type BtcHour = z.infer<typeof BtcHourSchema>;
export const BTC_PLAN = Object.freeze({
  version: 'btc-ma-atr.v1',
  initialUsdt: '10000',
  fast: 20,
  slow: 50,
  atr: 14,
  stopAtr: '2',
  targetAtr: '3',
  riskFraction: '0.0025',
  maxAllocation: '0.1',
  dailyLossFraction: '0.02',
  feeRate: '0.001',
  slippageRate: '0.0005',
  quantityStep: '0.00001',
  priceTick: '0.01',
  minNotional: '5',
  maxVolumeFraction: '0.01',
  execution: 'NEXT_OPEN',
  shorts: false,
  availability: 'ASSUMED_BAR_CLOSE',
} as const);
export const BTC_PLAN_V2 = Object.freeze({
  ...BTC_PLAN,
  version: 'btc-ma-atr.v2',
  trend: 200,
  trendSlopeHours: 24,
  minRewardCostMultiple: '3',
  initialBullishEntry: false,
} as const);
export const BTC_PLAN_V3 = Object.freeze({
  ...BTC_PLAN_V2,
  version: 'btc-ma-atr.v3',
  maxSignalRangeAtr: '2',
  minCloseLocation: '0.5',
} as const);
export type BtcPlan = typeof BTC_PLAN | typeof BTC_PLAN_V2 | typeof BTC_PLAN_V3;
export const BtcReplayWindowSchema = z
  .strictObject({
    fromIndex: z.number().int().min(0).max(5999),
    toIndex: z.number().int().min(100).max(6000),
  })
  .refine((w) => w.fromIndex < w.toIndex, 'Invalid replay window');
export const BtcDecisionSchema = z.strictObject({
  index: z.number().int().nonnegative(),
  at: z.number().int(),
  action: z.enum(['WARMUP', 'LONG', 'EXIT', 'HOLD']),
  reason: z.string(),
  fast: NonNegativeDecimalSchema.nullable(),
  slow: NonNegativeDecimalSchema.nullable(),
  atr: NonNegativeDecimalSchema.nullable(),
  quantity: NonNegativeDecimalSchema,
  stop: PositiveDecimalSchema.nullable(),
  target: PositiveDecimalSchema.nullable(),
  cash: NonNegativeDecimalSchema,
  btc: NonNegativeDecimalSchema,
  equity: NonNegativeDecimalSchema,
  buyHold: NonNegativeDecimalSchema,
  trend: PositiveDecimalSchema.nullable().optional(),
  trendRising: z.boolean().nullable().optional(),
  rewardCostRatio: NonNegativeDecimalSchema.nullable().optional(),
  entryGate: z
    .enum(['WARMUP', 'TREND_BLOCK', 'COST_BLOCK', 'SHOCK_BLOCK', 'WEAK_CLOSE_BLOCK', 'PASS'])
    .optional(),
  signalRangeAtr: NonNegativeDecimalSchema.nullable().optional(),
  closeLocation: NonNegativeDecimalSchema.nullable().optional(),
  executionNote: z.string().optional(),
});
export const BtcTradeSchema = z.strictObject({
  index: z.number().int(),
  at: z.number().int(),
  side: z.enum(['BUY', 'SELL']),
  reason: z.string(),
  quantity: PositiveDecimalSchema,
  price: PositiveDecimalSchema,
  fee: NonNegativeDecimalSchema,
  slippage: NonNegativeDecimalSchema,
  stop: PositiveDecimalSchema.nullable(),
  target: PositiveDecimalSchema.nullable(),
});
export const BtcReportSchema = z.strictObject({
  version: z.enum(['btc-retrospective.v1', 'btc-retrospective.v2', 'btc-retrospective.v3']),
  window: BtcReplayWindowSchema.optional(),
  datasetId: HashSchema,
  planHash: HashSchema,
  // Optional solely for pre-release cached reports; current replay requires the fingerprint.
  engineHash: HashSchema.optional(),
  origin: z.enum(['PUBLIC_HISTORICAL', 'SYNTHETIC']),
  plan: z.custom<BtcPlan>((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const input = value as Record<string, unknown>;
    return [BTC_PLAN, BTC_PLAN_V2, BTC_PLAN_V3].some(
      (plan) =>
        Object.keys(input).length === Object.keys(plan).length &&
        Object.entries(plan).every(([k, v]) => Object.hasOwn(input, k) && input[k] === v),
    );
  }, 'Expected the frozen BTC research plan'),
  interpretation: z.literal('RETROSPECTIVE_ASSUMPTIONS_NOT_FORWARD_VERIFIED'),
  decisions: z.array(BtcDecisionSchema).min(100).max(6000),
  trades: z.array(BtcTradeSchema).max(12000),
  summary: z.strictObject({
    finalEquity: NonNegativeDecimalSchema,
    netPnl: DecimalStringSchema,
    returnFraction: DecimalStringSchema,
    maxDrawdown: NonNegativeDecimalSchema,
    fees: NonNegativeDecimalSchema,
    slippage: NonNegativeDecimalSchema,
    closedTrades: z.number().int().nonnegative(),
    wins: z.number().int().nonnegative(),
    buyHoldEquity: NonNegativeDecimalSchema,
    cashEquity: z.literal('10000'),
    openBtc: NonNegativeDecimalSchema,
  }),
  journalHash: HashSchema,
});
export type BtcReport = z.infer<typeof BtcReportSchema>;
export const BtcAttributionSchema = z.strictObject({
  closedNet: DecimalStringSchema,
  openContribution: DecimalStringSchema,
  beforeFees: DecimalStringSchema,
  beforeFeesAndSlippage: DecimalStringSchema,
  totalFriction: NonNegativeDecimalSchema,
  averageWin: DecimalStringSchema.nullable(),
  averageLoss: DecimalStringSchema.nullable(),
  profitFactor: NonNegativeDecimalSchema.nullable(),
  shortHoldCount: z.number().int().nonnegative(),
  shortHoldNet: DecimalStringSchema,
  groups: z
    .array(
      z.strictObject({
        reason: z.string(),
        count: z.number().int().nonnegative(),
        wins: z.number().int().nonnegative(),
        net: DecimalStringSchema,
        fees: NonNegativeDecimalSchema,
        slippage: NonNegativeDecimalSchema,
        averageHours: NonNegativeDecimalSchema,
      }),
    )
    .max(20),
});
const ComparisonArmSchema = z.strictObject({
  reportId: HashSchema,
  summary: BtcReportSchema.shape.summary,
  exposureFraction: NonNegativeDecimalSchema,
  profitFactor: NonNegativeDecimalSchema.nullable(),
});
export const BtcComparisonSchema = z.strictObject({
  version: z.literal('btc-comparison.v1'),
  datasetId: HashSchema,
  engineHash: HashSchema,
  original: ComparisonArmSchema,
  revised: ComparisonArmSchema,
  attribution: BtcAttributionSchema,
  candidateTrials: z.literal(1),
  planHash: HashSchema,
  interpretation: z.literal('EXPLORATORY_REVISION_PREVIOUSLY_SEEN_HISTORY'),
  originalReproduced: z.literal(true),
  windows: z
    .array(
      z.strictObject({
        label: z.enum(['DEVELOPMENT', 'TEMPORAL_CHECK']),
        fromIndex: z.number().int().nonnegative(),
        toIndex: z.number().int().positive(),
        from: z.string().datetime(),
        to: z.string().datetime(),
        original: ComparisonArmSchema,
        revised: ComparisonArmSchema,
      }),
    )
    .length(2),
});
export type BtcComparison = z.infer<typeof BtcComparisonSchema>;
export const BtcThreeComparisonSchema = z.strictObject({
  version: z.literal('btc-comparison.v2'),
  datasetId: HashSchema,
  engineHash: HashSchema,
  original: ComparisonArmSchema,
  revised: ComparisonArmSchema,
  third: ComparisonArmSchema,
  attribution: BtcAttributionSchema,
  v2Attribution: BtcAttributionSchema,
  candidateTrials: z.literal(2),
  strategyCount: z.literal(3),
  newCandidateTrials: z.literal(1),
  planHash: HashSchema,
  previousComparisonId: HashSchema,
  interpretation: z.literal('EXPLORATORY_REVISION_PREVIOUSLY_SEEN_HISTORY'),
  originalReproduced: z.literal(true),
  v2Reproduced: z.literal(true),
  doubleCostSameFills: z
    .strictObject({
      original: DecimalStringSchema,
      revised: DecimalStringSchema,
      third: DecimalStringSchema,
    })
    .optional(),
  skippedV2Trades: z
    .array(
      z.strictObject({
        entryIndex: z.number().int().nonnegative(),
        entryAt: z.string().datetime(),
        net: DecimalStringSchema,
        reason: z.string(),
      }),
    )
    .max(6000)
    .optional(),
  additionalV3Entries: z.number().int().nonnegative().optional(),
  windows: z
    .array(BtcComparisonSchema.shape.windows.element.extend({ third: ComparisonArmSchema }))
    .length(2),
});
export const BtcAnyComparisonSchema = z.discriminatedUnion('version', [
  BtcComparisonSchema,
  BtcThreeComparisonSchema,
]);
export type BtcThreeComparison = z.infer<typeof BtcThreeComparisonSchema>;
export type BtcAnyComparison = z.infer<typeof BtcAnyComparisonSchema>;
export const BtcJobSchema = z.strictObject({
  id: z.string().uuid(),
  kind: z.enum(['DOWNLOAD', 'RUN', 'COMPARE']),
  status: z.enum(['RUNNING', 'DONE', 'FAILED']),
  message: z.string(),
  datasetId: HashSchema.nullable(),
  reportId: HashSchema.nullable(),
});
export type BtcJob = z.infer<typeof BtcJobSchema>;
export const BtcStateSchema = z.strictObject({
  datasetId: HashSchema.nullable(),
  reportId: HashSchema.nullable(),
  job: BtcJobSchema.nullable(),
  comparisonId: HashSchema.nullable().optional(),
});
export const BtcDataViewSchema = z.strictObject({
  id: HashSchema,
  dataset: BtcDatasetSchema.omit({ captures: true }),
  sources: z.array(
    z.strictObject({ url: z.string().url(), receivedAt: z.string(), hash: HashSchema }),
  ),
});
