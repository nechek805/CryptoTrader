import { z } from 'zod';
import { SignalCandidateSchema } from './domain.js';
import {
  CurrencySchema,
  HashSchema,
  IdSchema,
  PortfolioSchema,
  PositiveDecimalSchema,
  SeedSchema,
  SymbolSchema,
  UnitDecimalSchema,
  UtcTimestampSchema,
} from './primitives.js';

export const ComponentArmSchema = z.enum(['BASELINE', 'NEWS_ONLY', 'MARKET_ONLY']);
export type ComponentArm = z.infer<typeof ComponentArmSchema>;
export const FusionPolicySchema = z.strictObject({
  schemaVersion: z.literal('fusion-policy.v1'),
  algorithmVersion: z.literal('conservative-fusion.v1'),
  kind: z.enum(['AGREEMENT_ONLY', 'WEIGHTED_CALIBRATED', 'DISAGREEMENT_HOLD']),
  frozenAt: UtcTimestampSchema,
  selection: z.strictObject({
    phase: z.literal('TRAIN'),
    startAt: UtcTimestampSchema,
    endAt: UtcTimestampSchema,
    availableAt: UtcTimestampSchema,
    datasetHash: HashSchema,
    reportHash: HashSchema,
  }),
  newsWeight: UnitDecimalSchema,
  minimumWeightedScore: UnitDecimalSchema,
});
export type FusionPolicy = z.infer<typeof FusionPolicySchema>;
export const FusionOpportunitySchema = z.strictObject({
  id: IdSchema,
  symbol: SymbolSchema,
  decisionAt: UtcTimestampSchema,
  dataCutoff: UtcTimestampSchema,
  validUntil: UtcTimestampSchema,
  horizon: SignalCandidateSchema.shape.horizon,
  snapshotHash: HashSchema,
});
export type FusionOpportunity = z.infer<typeof FusionOpportunitySchema>;
const ProducerSchema = z.strictObject({
  id: IdSchema,
  version: z.string().min(1).max(100),
  configHash: HashSchema,
});
export const FusionPlanSchema = z.strictObject({
  schemaVersion: z.literal('fusion-plan.v1'),
  origin: z.enum(['SYNTHETIC', 'RESEARCH']),
  codeVersion: z.string().min(1).max(200),
  generatedAt: UtcTimestampSchema,
  randomSeed: SeedSchema,
  baselinePolicy: z.literal('CASH'),
  policy: FusionPolicySchema,
  common: z.strictObject({
    initialCapital: PositiveDecimalSchema,
    currency: CurrencySchema,
    datasetHashes: z.array(HashSchema).min(1).max(256),
    feeAssumptionsHash: HashSchema,
    executionAssumptionsHash: HashSchema,
  }),
  producers: z.strictObject({
    BASELINE: ProducerSchema,
    NEWS_ONLY: ProducerSchema,
    MARKET_ONLY: ProducerSchema,
  }),
  opportunities: z.array(FusionOpportunitySchema).min(1).max(256),
});
export type FusionPlan = z.infer<typeof FusionPlanSchema>;
export const FusionEvidenceSchema = z.strictObject({
  id: IdSchema,
  contentHash: HashSchema,
  availableAt: UtcTimestampSchema,
  availabilityBasis: z.enum(['OBSERVED', 'ARCHIVED_CAPTURE']),
  researchUse: z.literal('ELIGIBLE'),
  origin: z.enum(['SYNTHETIC', 'RESEARCH']),
});
// The target must be explicitly supported by the upstream calibration artifact.
// Evidence confidence and uncalibrated rule scores cannot populate this binding.
export const FusionCalibrationSchema = z.strictObject({
  artifactHash: HashSchema,
  modelVersion: z.string().min(1).max(200),
  target: z.literal('POSITIVE_NET_RETURN_IN_CANDIDATE_DIRECTION'),
  phase: z.enum(['TRAIN', 'VALIDATION']),
  sampleEndAt: UtcTimestampSchema,
  availableAt: UtcTimestampSchema,
  horizon: SignalCandidateSchema.shape.horizon,
});
export const FusionSubmissionSchema = z.strictObject({
  snapshotHash: HashSchema,
  executionAssumptionsHash: HashSchema,
  candidates: z.array(SignalCandidateSchema).max(8),
  evidence: z.array(FusionEvidenceSchema).max(512),
  calibration: FusionCalibrationSchema.nullable(),
});
export type FusionSubmission = z.infer<typeof FusionSubmissionSchema>;
export const FusionWindowInputSchema = z.strictObject({
  opportunityId: IdSchema,
  submissions: z.strictObject({
    BASELINE: FusionSubmissionSchema,
    NEWS_ONLY: FusionSubmissionSchema,
    MARKET_ONLY: FusionSubmissionSchema,
  }),
});
export const FusionRunInputSchema = z.strictObject({
  schemaVersion: z.literal('fusion-run-input.v1'),
  plan: FusionPlanSchema,
  windows: z.array(FusionWindowInputSchema).min(1).max(256),
});
export type FusionRunInput = z.infer<typeof FusionRunInputSchema>;
export const FusionReasonSchema = z.enum([
  'AGREEMENT',
  'DIRECTIONAL_CONFLICT',
  'COMPONENT_HOLD',
  'MISSING_COMPONENT',
  'SINGLE_DIRECTION',
  'CALIBRATION_REQUIRED',
  'BELOW_WEIGHTED_THRESHOLD',
  'WEIGHTED_SUPPORT',
]);
export const FusionWindowResultSchema = z.strictObject({
  opportunityId: IdSchema,
  snapshotHash: HashSchema,
  reason: FusionReasonSchema,
  weightedScore: z.number().min(-1).max(1).nullable(),
  missingArms: z.array(ComponentArmSchema).max(3),
  duplicateCounts: z.strictObject({
    BASELINE: z.number().int().nonnegative(),
    NEWS_ONLY: z.number().int().nonnegative(),
    MARKET_ONLY: z.number().int().nonnegative(),
  }),
  candidates: z.strictObject({
    BASELINE: SignalCandidateSchema,
    NEWS_ONLY: SignalCandidateSchema,
    MARKET_ONLY: SignalCandidateSchema,
    FUSION: SignalCandidateSchema,
  }),
  previousHash: HashSchema,
  hash: HashSchema,
});
export const FusionReportSchema = z.strictObject({
  schemaVersion: z.literal('fusion-report.v1'),
  execution: z.literal('DISABLED'),
  ordersCreated: z.literal(0),
  promotion: z.literal('NOT_AUTHORIZED'),
  assessment: z.enum(['SYNTHETIC_ONLY', 'CANDIDATE_COLLECTION_ONLY']),
  input: FusionRunInputSchema,
  inputHash: HashSchema,
  policyHash: HashSchema,
  arms: z
    .array(
      z.strictObject({
        portfolio: PortfolioSchema,
        portfolioId: IdSchema,
        initialCapital: PositiveDecimalSchema,
        currency: CurrencySchema,
        executionAssumptionsHash: HashSchema,
        feeAssumptionsHash: HashSchema,
      }),
    )
    .length(4),
  windows: z.array(FusionWindowResultSchema).min(1).max(256),
  logHead: HashSchema,
});
export type FusionReport = z.infer<typeof FusionReportSchema>;
