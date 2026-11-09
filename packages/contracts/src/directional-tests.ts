import { z } from 'zod';
import {
  HashSchema,
  DecimalStringSchema as Decimal,
  NonNegativeDecimalSchema as NonNegative,
  PositiveDecimalSchema as Positive,
} from './primitives.js';
import {
  MarketAssetSchema,
  MarketFeeModeSchema,
  MarketHistorySchema,
  MarketReportSchema,
  MarketSummarySchema,
} from './market-tests.js';
import { SpecialistCandidateSchema, SpecialistReportSchema } from './specialist-tests.js';
import {
  SpecialistV5CandidateSchema,
  SpecialistV5KeySchema,
  SpecialistV5FeesSchema,
  SpecialistV5ReportSchema,
} from './specialist-v5.js';
export const DirectionModeSchema = z.enum(['LONG_ONLY', 'SHORT_ONLY', 'LONG_SHORT']);
export type DirectionMode = z.infer<typeof DirectionModeSchema>;
export const DirectionProfileSchema = z
  .strictObject({
    asset: MarketAssetSchema,
    strategy: SpecialistV5KeySchema,
    candidate: z.union([SpecialistCandidateSchema, SpecialistV5CandidateSchema]).optional(),
  })
  .refine(
    (p) =>
      p.strategy === 'V4' || p.strategy === 'V5'
        ? p.candidate?.asset === p.asset &&
          (p.strategy === 'V4' ? SpecialistCandidateSchema : SpecialistV5CandidateSchema).safeParse(
            p.candidate,
          ).success
        : !p.candidate,
    'Specialist profiles must retain their original coin',
  );
export type DirectionProfile = z.infer<typeof DirectionProfileSchema>;
export const SHORT_ASSUMPTIONS = Object.freeze({
  model: 'HYPOTHETICAL_COLLATERALIZED_SPOT_BORROW' as const,
  borrowAvailability: 'ASSUMED_NOT_HISTORICALLY_VERIFIED' as const,
  annualBorrowRate: '0.1' as const,
  borrowClock: 'ENTRY_NOTIONAL_USDT_SIMPLE_ACTUAL_365_FULL_EXIT_CANDLE' as const,
  collateralRatio: '1' as const,
  maintenanceFraction: '0.005' as const,
  estimatedHoldHours: 24,
  feeRate: '0.001' as const,
  slippageRate: '0.0005' as const,
  initialUsdt: '10000' as const,
  riskFraction: '0.0025' as const,
  maxAllocation: '0.1' as const,
  maxVolumeFraction: '0.01' as const,
  dailyLossFraction: '0.02' as const,
});
export const DirectionSideSchema = z.enum(['LONG', 'SHORT']);
const Account = z.enum(['FREE', 'RESERVED', 'PROCEEDS', 'DEBT', 'EXTERNAL', 'FEES', 'FINANCING']);
export const MarginPostingSchema = z.strictObject({
  asset: z.union([MarketAssetSchema, z.literal('USDT')]),
  account: Account,
  amount: Decimal,
});
export const MarginJournalSchema = z.strictObject({
  sequence: z.number().int().positive(),
  at: z.number().int(),
  kind: z.enum(['DEPOSIT', 'OPEN', 'CLOSE', 'FINANCING', 'DEFAULT']),
  postings: z.array(MarginPostingSchema).min(2).max(20),
  balances: z.record(z.string(), Decimal),
  previousHash: HashSchema,
  hash: HashSchema,
});
export type MarginJournal = z.infer<typeof MarginJournalSchema>;
export const DirectionDecisionSchema = z.strictObject({
  index: z.number().int(),
  at: z.number().int(),
  action: z.enum(['WARMUP', 'LONG', 'SHORT', 'EXIT', 'HOLD', 'HALTED']),
  reason: z.string(),
  fast: Positive.nullable(),
  slow: Positive.nullable(),
  atr: NonNegative.nullable(),
  trend: Positive.nullable(),
  trendRising: z.boolean().nullable(),
  positionSide: DirectionSideSchema.nullable(),
  position: Decimal,
  quantity: NonNegative,
  stop: Positive.nullable(),
  target: Positive.nullable(),
  targetAtr: Positive,
  signalRangeAtr: NonNegative.nullable(),
  closeLocation: NonNegative.nullable(),
  longGate: z.string(),
  shortGate: z.string(),
  cash: NonNegative,
  collateral: NonNegative,
  loan: NonNegative,
  badDebt: NonNegative,
  equity: Decimal,
  buyHold: NonNegative,
  financing: NonNegative,
});
export const DirectionTradeSchema = z.strictObject({
  index: z.number().int(),
  at: z.number().int(),
  kind: z.enum(['OPEN', 'CLOSE']),
  direction: DirectionSideSchema,
  side: z.enum(['BUY', 'SELL']),
  quantity: Positive,
  price: Positive,
  fee: NonNegative,
  slippage: NonNegative,
  financing: NonNegative,
  net: Decimal.nullable(),
  reason: z.string(),
  stop: Positive,
  target: Positive,
});
const SideSummary = z.strictObject({
  closedTrades: z.number().int().nonnegative(),
  wins: z.number().int().nonnegative(),
  net: Decimal,
});
export const DirectionSummarySchema = z.strictObject({
  ...MarketSummarySchema.shape,
  finalEquity: Decimal,
  openBase: Decimal,
  financing: NonNegative,
  collateral: NonNegative,
  loan: NonNegative,
  badDebt: NonNegative,
  insolvent: z.boolean(),
  long: SideSummary,
  short: SideSummary,
  openContribution: Decimal,
});
export const DirectionReportSchema = z
  .strictObject({
    version: z.literal('directional-replay.v1'),
    asset: MarketAssetSchema,
    symbol: z.string(),
    datasetId: HashSchema,
    engineHash: HashSchema,
    planHash: HashSchema,
    origin: z.enum(['PUBLIC_HISTORICAL', 'SYNTHETIC']),
    interpretation: z.literal('SPOT_PRICE_PROXY_WITH_ASSUMED_BORROW_NOT_FORWARD_VERIFIED'),
    plan: z.strictObject({
      profile: DirectionProfileSchema,
      mode: DirectionModeSchema,
      feeMode: MarketFeeModeSchema,
      assumptions: z.custom<typeof SHORT_ASSUMPTIONS>(
        (v) =>
          !!v &&
          typeof v === 'object' &&
          Object.keys(v).length === Object.keys(SHORT_ASSUMPTIONS).length &&
          Object.entries(SHORT_ASSUMPTIONS).every(
            ([k, value]) => (v as Record<string, unknown>)[k] === value,
          ),
      ),
    }),
    decisions: z.array(DirectionDecisionSchema).min(100).max(6000),
    trades: z.array(DirectionTradeSchema).max(18000),
    summary: DirectionSummarySchema,
    journalHash: HashSchema,
  })
  .refine(
    (r) => r.asset === r.plan.profile.asset && r.symbol === r.asset + 'USDT',
    'Report instrument mismatch',
  );
