import { z } from 'zod';
import { ReplayInputSchema, ReplayArtifactSchema, ReplayStateSchema } from './replay.js';
import { SpotSimulationRequestSchema, SpotSimulationArtifactSchema } from './spot-simulation.js';
import { MarketDatasetSchema } from './market-data.js';
import { EventStudySeriesSchema } from './event-study.js';
import {
  DecimalStringSchema,
  HashSchema,
  IdSchema,
  NonNegativeDecimalSchema,
  PositiveDecimalSchema,
  UtcTimestampSchema,
} from './primitives.js';

export const BacktestFieldsSchema = z.enum([
  'CLOSED_OHLCV',
  'TIMED_NEWS',
  'ORDER_BOOK_DEPTH',
  'FUNDING_RATE',
]);
export const ExecutionAssumptionsSchema = z.strictObject({
  schemaVersion: z.literal('execution-assumptions.v1'),
  declaredAt: UtcTimestampSchema,
  policy: SpotSimulationRequestSchema,
});
export const BacktestScenarioSchema = z.strictObject({
  id: IdSchema,
  overrides: z.strictObject({
    makerRate: SpotSimulationRequestSchema.shape.makerRate.optional(),
    takerRate: SpotSimulationRequestSchema.shape.takerRate.optional(),
    spreadBps: SpotSimulationRequestSchema.shape.spreadBps.optional(),
    slippageBps: SpotSimulationRequestSchema.shape.slippageBps.optional(),
    latencyMs: SpotSimulationRequestSchema.shape.latencyMs.optional(),
  }),
  omittedBarIds: z.array(IdSchema).max(2000),
});
export const BacktestManifestSchema = z
  .strictObject({
    schemaVersion: z.literal('backtest-manifest.v1'),
    input: z.strictObject({
      schemaVersion: z.literal('backtest-input.v1'),
      market: MarketDatasetSchema,
      replay: ReplayInputSchema,
    }),
    inputHash: HashSchema,
    assumptions: ExecutionAssumptionsSchema,
    strategy: z.strictObject({
      id: IdSchema,
      version: z.literal('1'),
      config: ReplayStateSchema,
      requiredFields: z.array(BacktestFieldsSchema).max(4),
    }),
    series: EventStudySeriesSchema,
    quantity: PositiveDecimalSchema,
    buyPriceCap: PositiveDecimalSchema,
    sellPriceFloor: PositiveDecimalSchema,
    maxOrderNotional: PositiveDecimalSchema,
    orderLifetimeSeconds: z.number().int().min(1).max(86400),
    calendar: z.strictObject({ firstCloseAt: UtcTimestampSchema }),
    maxMarkAgeMs: z.number().int().min(0).max(86400000),
    cohortDisclosure: z.string().min(1).max(2000),
    scenarios: z.array(BacktestScenarioSchema).max(6),
  })
  .superRefine((m, c) => {
    const p = m.assumptions.policy;
    if (
      m.assumptions.declaredAt > p.startAt ||
      p.instrumentKeys.length !== 1 ||
      p.portfolios.length !== 1 ||
      p.portfolios[0] !== 'BASELINE' ||
      m.series.marketType !== 'SPOT' ||
      m.series.exchange !== p.venue ||
      m.series.instrumentId !== `${m.series.asset}/${p.quoteCurrency}`
    )
      c.addIssue({
        code: 'custom',
        message: 'Backtest requires predeclared single-asset spot/BASELINE assumptions',
      });
    if (m.calendar.firstCloseAt <= p.startAt || m.calendar.firstCloseAt >= p.endAt)
      c.addIssue({ code: 'custom', message: 'Invalid predeclared close calendar' });
    if (
      !p.initialBalances.some((b) => b.asset === p.quoteCurrency && Number(b.amount) > 0) ||
      p.initialBalances.some((b) => b.asset !== p.quoteCurrency && Number(b.amount) !== 0)
    )
      c.addIssue({
        code: 'custom',
        message: 'Backtest starts in positive cash with no seeded positions',
      });
    if (
      new Set(m.strategy.requiredFields).size !== m.strategy.requiredFields.length ||
      new Set(m.scenarios.map((s) => s.id)).size !== m.scenarios.length ||
      m.scenarios.some(
        (s) => s.id === 'BASE' || new Set(s.omittedBarIds).size !== s.omittedBarIds.length,
      )
    )
      c.addIssue({
        code: 'custom',
        message: 'Duplicate fields/scenarios/omissions or reserved scenario ID',
      });
  });
