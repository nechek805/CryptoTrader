import { z } from 'zod';
import { ExperimentManifestSchema } from './domain.js';
import { PaperConfigSchema, PaperReportSchema } from './paper-broker.js';
import { DecisionPolicySchema } from './decision-audit.js';
import { EvaluationPlanSchema, EvaluationReportSchema } from './evaluation.js';
import { NewsEventSnapshotSchema } from './news-events.js';
import {
  HashSchema,
  IdSchema,
  PortfolioSchema,
  UtcTimestampSchema,
  UnitDecimalSchema,
} from './primitives.js';

export const TrialArtifactSchema = z.strictObject({
  id: IdSchema,
  version: IdSchema,
  origin: z.enum(['SYNTHETIC', 'RESEARCH']),
  knownAt: UtcTimestampSchema,
  trainingCutoff: UtcTimestampSchema.nullable(),
  content: z.record(z.string(), z.json()),
  hash: HashSchema,
});
export const TrialProviderCheckSchema = z.strictObject({
  id: IdSchema,
  kind: z.enum(['MARKET', 'NEWS']),
  adapterVersion: IdSchema,
  adapterHash: HashSchema,
  reviewHash: HashSchema,
  reviewedAt: UtcTimestampSchema,
  validUntil: UtcTimestampSchema,
  approved: z.boolean(),
  rights: z.enum(['LOCALLY_AUTHORED_SYNTHETIC', 'APPROVED_RESEARCH_USE']),
  evidence: TrialArtifactSchema,
});
export const ExperimentProtocolSchema = z.strictObject({
  schemaVersion: z.literal('experiment-protocol.v1'),
  execution: z.literal('SIMULATED'),
  origin: z.enum(['SYNTHETIC', 'PUBLIC_READ_ONLY']),
  name: IdSchema,
  frozenAt: UtcTimestampSchema,
  codeVersion: z.string().min(1).max(200),
  paper: PaperConfigSchema,
  riskPolicy: DecisionPolicySchema,
  models: z
    .array(
      z.strictObject({
        portfolio: PortfolioSchema,
        strategyId: IdSchema,
        artifact: TrialArtifactSchema,
      }),
    )
    .length(4),
  providers: z.array(TrialProviderCheckSchema).min(2).max(11),
  evaluation: EvaluationPlanSchema,
  newsPolicy: z.strictObject({
    independentOrigins: z.number().int().min(2).max(10),
    dependenciesCountAsOne: z.literal(true),
    confirmationClock: z.literal('LATEST_REQUIRED_AVAILABLE_AT'),
    delayedTreatment: z.literal('HOLD_AT_SLOT_NEVER_BACKDATE'),
    corrections: z.literal('APPEND_NEW_KNOWLEDGE'),
  }),
  schedule: z.strictObject({
    heartbeatSeconds: z.number().int().min(1).max(3600),
    sourceAuditSeconds: z.number().int().min(1).max(3600),
    reconcile: z.literal('UTC_DAILY'),
    weeklyQaDays: z.literal(7),
    maxClockLagSeconds: z.number().int().min(1).max(120),
  }),
  failureCriteria: z.strictObject({
    minimumCoverage: UnitDecimalSchema,
    knownLookAheadBugs: z.literal(0),
    duplicateLedgerBugs: z.literal(0),
    hardRiskBreaches: z.literal(0),
    stopOnIntegrityFailure: z.literal(true),
  }),
  baselinePolicy: z.literal('CASH'),
  fillModel: z.literal('OBSERVED_QUOTES_AND_TRADE_THROUGH_ASSUMED_QUEUE_V1'),
  spreadPolicy: z.literal('OBSERVED_BID_ASK_NO_FIXED_SPREAD_INVENTION'),
  changePolicy: z.literal('ANY_CODE_OR_PARAMETER_CHANGE_NEW_EXPERIMENT_ID'),
});
export type ExperimentProtocol = z.infer<typeof ExperimentProtocolSchema>;
export const ForwardExperimentManifestSchema = z.strictObject({
  schemaVersion: z.literal('forward-experiment-manifest.v1'),
  protocol: ExperimentProtocolSchema,
  protocolHash: HashSchema,
  manifest: ExperimentManifestSchema,
  hash: HashSchema,
});
export type ForwardExperimentManifest = z.infer<typeof ForwardExperimentManifestSchema>;

export const TrialAnnotationSchema = z.strictObject({
  schemaVersion: z.literal('trial-annotation.v1'),
  id: IdSchema,
  at: UtcTimestampSchema,
  kind: z.enum([
    'SESSION_START',
    'RESTART',
    'NEWS_CORRECTION',
    'DUPLICATE_SOURCE',
    'CORROBORATION_DELAY',
  ]),
  sourceId: IdSchema.nullable(),
  referenceHash: HashSchema,
  evidence: z.json().nullable().default(null),
  intervalStart: UtcTimestampSchema.nullable(),
  intervalEnd: UtcTimestampSchema.nullable(),
  affectedCandidateIds: z.array(IdSchema).max(1000),
  outcome: z.enum([
    'RECORDED',
    'HOLD',
    'DUPLICATE_NOT_INDEPENDENT',
    'RECOVERED_FROM_COMMITTED_PREFIX',
  ]),
});
export type TrialAnnotation = z.infer<typeof TrialAnnotationSchema>;
export const TrialRunSchema = z.strictObject({
  schemaVersion: z.literal('trial-run.v1'),
  manifest: ForwardExperimentManifestSchema,
  paper: PaperReportSchema,
  annotations: z.array(TrialAnnotationSchema).max(10000),
  newsSnapshots: z.array(NewsEventSnapshotSchema).max(1000).default([]),
  wallClockStartedAt: UtcTimestampSchema.nullable(),
  wallClockFinishedAt: UtcTimestampSchema.nullable(),
});
export type TrialRun = z.infer<typeof TrialRunSchema>;
export const TrialAssessmentSchema = z.strictObject({
  schemaVersion: z.literal('trial-assessment.v1'),
  execution: z.literal('SIMULATED'),
  origin: z.enum(['SYNTHETIC', 'PUBLIC_READ_ONLY']),
  experimentId: IdSchema,
  manifestHash: HashSchema,
  runHash: HashSchema,
  annotationHead: HashSchema,
  actualElapsed30Days: z.boolean(),
  evaluation: EvaluationReportSchema,
  daily: z.array(z.json()).max(31),
  weeklyQa: z.array(z.json()).max(5),
  incidents: z.array(z.json()).max(10000),
  continuity: z.strictObject({
    interrupted: z.boolean(),
    restartCount: z.number().int().nonnegative(),
    continuousAnalysis: z.json().nullable(),
    interruptedAnalysis: z.json().nullable(),
  }),
  corroborationDelay: z.strictObject({
    missedSignals: z.number().int().nonnegative(),
    eligibleNewsCandidates: z.number().int().nonnegative(),
    missedFraction: UnitDecimalSchema.nullable(),
    status: z.enum(['MEASURED', 'NO_NEWS_CANDIDATES', 'UNRESOLVED_EVIDENCE']),
  }),
  passiveBasket: z.array(z.json()).max(20),
  recommendation: z.enum(['CONTINUE_FORWARD_TEST', 'REVISE_AND_RESET', 'STOP']),
  alphaClaim: z.literal('NOT_ESTABLISHED'),
  realMoneyAuthorized: z.literal(false),
  reasons: z.array(z.string()).min(1),
  futureHypotheses: z.array(z.string()).min(1),
  hash: HashSchema,
});
export type TrialAssessment = z.infer<typeof TrialAssessmentSchema>;