export type DirectionReport = z.infer<typeof DirectionReportSchema>;
export const DirectionCellSchema = z.strictObject({
  asset: MarketAssetSchema,
  strategy: SpecialistV5KeySchema,
  mode: DirectionModeSchema,
  feeMode: MarketFeeModeSchema,
  reportId: HashSchema,
  legacy: z.boolean(),
  summary: z.union([DirectionSummarySchema, MarketSummarySchema]),
});
export const DirectionMatrixSchema = z
  .strictObject({
    version: z.literal('directional-matrix.v1'),
    engineHash: HashSchema,
    sourceMarketMatrixId: HashSchema,
    sourceSpecialistMatrixId: HashSchema,
    generatedAt: z.string().datetime(),
    from: z.number().int(),
    to: z.number().int(),
    initialUsdt: z.literal('10000'),
    assumptions: z.custom<typeof SHORT_ASSUMPTIONS>(
      (v) =>
        !!v &&
        typeof v === 'object' &&
        Object.keys(v).length === Object.keys(SHORT_ASSUMPTIONS).length &&
        Object.entries(SHORT_ASSUMPTIONS).every(
          ([k, value]) => (v as Record<string, unknown>)[k] === value,
        ),
    ),
    profiles: z.array(DirectionProfileSchema).length(34),
    datasetIds: z.record(MarketAssetSchema, HashSchema),
    cells: z.array(DirectionCellSchema).length(204),
  })
  .refine(
    (m) =>
      new Set(m.cells.map((c) => `${c.asset}/${c.strategy}/${c.mode}/${c.feeMode}`)).size === 204 &&
      m.profiles.every((p) =>
        ['LONG_ONLY', 'SHORT_ONLY', 'LONG_SHORT'].every((mode) =>
          ['STANDARD', 'ZERO'].every((f) =>
            m.cells.some(
              (c) =>
                c.asset === p.asset &&
                c.strategy === p.strategy &&
                c.mode === mode &&
                c.feeMode === f,
            ),
          ),
        ),
      ),
    'Every profile requires all three direction modes and both fee modes',
  );
export type DirectionMatrix = z.infer<typeof DirectionMatrixSchema>;
export const DirectionJobSchema = z.strictObject({
  id: z.string().uuid(),
  status: z.enum(['RUNNING', 'DONE', 'FAILED']),
  completed: z.number().int().min(0).max(34),
  total: z.literal(34),
  message: z.string(),
});
export const DirectionStateSchema = z.strictObject({
  matrixId: HashSchema.nullable(),
  job: DirectionJobSchema.nullable(),
  fees: SpecialistV5FeesSchema,
});
export const DirectionSelectionSchema = z
  .strictObject({
    asset: MarketAssetSchema,
    strategy: SpecialistV5KeySchema,
    mode: DirectionModeSchema,
  })
  .refine(
    (s) => !['V4', 'V5'].includes(s.strategy) || ['SOL', 'XRP'].includes(s.asset),
    'V4/V5 only exist for SOL and XRP',
  );
export const DirectionViewSchema = z.strictObject({
  id: HashSchema,
  report: z.union([
    DirectionReportSchema,
    MarketReportSchema,
    SpecialistReportSchema,
    SpecialistV5ReportSchema,
  ]),
  bars: MarketHistorySchema.shape.bars,
  sources: z.array(MarketHistorySchema.shape.instrument.shape.metadata.omit({ body: true })).max(9),
});
