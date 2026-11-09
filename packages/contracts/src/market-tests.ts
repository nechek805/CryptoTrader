import { z } from 'zod';
import {
  HashSchema,
  PositiveDecimalSchema,
  NonNegativeDecimalSchema,
  compareDecimal,
} from './primitives.js';
import {
  BtcDatasetSchema,
  BtcReportSchema,
  BtcDecisionSchema,
  BtcTradeSchema,
  BtcAttributionSchema,
} from './btc-test.js';

export const MARKET_ASSETS = [
  'BTC',
  'ETH',
  'SOL',
  'TRX',
  'BNB',
  'XRP',
  'DOGE',
  'ADA',
  'LINK',
  'AVAX',
] as const;
export const MarketAssetSchema = z.enum(MARKET_ASSETS);
export type MarketAsset = z.infer<typeof MarketAssetSchema>;
export const MarketStrategyKeySchema = z.enum(['V1', 'V2', 'V3']);
export type MarketStrategyKey = z.infer<typeof MarketStrategyKeySchema>;
export const MarketFeeModeSchema = z.enum(['ZERO', 'STANDARD']);
export const MarketFeesSchema = z.strictObject({
  V1: z.boolean(),
  V2: z.boolean(),
  V3: z.boolean(),
});
export type MarketFees = z.infer<typeof MarketFeesSchema>;
export const DEFAULT_MARKET_FEES: MarketFees = { V1: true, V2: true, V3: true };
export const MarketFiltersSchema = z
  .strictObject({
    priceTick: PositiveDecimalSchema,
    quantityStep: PositiveDecimalSchema,
    minQty: PositiveDecimalSchema,
    maxQty: PositiveDecimalSchema,
    minNotional: NonNegativeDecimalSchema,
  })
  .refine((f) => compareDecimal(f.maxQty, f.minQty) >= 0, 'Inverted quantity limits');
export const MarketCaptureSchema = z.strictObject({
  url: z.string().url(),
  receivedAt: z.string().datetime(),
  body: z.string().max(2000000),
  hash: HashSchema,
});
export const MarketInstrumentSchema = z
  .strictObject({
    asset: MarketAssetSchema,
    symbol: z.string().regex(/^[A-Z]+USDT$/),
    quote: z.literal('USDT'),
    filters: MarketFiltersSchema,
    metadata: MarketCaptureSchema,
    filterAssumption: z.literal('CURRENT_FILTERS_APPLIED_RETROSPECTIVELY'),
  })
  .refine((i) => i.symbol === i.asset + 'USDT', 'Instrument identity mismatch');
export const MarketHistorySchema = z.strictObject({
  version: z.literal('market-history.v1'),
  origin: z.enum(['PUBLIC_HISTORICAL', 'SYNTHETIC']),
  instrument: MarketInstrumentSchema,
  interval: z.literal('1h'),
  from: z.number().int().nonnegative(),
  to: z.number().int().positive(),
  capturedAt: z.string().datetime(),
  historicalAvailability: z.literal('UNKNOWN'),
  captures: BtcDatasetSchema.shape.captures,
  bars: BtcDatasetSchema.shape.bars,
  referenceBtcDatasetId: HashSchema.optional(),
});
export type MarketHistory = z.infer<typeof MarketHistorySchema>;
export const MarketPlanSchema = z.strictObject({
  strategy: MarketStrategyKeySchema,
  feeMode: MarketFeeModeSchema.optional(),
  reference: BtcReportSchema.shape.plan,
  filters: MarketFiltersSchema,
});
export const MarketReplayDecisionSchema = BtcDecisionSchema.omit({ btc: true }).extend({
  position: NonNegativeDecimalSchema,
});
export const MarketSummarySchema = BtcReportSchema.shape.summary
  .omit({ openBtc: true })
  .extend({ openBase: NonNegativeDecimalSchema });
