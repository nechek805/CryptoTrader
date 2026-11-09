import { z } from 'zod';
import {
  DecimalStringSchema,
  PositiveDecimalSchema,
  NonNegativeDecimalSchema,
  HashSchema,
} from './primitives.js';
const Money = DecimalStringSchema.transform((v) => String(v));
const Positive = PositiveDecimalSchema.transform((v) => String(v));
const NonNegative = NonNegativeDecimalSchema.transform((v) => String(v));
import { BtcHourSchema } from './btc-test.js';
export const LiveExchangeSchema = z.enum(['BINANCE', 'BYBIT', 'OKX', 'BITGET', 'MEXC']);
export const LiveAssetSchema = z.enum(['SOL', 'XRP']);
export const LIVE_EXCHANGES = LiveExchangeSchema.options;
export const LIVE_ASSETS = LiveAssetSchema.options;
export type LiveExchange = z.infer<typeof LiveExchangeSchema>;
export type LiveAsset = z.infer<typeof LiveAssetSchema>;
const Time = z.number().int().nonnegative();
export const LiveSourceSchema = z.strictObject({
  id: z.string().uuid(),
  url: z.string().url(),
  requestedAt: Time,
  receivedAt: Time,
  providerAt: Time.nullable(),
  sequence: z.string().max(200),
  rawHash: HashSchema,
  raw: z.string().max(2000000),
});
export const LiveBookSchema = z.strictObject({
  exchange: LiveExchangeSchema,
  asset: LiveAssetSchema,
  source: LiveSourceSchema,
  bids: z
    .array(z.tuple([Positive, Positive]))
    .min(1)
    .max(5),
  asks: z
    .array(z.tuple([Positive, Positive]))
    .min(1)
    .max(5),
});
export const LiveInstrumentSchema = z.strictObject({
  exchange: LiveExchangeSchema,
  asset: LiveAssetSchema,
  tick: Positive,
  step: Positive,
  minQty: NonNegative,
  minNotional: NonNegative,
  source: LiveSourceSchema,
});
export const LiveBarsSchema = z.strictObject({
  exchange: LiveExchangeSchema,
  asset: LiveAssetSchema,
  bars: z.array(BtcHourSchema).max(300),
  source: LiveSourceSchema,
});
export type LiveBook = z.infer<typeof LiveBookSchema>;
export type LiveInstrument = z.infer<typeof LiveInstrumentSchema>;
export type LiveBars = z.infer<typeof LiveBarsSchema>;
export type LiveSource = z.infer<typeof LiveSourceSchema>;
export const LiveFillSchema = z.strictObject({
  at: Time,
  quoteId: z.string(),
  kind: z.enum(['OPEN', 'CLOSE']),
  quantity: Positive,
  price: Positive,
  fee: NonNegative,
  slippage: NonNegative,
  reason: z.string(),
});
export const LivePositionSchema = z.strictObject({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  exchange: LiveExchangeSchema,
  asset: LiveAssetSchema,
  side: z.enum(['LONG', 'SHORT']),
  strategy: z.literal('V6'),
  status: z.enum(['WORKING', 'WIN', 'LOSS', 'BREAKEVEN']),
  lifecycle: z.enum(['OPEN', 'CLOSING', 'CLOSED']),
  openedAt: Time,
  closedAt: Time.nullable(),
  updatedAt: Time,
  quantity: Positive,
  remaining: NonNegative,
  reserved: NonNegative,
  entry: Positive,
  mark: Positive,
  markAt: Time,
  notional: Positive,
  stop: Positive,
  target: Positive,
  fees: NonNegative,
  financing: NonNegative,
  chargedThrough: Time,
  grossRealized: Money,
  netPnl: Money,
  exitReason: z.string().nullable(),
  decision: z.record(z.string(), z.unknown()),
  fills: z.array(LiveFillSchema).min(1).max(5000),
  consumedSequence: z.string(),
});
export type LivePosition = z.infer<typeof LivePositionSchema>;
export const LivePendingSchema = z.strictObject({
  side: z.enum(['LONG', 'SHORT']),
  createdAt: Time,
  expiresAt: Time,
  atr: Positive,
  stopAtr: Positive,
  targetAtr: Positive,
  volume: NonNegative,
  decision: z.record(z.string(), z.unknown()),
});
export const LiveAccountSchema = z.strictObject({
  exchange: LiveExchangeSchema,
  cash: Money,
  realized: Money,
  fees: NonNegative,
  financing: NonNegative,
  day: z.string(),
  dayEquity: Money,
  blocked: z.boolean(),
});
export const LiveRunSchema = z.strictObject({
  version: z.literal('live-paper.v1'),
  id: z.string().uuid(),
  startedAt: Time,
  deadlineAt: Time,
  endedAt: Time.nullable(),
  status: z.enum(['RUNNING', 'PAUSED', 'STOPPING', 'ENDED']),
  heartbeatAt: Time,
  revision: z.number().int().nonnegative(),
  engineHash: z.string(),
  profileHash: z.string(),
  config: z.strictObject({
    initialPerExchange: z.literal('10000'),
    durationHours: z.literal(24),
    slippageRate: z.literal('0.0005'),
    annualBorrowRate: z.literal('0.1'),
    feeRates: z.record(LiveExchangeSchema, NonNegative),
    profiles: z.record(LiveAssetSchema, z.unknown()),
  }),
  accounts: z.array(LiveAccountSchema).length(5),
  positions: z.array(LivePositionSchema).max(10),
  watermarks: z.record(z.string(), Time),
  pending: z.record(z.string(), LivePendingSchema),
  decisions: z.record(z.string(), z.string()),
  lastEventHash: z.string(),
});
export type LiveRun = z.infer<typeof LiveRunSchema>;
export const LiveQuerySchema = z
  .strictObject({
    runId: z.string().uuid().optional(),
    exchange: LiveExchangeSchema.optional(),
    asset: LiveAssetSchema.optional(),
    side: z.enum(['LONG', 'SHORT']).optional(),
    status: z.enum(['WORKING', 'WIN', 'LOSS', 'BREAKEVEN']).optional(),
    lifecycle: z.enum(['OPEN', 'CLOSING', 'CLOSED']).optional(),
    from: z.coerce.number().int().nonnegative().optional(),
    to: z.coerce.number().int().nonnegative().optional(),
    dateField: z.enum(['openedAt', 'closedAt']).default('openedAt'),
    minPnl: Money.optional(),
    maxPnl: Money.optional(),
    sort: z
      .enum([
        'openedAt',
        'closedAt',
        'netPnl',
        'notional',
        'fees',
        'exchange',
        'asset',
        'side',
        'status',
      ])
      .default('openedAt'),
    direction: z.enum(['asc', 'desc']).default('desc'),
    page: z.coerce.number().int().min(1).max(10000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  })
  .refine(
    (q) => q.from === undefined || q.to === undefined || q.from <= q.to,
    'Invalid date interval',
  );
export type LiveQuery = z.infer<typeof LiveQuerySchema>;
export const LiveControlSchema = z.strictObject({ action: z.enum(['PAUSE', 'RESUME', 'STOP']) });
export const LiveFeedSchema = z.strictObject({
  exchange: LiveExchangeSchema,
  asset: LiveAssetSchema,
  book: LiveBookSchema.nullable(),
  instrument: LiveInstrumentSchema.nullable(),
  bars: z.number().int(),
  lastBarAt: Time.nullable(),
  error: z.string().nullable(),
  updatedAt: Time,
});
export type LiveFeed = z.infer<typeof LiveFeedSchema>;
export const LiveOverviewSchema = z.strictObject({
  version: z.literal('live-paper.v1'),
  execution: z.literal('SIMULATED'),
  asOf: Time,
  worker: z.enum(['RUNNING', 'ERROR', 'STOPPED']),
  error: z.string().nullable(),
  run: LiveRunSchema.nullable(),
  runs: z.array(z.strictObject({ id: z.string(), startedAt: Time, status: z.string() })),
  feeds: z.array(LiveFeedSchema),
  summaries: z.array(
    z.strictObject({
      exchange: LiveExchangeSchema,
      equity: Money,
      netPnl: Money,
      realized: Money,
      unrealized: Money,
      openNotional: NonNegative,
      stale: z.boolean(),
    }),
  ),
});
export const LivePageSchema = z.strictObject({
  asOf: Time,
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
  positions: z.array(LivePositionSchema),
});
export type LiveOverview = z.infer<typeof LiveOverviewSchema>;
