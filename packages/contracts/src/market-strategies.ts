import { z } from 'zod';
import { EventStudySeriesSchema } from './event-study.js';
import { MarketDatasetSchema } from './market-data.js';
import { BacktestManifestSchema, BacktestOutcomeSchema, BacktestBundleSchema } from './backtest.js';
import { ReplayArtifactSchema } from './replay.js';
import {
  DecimalStringSchema,
  HashSchema,
  IdSchema,
  NonNegativeDecimalSchema,
  PositiveDecimalSchema,
  PortfolioSchema,
  UtcTimestampSchema,
  compareDecimal,
} from './primitives.js';
const common = {
  schemaVersion: z.literal('market-strategy-config.v1'),
  minimumBaseVolume: NonNegativeDecimalSchema,
  staleAfterSeconds: z.number().int().min(1).max(86400),
  maxHoldingBars: z.number().int().min(1).max(128),
  cooldownBars: z.number().int().min(0).max(32),
  onMissing: z.enum(['HOLD', 'EXIT']),
  signalValiditySeconds: z.number().int().min(1).max(86400),
};
const averages = {
  fastPeriod: z.number().int().min(1).max(63),
  slowPeriod: z.number().int().min(2).max(64),
  average: z.enum(['SMA', 'EMA']),
};
export const MarketStrategyConfigSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({ ...common, kind: z.literal('CASH') }),
    z.strictObject({ ...common, kind: z.literal('BUY_AND_HOLD') }),
    z.strictObject({ ...common, ...averages, kind: z.literal('MA_CROSSOVER') }),
    z.strictObject({ ...common, ...averages, kind: z.literal('SYMMETRIC_MA_FIXTURE') }),
    z.strictObject({
      ...common,
      kind: z.literal('BREAKOUT'),
      lookbackBars: z.number().int().min(2).max(64),
      exitLookbackBars: z.number().int().min(1).max(64),
      entryBufferBps: NonNegativeDecimalSchema,
    }),
    z.strictObject({
      ...common,
      kind: z.literal('ZSCORE_REVERSION'),
      lookbackBars: z.number().int().min(2).max(64),
      entryThreshold: PositiveDecimalSchema,
      exitThreshold: NonNegativeDecimalSchema,
    }),
  ])
  .superRefine((v, c) => {
    if (
      ('fastPeriod' in v && v.fastPeriod >= v.slowPeriod) ||
      ('exitLookbackBars' in v && v.exitLookbackBars > v.lookbackBars) ||
      ('entryThreshold' in v && compareDecimal(v.exitThreshold, v.entryThreshold) >= 0) ||
      ('entryBufferBps' in v && Number(v.entryBufferBps) > 1000)
    )
      c.addIssue({ code: 'custom', message: 'Invalid strategy periods or thresholds' });
  });
export type MarketStrategyConfig = z.infer<typeof MarketStrategyConfigSchema>;
export const MarketStrategySourceSchema = z.strictObject({
  schemaVersion: z.literal('market-strategy-source.v1'),
  market: MarketDatasetSchema,
  sourceId: IdSchema,
  instrumentKey: IdSchema,
  series: EventStudySeriesSchema,
  portfolio: PortfolioSchema,
  intervalSeconds: z.number().int().min(1).max(86400),
  historyStartCloseAt: UtcTimestampSchema,
  maxBarDelayMs: z.number().int().min(0).max(60000),
});
export type MarketStrategySource = z.infer<typeof MarketStrategySourceSchema>;
export const MarketPositionSchema = z.enum(['FLAT', 'LONG', 'SHORT']);
export const MarketDecisionSchema = z
  .strictObject({
    schemaVersion: z.literal('market-decision.v1'),
    featureAsOf: UtcTimestampSchema,
    closeAt: UtcTimestampSchema,
    action: z.enum(['HOLD', 'ENTER_LONG', 'EXIT_LONG', 'ENTER_SHORT', 'EXIT_SHORT']),
    previous: MarketPositionSchema,
    target: MarketPositionSchema,
    reason: z.string().min(1).max(100),
    inputBarIds: z.array(IdSchema).max(128),
    inputMetadataIds: z.array(IdSchema).max(1000),
    maxInputAvailableAt: UtcTimestampSchema,
    maxInputCloseAt: UtcTimestampSchema,
    features: z
      .array(
        z.strictObject({
          name: IdSchema,
          value: DecimalStringSchema.nullable(),
          status: z.string(),
          definitionHash: HashSchema,
        }),
      )
      .max(4),
    featureFingerprint: HashSchema,
  })
  .superRefine((v, c) => {
    if (
      v.maxInputAvailableAt > v.featureAsOf ||
      v.maxInputCloseAt > v.featureAsOf ||
      v.closeAt > v.featureAsOf
    )
      c.addIssue({ code: 'custom', message: 'Market decision contains future inputs' });
  });
