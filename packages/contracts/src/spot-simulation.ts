import { z } from 'zod';
import {
  MarketBarSchema,
  SignalCandidateSchema,
  RiskDecisionSchema,
  SimulatedOrderSchema,
  SimulatedFillSchema,
} from './domain.js';
import { MarketDatasetSchema } from './market-data.js';
import {
  CurrencySchema,
  DecimalStringSchema,
  HashSchema,
  IdSchema,
  NonNegativeDecimalSchema,
  PositiveDecimalSchema,
  PortfolioSchema,
  SeedSchema,
  UnitDecimalSchema,
  UtcTimestampSchema,
  compareDecimal,
} from './primitives.js';

const feeCeiling = DecimalStringSchema.parse('0.1');
const bracket = z
  .strictObject({ stopLoss: PositiveDecimalSchema, takeProfit: PositiveDecimalSchema })
  .refine((v) => compareDecimal(v.stopLoss, v.takeProfit) < 0, 'Invalid protective levels');
export const SpotOrderIntentSchema = z
  .strictObject({
    clientOrderId: IdSchema,
    portfolio: PortfolioSchema,
    instrumentKey: IdSchema,
    side: z.enum(['BUY', 'SELL']),
    orderType: z.enum(['MARKET', 'LIMIT']),
    quantity: PositiveDecimalSchema,
    limitPrice: PositiveDecimalSchema.nullable(),
    marketPriceBound: PositiveDecimalSchema.nullable(),
    allowPartial: z.boolean(),
    expiresAt: UtcTimestampSchema,
    protection: bracket.nullable(),
  })
  .superRefine((v, c) => {
    if (
      (v.orderType === 'LIMIT') !== (v.limitPrice !== null) ||
      (v.orderType === 'MARKET') !== (v.marketPriceBound !== null)
    )
      c.addIssue({ code: 'custom', message: 'Explicit limit or market price bound required' });
    if (v.side === 'SELL' && v.protection !== null)
      c.addIssue({
        code: 'custom',
        message: 'Protection is attached only to purchased spot assets',
      });
  });
export type SpotOrderIntent = z.infer<typeof SpotOrderIntentSchema>;
const command = { id: IdSchema, at: UtcTimestampSchema, sequence: z.number().int().positive() };
export const SpotCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...command,
    kind: z.literal('SUBMIT'),
    intent: SpotOrderIntentSchema,
    candidate: SignalCandidateSchema,
    risk: RiskDecisionSchema,
  }),
  z.strictObject({
    ...command,
    kind: z.literal('CANCEL'),
    portfolio: PortfolioSchema,
    clientOrderId: IdSchema,
  }),
]);
export type SpotCommand = z.infer<typeof SpotCommandSchema>;
export const SpotSimulationInputSchema = z.strictObject({
  schemaVersion: z.literal('spot-simulation-input.v1'),
  market: MarketDatasetSchema,
  bars: z.array(MarketBarSchema).max(2000),
  commands: z.array(SpotCommandSchema).max(200),
});
export type SpotSimulationInput = z.infer<typeof SpotSimulationInputSchema>;
export const SpotSimulationRequestSchema = z
  .strictObject({
    schemaVersion: z.literal('spot-simulation-request.v1'),
    sourceId: IdSchema,
    venue: IdSchema,
    instrumentKeys: z.array(IdSchema).min(1).max(20),
    portfolios: z.array(PortfolioSchema).min(1).max(4),
    initialBalances: z
      .array(z.strictObject({ asset: CurrencySchema, amount: NonNegativeDecimalSchema }))
      .min(1)
      .max(21),
    quoteCurrency: CurrencySchema,
    startAt: UtcTimestampSchema,
    endAt: UtcTimestampSchema,
    generatedAt: UtcTimestampSchema,
    intervalSeconds: z.number().int().min(1).max(86400),
    latencyMs: z.number().int().min(0).max(60000),
    maxBarDelayMs: z.number().int().min(0).max(60000),
    makerRate: UnitDecimalSchema.refine((v) => compareDecimal(v, feeCeiling) <= 0),
    takerRate: UnitDecimalSchema.refine((v) => compareDecimal(v, feeCeiling) <= 0),
    spreadBps: NonNegativeDecimalSchema,
    slippageBps: NonNegativeDecimalSchema,
    quoteScale: z.number().int().min(0).max(18),
    participationFraction: UnitDecimalSchema.refine((v) => v !== '0'),
    randomSeed: SeedSchema,
    marketType: z.literal('SPOT'),
    derivatives: z.literal('DISABLED'),
    leverage: z.literal('1'),
    allowShort: z.literal(false),
    fillPolicy: z.literal('FULL_WINDOW_ADVERSE_MARKET_STRICT_LIMIT_V1'),
    ambiguityPolicy: z.literal('STOP_FIRST_ADVERSE'),
    partialPolicy: z.literal('SHARED_VOLUME_CAP'),
  })
  .superRefine((v, c) => {
    if (v.startAt >= v.endAt || v.generatedAt < v.endAt)
      c.addIssue({ code: 'custom', message: 'Invalid simulation period' });
    for (const list of [v.instrumentKeys, v.portfolios, v.initialBalances.map((b) => b.asset)])
      if (new Set(list).size !== list.length)
        c.addIssue({ code: 'custom', message: 'Duplicate simulation configuration' });
    if (
      Number(v.spreadBps) > 1000 ||
      Number(v.slippageBps) > 1000 ||
      Number(v.participationFraction) <= 0
    )
      c.addIssue({ code: 'custom', message: 'Invalid execution cost or participation bound' });
    if (!v.initialBalances.some((b) => b.asset === v.quoteCurrency))
      c.addIssue({ code: 'custom', message: 'Quote balance required' });
  });
