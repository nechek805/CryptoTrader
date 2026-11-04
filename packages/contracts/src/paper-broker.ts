import { z } from 'zod';
import { DecisionRecordSchema } from './decision-audit.js';
import { SimulatedFillSchema, SimulatedOrderSchema } from './domain.js';
import { SpotBalanceSchema, SpotJournalSchema } from './spot-simulation.js';
import {
  CurrencySchema,
  DecimalStringSchema,
  HashSchema,
  IdSchema,
  NonNegativeDecimalSchema,
  PortfolioSchema,
  PositiveDecimalSchema,
  SymbolSchema,
  UnitDecimalSchema,
  UtcTimestampSchema,
} from './primitives.js';

export const PaperConfigSchema = z.strictObject({
  schemaVersion: z.literal('paper-config.v1'),
  runManifestHash: HashSchema,
  riskPolicyHash: HashSchema,
  codeVersion: z.string().min(1).max(200),
  origin: z.enum(['SYNTHETIC', 'PUBLIC_READ_ONLY']),
  startAt: UtcTimestampSchema,
  endAt: UtcTimestampSchema,
  initialCash: PositiveDecimalSchema,
  quoteCurrency: CurrencySchema,
  instruments: z
    .array(
      z.strictObject({
        symbol: SymbolSchema,
        base: CurrencySchema,
        quantityStep: PositiveDecimalSchema,
        minimumQuantity: PositiveDecimalSchema,
        tickSize: PositiveDecimalSchema,
        metadataHash: HashSchema,
        availableAt: UtcTimestampSchema,
        validUntil: UtcTimestampSchema,
      }),
    )
    .min(1)
    .max(20),
  source: z.strictObject({
    id: IdSchema,
    adapterVersion: IdSchema,
    licenseReviewHash: HashSchema,
    reviewedAt: UtcTimestampSchema,
    validUntil: UtcTimestampSchema,
    approved: z.boolean(),
  }),
  latencyMs: z.number().int().min(1).max(60000),
  maxQuoteAgeSeconds: z.number().int().min(1).max(3600),
  maxClockSkewSeconds: z.number().int().min(0).max(60),
  makerRate: UnitDecimalSchema,
  takerRate: UnitDecimalSchema,
  slippageBps: NonNegativeDecimalSchema,
  participation: UnitDecimalSchema,
  queueAheadQuantity: NonNegativeDecimalSchema,
  recordingPolicy: z
    .enum([
      'IDLE_30S_ACTIVE_100MS_RELEVANT_TRADES_V1',
      'TRIAL_IDLE_120S_ACTIVE_100MS_RELEVANT_TRADES_V1',
    ])
    .default('IDLE_30S_ACTIVE_100MS_RELEVANT_TRADES_V1'),
  newsSources: z
    .array(
      z.strictObject({
        id: IdSchema,
        licenseReviewHash: HashSchema,
        validUntil: UtcTimestampSchema,
        heartbeatTtlSeconds: z.number().int().min(1).max(86400),
      }),
    )
    .max(10)
    .default([]),
});
export type PaperConfig = z.infer<typeof PaperConfigSchema>;
const receipt = { id: IdSchema, at: UtcTimestampSchema };
const market = {
  ...receipt,
  sourceId: IdSchema,
  providerEventId: IdSchema,
  symbol: SymbolSchema,
  observedAt: UtcTimestampSchema,
  providerAt: UtcTimestampSchema,
  providerEventAt: UtcTimestampSchema,
  rawHash: HashSchema,
  metadataHash: HashSchema,
};
export const PaperQuoteSchema = z.strictObject({
  ...market,
  kind: z.literal('QUOTE'),
  bid: PositiveDecimalSchema,
  ask: PositiveDecimalSchema,
  bidQuantity: NonNegativeDecimalSchema,
  askQuantity: NonNegativeDecimalSchema,
});
export type PaperQuote = z.infer<typeof PaperQuoteSchema>;
export const PaperEventSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...receipt,
    kind: z.literal('HEARTBEAT'),
    observedAt: UtcTimestampSchema.optional(),
    sourceId: IdSchema,
    licenseReviewHash: HashSchema,
    healthy: z.boolean(),
  }),
  z.strictObject({ ...receipt, kind: z.literal('RECONCILE') }),
  PaperQuoteSchema,
  z.strictObject({
    ...market,
    kind: z.literal('TRADE'),
    price: PositiveDecimalSchema,
    quantity: PositiveDecimalSchema,
    aggressor: z.enum(['BUY', 'SELL', 'UNKNOWN']),
  }),
  z.strictObject({
    ...receipt,
    kind: z.literal('PROPOSE'),
    decision: DecisionRecordSchema,
    orderType: z.enum(['MARKET', 'LIMIT']),
    limitPrice: PositiveDecimalSchema.nullable(),
  }),
  z.strictObject({
    ...receipt,
    kind: z.literal('CANCEL'),
    portfolio: PortfolioSchema,
    orderId: IdSchema,
    actor: IdSchema,
    reason: z.string().min(1).max(500),
  }),
  z.strictObject({
    ...receipt,
    kind: z.literal('CONTROL'),
    action: z.enum(['PAUSE', 'RESUME', 'KILL', 'STOP']),
    requestedAt: UtcTimestampSchema.optional(),
    actor: IdSchema,
    reason: z.string().min(1).max(500),
  }),
  z.strictObject({
    ...receipt,
    kind: z.literal('SAFETY'),
    code: z.enum([
      'MARKET_OUTAGE',
      'NEWS_OUTAGE',
      'NEWS_RESTORED',
      'TRADE_OUTAGE',
      'TRADE_RESTORED',
      'CLOCK_SKEW',
      'SOURCE_VALIDATION_FAILED',
      'LICENSE_CHANGED',
      'INVALID_METADATA',
      'QUARANTINED_FEED',
      'RECONCILIATION_FAILED',
    ]),
    sourceId: IdSchema,
    rawHash: HashSchema.nullable(),
  }),
  z.strictObject({ ...receipt, kind: z.literal('TICK') }),
]);
export type PaperEvent = z.infer<typeof PaperEventSchema>;
export const PaperLifecycleSchema = z.enum([
  'PROPOSED',
  'RISK_REJECTED',
  'ACCEPTED',
  'OPEN',
  'PARTIAL',
  'FILLED',
  'CANCELLED',
  'EXPIRED',
  'UNKNOWN',
]);
export const PaperOrderSchema = z.strictObject({
  order: SimulatedOrderSchema,
  lifecycle: PaperLifecycleSchema,
  decisionId: IdSchema,
  parentOrderId: IdSchema.nullable(),
  intentHash: HashSchema,
  filledQuantity: NonNegativeDecimalSchema,
  reservedCash: NonNegativeDecimalSchema,
  positionRemaining: NonNegativeDecimalSchema,
  queueAheadRemaining: NonNegativeDecimalSchema,
  rejectionReason: z.string().nullable(),
});
export type PaperOrder = z.infer<typeof PaperOrderSchema>;
export const PaperFillSchema = z.strictObject({
  fill: SimulatedFillSchema,
  journalIds: z.array(IdSchema).min(3),
  referencePrice: PositiveDecimalSchema,
  slippageCost: NonNegativeDecimalSchema,
  fidelity: z.enum(['OBSERVED_TOP_OF_BOOK_MODELED_SLIPPAGE', 'TRADE_THROUGH_ASSUMED_QUEUE']),
  trigger: z.enum(['STOP', 'TARGET']).nullable(),
  parentOrderId: IdSchema.nullable(),
  realizedNetPnl: DecimalStringSchema.nullable(),
  costBasisReleased: NonNegativeDecimalSchema,
});
export type PaperFill = z.infer<typeof PaperFillSchema>;
export const PaperEquitySchema = z.strictObject({
  portfolio: PortfolioSchema,
  at: UtcTimestampSchema,
  cash: NonNegativeDecimalSchema,
  equity: NonNegativeDecimalSchema.nullable(),
  holdingsValue: NonNegativeDecimalSchema.nullable(),
  realizedNetPnl: DecimalStringSchema,
  unrealizedNetPnl: DecimalStringSchema.nullable(),
  exposureFraction: NonNegativeDecimalSchema.nullable(),
  drawdownFraction: UnitDecimalSchema.nullable(),
  sourceQuoteIds: z.array(IdSchema).max(20),
});
export const PaperLogSchema = z.strictObject({
  schemaVersion: z.literal('paper-log.v1'),
  sequence: z.number().int().positive(),
  event: PaperEventSchema,
  previousHash: HashSchema,
  stateHash: HashSchema,
  hash: HashSchema,
});
export type PaperLog = z.infer<typeof PaperLogSchema>;
export const PaperReportSchema = z.strictObject({
  schemaVersion: z.literal('paper-report.v1'),
  execution: z.literal('SIMULATED'),
  liveExecution: z.literal('DISABLED'),
  config: PaperConfigSchema,
  configHash: HashSchema,
  status: z.enum(['RUNNING', 'PAUSED', 'KILLED', 'STOPPED']),
  now: UtcTimestampSchema,
  log: z.array(PaperLogSchema).max(200000),
  orders: z.array(PaperOrderSchema).max(10000),
  fills: z.array(PaperFillSchema).max(50000),
  decisions: z.array(DecisionRecordSchema).max(10000),
  journal: z.array(SpotJournalSchema).max(250000),
  balances: z.array(SpotBalanceSchema).max(84),
  equity: z.array(PaperEquitySchema).max(800000),
  alerts: z
    .array(
      z.strictObject({
        id: IdSchema,
        at: UtcTimestampSchema,
        code: IdSchema,
        sourceId: IdSchema.nullable(),
      }),
    )
    .max(200000),
  ledgerReconciled: z.literal(true),
  logHead: HashSchema,
});
export type PaperReport = z.infer<typeof PaperReportSchema>;
