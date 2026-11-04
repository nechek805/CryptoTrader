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
  version: z.literal('btc-retrospective.v1'),
  datasetId: HashSchema,
  planHash: HashSchema,
  // Optional solely for pre-release cached reports; current replay requires the fingerprint.
  engineHash: HashSchema.optional(),
  origin: z.enum(['PUBLIC_HISTORICAL', 'SYNTHETIC']),
  plan: z.custom<typeof BTC_PLAN>((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const input = value as Record<string, unknown>;
    return (
      Object.keys(input).length === Object.keys(BTC_PLAN).length &&
      Object.entries(BTC_PLAN).every(([k, v]) => input[k] === v)
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
export const BtcJobSchema = z.strictObject({
  id: z.string().uuid(),
  kind: z.enum(['DOWNLOAD', 'RUN']),
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
});
export const BtcDataViewSchema = z.strictObject({
  id: HashSchema,
  dataset: BtcDatasetSchema.omit({ captures: true }),
  sources: z.array(
    z.strictObject({ url: z.string().url(), receivedAt: z.string(), hash: HashSchema }),
  ),
});