export type SpotSimulationRequest = z.infer<typeof SpotSimulationRequestSchema>;
export const SpotBalanceSchema = z.strictObject({
  portfolio: PortfolioSchema,
  asset: CurrencySchema,
  free: NonNegativeDecimalSchema,
  reserved: NonNegativeDecimalSchema,
});
export type SpotBalance = z.infer<typeof SpotBalanceSchema>;
export const SpotPostingSchema = z.strictObject({
  portfolio: PortfolioSchema,
  asset: CurrencySchema,
  account: z.enum(['FREE', 'RESERVED', 'EXTERNAL', 'FEES']),
  amount: DecimalStringSchema,
});
export type SpotPosting = z.infer<typeof SpotPostingSchema>;
export const SpotJournalSchema = z.strictObject({
  schemaVersion: z.literal('spot-journal.v1'),
  sequence: z.number().int().positive(),
  id: IdSchema,
  at: UtcTimestampSchema,
  kind: z.enum(['DEPOSIT', 'RESERVE', 'RELEASE', 'TRADE', 'FEE']),
  orderId: IdSchema.nullable(),
  fillId: IdSchema.nullable(),
  postings: z.array(SpotPostingSchema).min(2).max(8),
  balancesAfter: z.array(SpotBalanceSchema).max(84),
  previousHash: HashSchema,
  hash: HashSchema,
});
export type SpotJournal = z.infer<typeof SpotJournalSchema>;
export const SpotOrderSchema = z.strictObject({
  order: SimulatedOrderSchema,
  intent: SpotOrderIntentSchema,
  metadataId: IdSchema.nullable(),
  filledQuantity: NonNegativeDecimalSchema,
  remainingQuantity: NonNegativeDecimalSchema,
  reservedAsset: CurrencySchema,
  reservedAmount: NonNegativeDecimalSchema,
  rejectionReason: z.string().nullable(),
  parentOrderId: IdSchema.nullable(),
  protection: z
    .strictObject({
      stopLoss: PositiveDecimalSchema,
      takeProfit: PositiveDecimalSchema,
      triggeredStop: z.boolean(),
      triggerBarIds: z.array(IdSchema).max(2000),
    })
    .nullable(),
});
export type SpotOrder = z.infer<typeof SpotOrderSchema>;
export const SpotFillTraceSchema = z.strictObject({
  fill: SimulatedFillSchema,
  barId: IdSchema,
  metadataIds: z.array(IdSchema).min(1),
  referencePrice: PositiveDecimalSchema,
  flags: z.array(z.string()),
  trigger: z.enum(['STOP', 'TARGET']).nullable(),
  journalIds: z.array(IdSchema).min(3),
});
export type SpotFillTrace = z.infer<typeof SpotFillTraceSchema>;
export const SpotTraceSchema = z.strictObject({
  sequence: z.number().int().positive(),
  at: UtcTimestampSchema,
  kind: z.enum(['SUBMIT', 'CANCEL', 'BAR', 'EXPIRY', 'FINALIZE']),
  recordId: IdSchema,
  reason: z.string(),
  orderIds: z.array(IdSchema),
  fillIds: z.array(IdSchema),
  balancesHash: HashSchema,
  journalHead: HashSchema,
});
export type SpotTrace = z.infer<typeof SpotTraceSchema>;
export const SpotSimulationArtifactSchema = z.strictObject({
  schemaVersion: z.literal('spot-simulation-artifact.v1'),
  execution: z.literal('SIMULATED'),
  liveExecution: z.literal('DISABLED'),
  algorithmVersion: z.literal('spot-execution.v1'),
  codeVersion: z.string().min(1).max(200),
  input: SpotSimulationInputSchema,
  request: SpotSimulationRequestSchema,
  inputHash: HashSchema,
  configHash: HashSchema,
  runId: IdSchema,
  randomAlgorithm: z.literal('mulberry32.v1'),
  orders: z.array(SpotOrderSchema).max(2000),
  fills: z.array(SpotFillTraceSchema).max(5000),
  journal: z.array(SpotJournalSchema).max(25000),
  trace: z.array(SpotTraceSchema).max(10000),
  balances: z.array(SpotBalanceSchema).max(84),
  excludedBars: z.array(z.strictObject({ recordId: IdSchema, reason: z.string() })).max(2000),
  reconciliation: z.strictObject({
    balanced: z.literal(true),
    nonnegative: z.literal(true),
    reservationsMatch: z.literal(true),
    uniqueFills: z.literal(true),
    journalHash: HashSchema,
    fillsHash: HashSchema,
    balancesHash: HashSchema,
  }),
});
export type SpotSimulationArtifact = z.infer<typeof SpotSimulationArtifactSchema>;