export type MarketDecision = z.infer<typeof MarketDecisionSchema>;
export const MarketStrategyStateSchema = z.strictObject({
  schemaVersion: z.literal('market-strategy-state.v1'),
  providerHash: HashSchema,
  position: MarketPositionSchema,
  lastCloseAt: UtcTimestampSchema.nullable(),
  previousRelation: z.number().int().min(-1).max(1).nullable(),
  heldBars: z.number().int().min(0).max(10000),
  cooldown: z.number().int().min(0).max(32),
  lastDecision: MarketDecisionSchema.nullable(),
});
export type MarketStrategyState = z.infer<typeof MarketStrategyStateSchema>;
export const MarketSizingQuerySchema = z.strictObject({
  schemaVersion: z.literal('market-target-sizing.v1'),
  target: z.enum(['FLAT', 'LONG']),
  fixedQuantity: PositiveDecimalSchema,
  heldQuantity: NonNegativeDecimalSchema,
  quantityStep: PositiveDecimalSchema,
});
export const MarketSizingResultSchema = z.strictObject({
  policy: z.literal('FIXED_TARGET_QUANTITY_NO_LEVERAGE_V1'),
  side: z.enum(['BUY', 'SELL', 'NONE']),
  quantity: NonNegativeDecimalSchema,
  targetQuantity: NonNegativeDecimalSchema,
  heldQuantity: NonNegativeDecimalSchema,
});
export const MarketBaselineManifestSchema = z
  .strictObject({
    schemaVersion: z.literal('market-baseline-manifest.v1'),
    backtest: BacktestManifestSchema,
    provider: MarketStrategyConfigSchema,
    historyStartCloseAt: UtcTimestampSchema,
    regime: z.enum(['TREND', 'WHIPSAW', 'REVERSAL', 'EXPLICIT_INPUT']),
    bridge: z.literal('POST_RECEIPT_TARGET_NO_RETRY_V1'),
  })
  .superRefine((v, c) => {
    if (
      v.backtest.scenarios.length ||
      v.backtest.input.replay.news.length ||
      v.backtest.input.replay.bars.length > 128 ||
      v.historyStartCloseAt > v.backtest.calendar.firstCloseAt ||
      v.backtest.strategy.requiredFields.length !== 1 ||
      v.backtest.strategy.requiredFields[0] !== 'CLOSED_OHLCV'
    )
      c.addIssue({
        code: 'custom',
        message: 'Market baseline requires bounded market-only input and one base execution case',
      });
  });
export type MarketBaselineManifest = z.infer<typeof MarketBaselineManifestSchema>;
export const MarketSizingAuditSchema = z.strictObject({
  candidateId: IdSchema,
  decisionAt: UtcTimestampSchema,
  placementAt: UtcTimestampSchema,
  target: z.enum(['FLAT', 'LONG']),
  heldQuantity: NonNegativeDecimalSchema,
  quantity: NonNegativeDecimalSchema,
  side: z.enum(['BUY', 'SELL', 'NONE']),
  reason: z.enum([
    'SUBMIT',
    'TARGET_ALREADY_MET',
    'WAIT_PENDING',
    'NO_RETRY_SAME_TARGET',
    'BELOW_LOT',
    'END_OF_WINDOW',
    'INELIGIBLE_METADATA',
  ]),
  prefixHash: HashSchema.nullable(),
  commandIds: z.array(IdSchema),
});
export type MarketSizingAudit = z.infer<typeof MarketSizingAuditSchema>;
export const MarketBaselineReportSchema = z.strictObject({
  schemaVersion: z.literal('market-baseline-report.v1'),
  execution: z.literal('SIMULATED'),
  liveExecution: z.literal('DISABLED'),
  codeVersion: z.string().min(1).max(200),
  manifest: MarketBaselineManifestSchema,
  manifestHash: HashSchema,
  providerHash: HashSchema,
  featureFingerprint: HashSchema,
  outcomes: z.array(BacktestOutcomeSchema).length(3),
  sizing: z
    .array(
      z.strictObject({
        role: z.enum(['STRATEGY', 'CASH', 'BUY_AND_HOLD']),
        decisions: z.array(MarketSizingAuditSchema).max(128),
      }),
    )
    .length(3),
  warnings: z.array(z.string()),
});
export type MarketBaselineReport = z.infer<typeof MarketBaselineReportSchema>;
export const MarketFixtureSignalsSchema = z.strictObject({
  schemaVersion: z.literal('market-fixture-signals.v1'),
  execution: z.literal('DISABLED'),
  manifest: MarketBaselineManifestSchema,
  source: MarketStrategySourceSchema,
  config: MarketStrategyConfigSchema,
  replay: ReplayArtifactSchema,
});
export const MarketArtifactSchema = z.union([
  MarketBaselineReportSchema,
  MarketFixtureSignalsSchema,
]);
export const MarketBundleSchema = BacktestBundleSchema.extend({
  schemaVersion: z.literal('market-baseline-bundle.v1'),
});