export type BacktestManifest = z.infer<typeof BacktestManifestSchema>;
export const EquityPointSchema = z.strictObject({
  at: UtcTimestampSchema,
  cutoff: z.literal('END_OF_TIMESTAMP_DELIVERED_EVENTS'),
  cash: NonNegativeDecimalSchema,
  quantity: NonNegativeDecimalSchema,
  mark: PositiveDecimalSchema.nullable(),
  markBarId: IdSchema.nullable(),
  markAvailableAt: UtcTimestampSchema.nullable(),
  equity: NonNegativeDecimalSchema.nullable(),
  exposureFraction: NonNegativeDecimalSchema.nullable(),
  reason: z.enum(['KNOWN', 'NO_POSITION', 'MISSING_OR_STALE_MARK']),
});
export const BacktestTradeSchema = z.strictObject({
  id: IdSchema,
  buyFillId: IdSchema,
  sellFillId: IdSchema,
  openedAt: UtcTimestampSchema,
  closedAt: UtcTimestampSchema,
  quantity: PositiveDecimalSchema,
  entryPrice: PositiveDecimalSchema,
  exitPrice: PositiveDecimalSchema,
  grossPnl: DecimalStringSchema,
  entryFees: NonNegativeDecimalSchema,
  exitFees: NonNegativeDecimalSchema,
  netPnl: DecimalStringSchema,
});
export type BacktestTrade = z.infer<typeof BacktestTradeSchema>;
export const BacktestMetricsSchema = z.strictObject({
  initialEquity: PositiveDecimalSchema,
  terminalEquity: NonNegativeDecimalSchema.nullable(),
  grossPnl: DecimalStringSchema.nullable(),
  netPnl: DecimalStringSchema.nullable(),
  grossReturn: DecimalStringSchema.nullable(),
  netReturn: DecimalStringSchema.nullable(),
  fees: NonNegativeDecimalSchema,
  feeDragReturn: NonNegativeDecimalSchema,
  maxDrawdownFraction: NonNegativeDecimalSchema.nullable(),
  maxExposureFraction: NonNegativeDecimalSchema.nullable(),
  timeInMarketFraction: NonNegativeDecimalSchema,
  turnoverNotional: NonNegativeDecimalSchema,
  turnoverFraction: NonNegativeDecimalSchema,
  fillCount: z.number().int().nonnegative(),
  closedLotCount: z.number().int().nonnegative(),
  rejectedOrders: z.number().int().nonnegative(),
  unknownEquityPoints: z.number().int().nonnegative(),
});
export const BacktestOutcomeSchema = z.strictObject({
  role: z.enum(['STRATEGY', 'CASH', 'BUY_AND_HOLD']),
  replay: ReplayArtifactSchema,
  simulation: SpotSimulationArtifactSchema,
  equity: z.array(EquityPointSchema).max(10000),
  trades: z.array(BacktestTradeSchema).max(10000),
  metrics: BacktestMetricsSchema,
  fillFingerprint: HashSchema,
  skips: z.array(z.strictObject({ reason: z.string(), count: z.number().int().nonnegative() })),
  unknownMarketDepth: z.literal(true),
});
export type BacktestOutcome = z.infer<typeof BacktestOutcomeSchema>;
export const BacktestCaseSchema = z.strictObject({
  id: IdSchema,
  assumptions: ExecutionAssumptionsSchema,
  assumptionsHash: HashSchema,
  effectiveInputHash: HashSchema,
  omittedBarIds: z.array(IdSchema),
  missingCloseTimes: z.array(UtcTimestampSchema).max(2000),
  outcomes: z.array(BacktestOutcomeSchema).length(3),
  feeCheck: z.enum([
    'BASE',
    'NOT_HIGHER_FEE_ONLY',
    'CHANGED_EXECUTION_OR_UNKNOWN_MARKS',
    'IDENTICAL_GROSS_NET_NONINCREASING',
  ]),
});
export type BacktestCase = z.infer<typeof BacktestCaseSchema>;
export const BacktestReportSchema = z.strictObject({
  schemaVersion: z.literal('backtest-report.v1'),
  execution: z.literal('SIMULATED'),
  liveExecution: z.literal('DISABLED'),
  algorithmVersion: z.literal('backtest-controls.v1'),
  codeVersion: z.string().min(1).max(200),
  manifest: BacktestManifestSchema,
  manifestHash: HashSchema,
  runId: IdSchema,
  cases: z.array(BacktestCaseSchema).min(1).max(7),
  clockSemantics: z.literal('utc-nanoseconds.v1'),
  randomAlgorithm: z.literal('mulberry32.v1'),
  valuationPolicy: z.literal('AVAILABLE_CLOSE_NO_FORWARD_FILL_BEYOND_AGE_V1'),
  tradePolicy: z.literal('FIFO_FEE_ALLOCATION_V1'),
  warnings: z.array(z.string()),
});
export type BacktestReport = z.infer<typeof BacktestReportSchema>;
export const BacktestBundleSchema = z.strictObject({
  schemaVersion: z.literal('backtest-bundle.v1'),
  id: IdSchema,
  reportHash: HashSchema,
  manifestHash: HashSchema,
  files: z.strictObject({
    reportJson: HashSchema,
    reportMarkdown: HashSchema,
    manifestJson: HashSchema,
  }),
});
