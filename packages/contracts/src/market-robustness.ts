import { z } from 'zod';
import { MarketBaselineManifestSchema, MarketStrategyConfigSchema } from './market-strategies.js';
import { MarketMlModelSchema } from './market-ml.js';
import { BacktestMetricsSchema, BacktestOutcomeSchema } from './backtest.js';
import { HashSchema, IdSchema, UtcTimestampSchema, SeedSchema } from './primitives.js';
export const RobustTrialSchema = z
  .strictObject({
    id: IdSchema,
    family: z.enum(['MA', 'BREAKOUT', 'REVERSION', 'ML']),
    change: z.enum(['BASE', 'PARAMETER', 'FEATURE_ABLATION', 'HORIZON_VERSION']),
    parentTrialId: IdSchema.nullable(),
    provider: MarketStrategyConfigSchema.nullable(),
    modelId: IdSchema.nullable(),
  })
  .refine(
    (v) => (v.provider === null) !== (v.modelId === null),
    'Exactly one registered producer is required',
  );
export const RobustScenarioSchema = z.strictObject({
  id: IdSchema,
  asset: z.enum(['BTC', 'ETH', 'SOL']),
  regime: z.enum(['TREND', 'WHIPSAW', 'REVERSAL']),
  stress: z.enum(['BASE', 'HIGH_COST', 'VOLATILITY_SHIFT', 'COST_AND_VOLATILITY']),
  parentScenarioId: IdSchema.nullable(),
  manifest: MarketBaselineManifestSchema,
});
export const MarketRobustnessPlanSchema = z
  .strictObject({
    schemaVersion: z.literal('market-robustness-plan.v1'),
    experimentVersion: z.string().min(1).max(100),
    parentReportHash: HashSchema.nullable(),
    priorTrialCount: z.number().int().min(0).max(100000),
    priorDisclosure: z.string().min(1).max(2000),
    declaredAt: UtcTimestampSchema,
    generatedAt: UtcTimestampSchema,
    randomSeed: SeedSchema,
    models: z.array(MarketMlModelSchema).max(4),
    trials: z.array(RobustTrialSchema).min(1).max(8),
    scenarios: z.array(RobustScenarioSchema).min(1).max(12),
    policy: z.strictObject({
      ranking: z.literal('MEAN_NET_MINUS_WORST_DRAWDOWN_MINUS_CVAR05_V1'),
      uncertainty: z.literal('JOINT_CIRCULAR_TIME_BLOCK_BOOTSTRAP_V1'),
      blockLength: z.number().int().min(2).max(16),
      resamples: z.number().int().min(200).max(8192),
      minimumBlocks: z.number().int().min(4).max(32),
      alpha: z.literal(0.05),
      maxCandidates: z.number().int().min(1).max(2),
      maxDrawdown: z.number().min(0).max(1),
      maxTailLoss: z.number().min(0).max(1),
      syntheticPromotion: z.literal('FORBIDDEN'),
    }),
  })
  .superRefine((p, c) => {
    if (
      new Set(p.trials.map((t) => t.id)).size !== p.trials.length ||
      new Set(p.scenarios.map((t) => t.id)).size !== p.scenarios.length ||
      new Set(p.models.map((m) => m.id)).size !== p.models.length ||
      p.declaredAt > p.generatedAt
    )
      c.addIssue({ code: 'custom', message: 'Duplicate identities or invalid declared clock' });
  });