export const MarketReportSchema = z.strictObject({
  version: z.literal('market-test.v1'),
  asset: MarketAssetSchema,
  symbol: z.string(),
  quote: z.literal('USDT'),
  datasetId: HashSchema,
  engineHash: HashSchema,
  planHash: HashSchema,
  plan: MarketPlanSchema,
  origin: z.enum(['PUBLIC_HISTORICAL', 'SYNTHETIC']),
  interpretation: z.literal('RETROSPECTIVE_ASSUMPTIONS_NOT_FORWARD_VERIFIED'),
  decisions: z.array(MarketReplayDecisionSchema).min(100).max(6000),
  trades: z.array(BtcTradeSchema).max(12000),
  summary: MarketSummarySchema,
  journalHash: HashSchema,
});
export type MarketReport = z.infer<typeof MarketReportSchema>;
export const MarketCellSchema = z.strictObject({
  strategy: MarketStrategyKeySchema,
  reportId: HashSchema,
  summary: MarketSummarySchema,
  attribution: BtcAttributionSchema,
  exposureFraction: NonNegativeDecimalSchema,
  gateCounts: z.record(z.string(), z.number().int().nonnegative()),
});
export const MarketRowSchema = z
  .strictObject({
    asset: MarketAssetSchema,
    datasetId: HashSchema.nullable(),
    status: z.enum(['COMPLETE', 'FAILED']),
    error: z.string().nullable(),
    candles: z.number().int().nonnegative(),
    filters: MarketFiltersSchema.nullable(),
    sources: z.array(MarketCaptureSchema.omit({ body: true })).max(9),
    cells: z.array(MarketCellSchema).max(3),
    btcReferenceReproduced: z.boolean().nullable(),
  })
  .refine(
    (row) =>
      row.status === 'COMPLETE'
        ? row.datasetId !== null &&
          row.filters !== null &&
          row.error === null &&
          row.candles >= 100 &&
          row.cells.length === 3 &&
          new Set(row.cells.map((c) => c.strategy)).size === 3 &&
          (row.asset !== 'BTC' || row.btcReferenceReproduced === true)
        : row.cells.length === 0 && row.error !== null,
    'A market needs all three strategies or an explicit failure',
  );
export const MarketMatrixSchema = z
  .strictObject({
    version: z.literal('market-matrix.v1'),
    feeMode: z.enum(['ZERO', 'STANDARD', 'MIXED']).optional(),
    fees: MarketFeesSchema.optional(),
    feeVariants: z
      .strictObject({
        STANDARD: z.array(MarketRowSchema).length(10),
        ZERO: z.array(MarketRowSchema).length(10),
      })
      .optional(),
    engineHash: HashSchema,
    from: z.number().int(),
    to: z.number().int(),
    referenceBtcDatasetId: HashSchema,
    initialUsdt: z.literal('10000'),
    interval: z.literal('1h'),
    origin: z.enum(['PUBLIC_HISTORICAL', 'SYNTHETIC']),
    rows: z.array(MarketRowSchema).length(10),
    cash: z.strictObject({
      asset: z.literal('USDT'),
      equity: z.literal('10000'),
      netPnl: z.literal('0'),
      trades: z.literal(0),
      interpretation: z.literal('QUOTE_CURRENCY_UNITS_NOT_USD_PEG_TEST'),
    }),
    strategyCount: z.literal(3),
    revisions: z.literal(2),
    selection: z.literal('FIXED_CURRENT_UNIVERSE_NOT_HISTORICAL_RANKING'),
  })
  .refine((m) => new Set(m.rows.map((r) => r.asset)).size === 10, 'Each market must appear once');
export type MarketMatrix = z.infer<typeof MarketMatrixSchema>;
export const MarketJobSchema = z.strictObject({
  id: z.string().uuid(),
  status: z.enum(['RUNNING', 'DONE', 'FAILED']),
  message: z.string(),
  completedAssets: z.number().int().min(0).max(10),
  totalAssets: z.literal(10),
});
export const MarketStateSchema = z.strictObject({
  matrixId: HashSchema.nullable(),
  job: MarketJobSchema.nullable(),
  fees: MarketFeesSchema,
});
export const MarketReportViewSchema = z.strictObject({
  id: HashSchema,
  report: MarketReportSchema,
  attribution: BtcAttributionSchema,
  dataset: MarketHistorySchema.omit({ captures: true, bars: true }),
  bars: MarketHistorySchema.shape.bars,
  sources: z.array(MarketCaptureSchema.omit({ body: true })).max(9),
});
export const MarketCatalogSchema = z
  .array(
    z.strictObject({
      key: MarketStrategyKeySchema,
      name: z.string(),
      description: z.string(),
      rules: z.array(z.string()),
      intendedImprovement: z.string(),
      failureModes: z.array(z.string()),
      warmupHours: z.number().int(),
      reference: BtcReportSchema.shape.plan,
    }),
  )
  .length(3);