export type MarketRobustnessPlan = z.infer<typeof MarketRobustnessPlanSchema>;
export type RobustTrial = z.infer<typeof RobustTrialSchema>;
export type RobustScenario = z.infer<typeof RobustScenarioSchema>;
export const RobustAttemptSchema = z.strictObject({
  trialId: IdSchema,
  scenarioId: IdSchema,
  status: z.enum(['COMPLETE', 'FAILED']),
  reason: z.enum(['COMPLETE', 'CAUSAL_OR_EXECUTION_REJECTED']),
  producerHash: HashSchema,
  featureHash: HashSchema,
  outcomeHash: HashSchema.nullable(),
  originalCandidatesHash: HashSchema.nullable(),
  projectedCandidatesHash: HashSchema.nullable(),
  signals: z
    .array(z.strictObject({ at: UtcTimestampSchema, side: z.enum(['LONG', 'SHORT', 'HOLD']) }))
    .max(128),
  metrics: BacktestMetricsSchema.nullable(),
  cashNetReturn: z.number().nullable(),
  buyAndHoldNetReturn: z.number().nullable(),
  increments: z.array(z.number().nullable()).max(128),
  warnings: z.array(z.string()),
});
export type RobustAttempt = z.infer<typeof RobustAttemptSchema>;
export const RobustEvidenceSchema = z.strictObject({
  schemaVersion: z.literal('market-robustness-evidence.v1'),
  trialId: IdSchema,
  scenarioId: IdSchema,
  originalReplay: BacktestOutcomeSchema.shape.replay,
  projectedCandidates: z
    .array(BacktestOutcomeSchema.shape.replay.shape.candidates.element)
    .max(128),
  outcome: BacktestOutcomeSchema,
});
export type RobustEvidence = z.infer<typeof RobustEvidenceSchema>;
export const RobustJournalEntrySchema = z.strictObject({
  schemaVersion: z.literal('market-robustness-journal-entry.v1'),
  sequence: z.number().int().positive(),
  planHash: HashSchema,
  trialId: IdSchema.nullable(),
  scenarioId: IdSchema.nullable(),
  state: z.enum(['PLANNED', 'STARTED', 'COMPLETE', 'FAILED', 'FINALIZED']),
  evidenceHash: HashSchema.nullable(),
  previousHash: HashSchema,
  hash: HashSchema,
});
export type RobustJournalEntry = z.infer<typeof RobustJournalEntrySchema>;
export const RobustRiskInputSchema = z.strictObject({
  attempts: z.array(RobustAttemptSchema).min(1).max(96),
  trialIds: z.array(IdSchema).min(1).max(8),
  familySize: z.number().int().min(1).max(101000),
  randomSeed: SeedSchema,
  policy: MarketRobustnessPlanSchema.shape.policy,
});
export const RobustRankingSchema = z.strictObject({
  trialId: IdSchema,
  rank: z.number().int().positive().nullable(),
  completeCases: z.number().int().nonnegative(),
  failedCases: z.number().int().nonnegative(),
  meanNetReturn: z.number().nullable(),
  worstDrawdown: z.number().nullable(),
  tailCvar05: z.number().nullable(),
  worstNetReturn: z.number().nullable(),
  underperformCash: z.number().int().nonnegative(),
  underperformBuyAndHold: z.number().int().nonnegative(),
  score: z.number().nullable(),
  uncertainty: z.strictObject({
    marginal95: z.strictObject({ lower: z.number(), upper: z.number() }).nullable(),
    rawP: z.number().min(0).max(1).nullable(),
    holmP: z.number().min(0).max(1).nullable(),
    blockCount: z.number().int().nonnegative(),
    reason: z.enum([
      'CONDITIONAL_APPROXIMATION',
      'INSUFFICIENT_BLOCKS',
      'INCOMPLETE_EQUITY',
      'ZERO_VARIANCE',
      'MONTE_CARLO_RESOLUTION',
    ]),
  }),
});
export type RobustRanking = z.infer<typeof RobustRankingSchema>;
export const MarketRobustnessReportSchema = z.strictObject({
  schemaVersion: z.literal('market-robustness-report.v1'),
  execution: z.literal('SIMULATED'),
  liveExecution: z.literal('DISABLED'),
  codeVersion: z.string().min(1).max(200),
  plan: MarketRobustnessPlanSchema,
  planHash: HashSchema,
  synthetic: z.boolean(),
  familySize: z.number().int().positive(),
  attemptCount: z.number().int().nonnegative(),
  importedCalibrationTrials: z.number().int().nonnegative(),
  attempts: z.array(RobustAttemptSchema).max(96),
  rankings: z.array(RobustRankingSchema).max(8),
  instability: z
    .array(
      z.strictObject({
        trialId: IdSchema,
        parentTrialId: IdSchema,
        change: RobustTrialSchema.shape.change,
        comparableCases: z.number().int().nonnegative(),
        signFlipCases: z.number().int().nonnegative(),
        changedSignalEvents: z.number().int().nonnegative(),
        comparedSignalEvents: z.number().int().nonnegative(),
        maxAbsoluteNetDelta: z.number().nullable(),
      }),
    )
    .max(8),
  selection: z
    .array(
      z.strictObject({
        trialId: IdSchema,
        status: z.enum(['ARCHIVED', 'FORWARD_RESEARCH_CANDIDATE']),
        reasons: z.array(z.string()),
        producerHash: HashSchema,
        featureHash: HashSchema,
        forwardExperimentRequired: z.literal(true),
      }),
    )
    .max(8),
  journalHead: HashSchema,
  warnings: z.array(z.string()),
});
export type MarketRobustnessReport = z.infer<typeof MarketRobustnessReportSchema>;
export const MarketRobustnessBundleSchema = z.strictObject({
  schemaVersion: z.enum(['market-robustness-bundle.v1', 'market-robustness-bundle.v2']),
  id: IdSchema,
  reportHash: HashSchema,
  files: z.record(
    z
      .string()
      .regex(
        /^(plan\.json|report\.json|report\.md|journal\.jsonl|evidence\/[a-zA-Z0-9_-]+\.json)$/,
      ),
    HashSchema,
  ),
});
