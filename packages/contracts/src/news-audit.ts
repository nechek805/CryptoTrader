import { z } from 'zod';
import {
  NewsSignalManifestSchema,
  NewsSignalDecisionSchema,
  NewsSignalReportSchema,
  NewsSignalQuerySchema,
  NewsSignalStateSchema,
  NewsSignalConfigSchema,
} from './news-signals.js';
import {
  NewsEdgeModelSchema,
  NewsEdgePredictionSchema,
  NewsEdgeInferenceRequestSchema,
} from './news-edge.js';
import { NewsEventSnapshotSchema } from './news-events.js';
import { NewsGraphNodeSchema, NewsIndependenceScoreSchema } from './news-graph.js';
import { HypothesisDatasetSchema } from './hypotheses.js';
import {
  DecimalStringSchema,
  HashSchema,
  IdSchema,
  UtcTimestampSchema,
  SeedSchema,
} from './primitives.js';
export const NewsExplainRequestSchema = z.strictObject({
  schemaVersion: z.literal('news-explain-request.v1'),
  snapshot: NewsEventSnapshotSchema,
  config: NewsSignalConfigSchema,
  query: NewsSignalQuerySchema,
  state: NewsSignalStateSchema.optional(),
  model: NewsEdgeModelSchema.optional(),
  hypothesisId: IdSchema.optional(),
  roundTripCostBps: z.number().int().min(0).max(10000),
});
export const NewsExplanationSchema = z.strictObject({
  schemaVersion: z.literal('news-explanation.v1'),
  execution: z.literal('DISABLED'),
  sourceTextPolicy: z.literal('UNTRUSTED_QUOTED_DATA_NEVER_INSTRUCTIONS'),
  decisionId: IdSchema,
  decisionAt: UtcTimestampSchema,
  eventId: IdSchema.nullable(),
  snapshotHash: HashSchema,
  claims: z.array(NewsGraphNodeSchema).max(1000),
  independence: NewsIndependenceScoreSchema.nullable(),
  independentSourceIds: z.array(IdSchema),
  contradictoryClaimIds: z.array(IdSchema),
  retractedClaimIds: z.array(IdSchema),
  eventAgeSeconds: z.number().nonnegative().nullable(),
  firstKnownAt: UtcTimestampSchema.nullable(),
  sourceReceipts: z
    .array(
      z.strictObject({
        articleVersionId: IdSchema,
        sourceId: IdSchema,
        sourceHash: HashSchema,
        canonicalUrl: z.string().url(),
        firstObservedAt: UtcTimestampSchema,
        effectivePublishedAt: UtcTimestampSchema.nullable(),
        extractionKnownAt: UtcTimestampSchema,
        reviewReasons: z.array(z.string()),
        quotedText: z.string().max(1500),
        extractionHash: HashSchema,
      }),
    )
    .max(32),
  priorSimilarEvents: z.strictObject({
    status: z.enum(['UNTRAINED_RULE', 'FROZEN_CONDITIONAL_ESTIMATE']),
    prediction: NewsEdgePredictionSchema.nullable(),
  }),
  costs: z.strictObject({
    kind: z.literal('ASSUMED_MARKOUT_COST_NOT_EXECUTION_QUOTE'),
    roundTripCostBps: z.number().int().min(0).max(10000),
    uncertaintyBufferBps: z.number().int().min(0).max(10000),
    stops: z.null(),
    fillPrice: z.null(),
  }),
  side: z.enum(['LONG', 'SHORT', 'HOLD']),
  reasons: z.array(z.string()),
  uncertainty: z.array(z.string()),
});
export type NewsExplanation = z.infer<typeof NewsExplanationSchema>;
export const NewsEvaluationPlanSchema = z
  .strictObject({
    schemaVersion: z.literal('news-evaluation-plan.v1'),
    declaredAt: UtcTimestampSchema,
    from: UtcTimestampSchema,
    to: UtcTimestampSchema,
    generatedAt: UtcTimestampSchema,
    horizonSeconds: z.union([z.literal(60), z.literal(300), z.literal(900)]),
    roundTripCostBps: z.number().int().min(0).max(10000),
    opportunityIds: z.array(IdSchema).min(1).max(32),
    baseline: z.literal('CASH_AND_ALWAYS_LONG_ON_SAME_GRID'),
    minimumUnits: z.number().int().min(3).max(32),
    bootstrapSamples: z.number().int().min(200).max(2000),
    seed: SeedSchema,
  })
  .superRefine((v, c) => {
    if (
      v.declaredAt > v.from ||
      v.from >= v.to ||
      v.to > v.generatedAt ||
      new Set(v.opportunityIds).size !== v.opportunityIds.length
    )
      c.addIssue({
        code: 'custom',
        message: 'Invalid frozen news evaluation period or opportunity set',
      });
  });
export const NewsAuditInputSchema = z.strictObject({
  schemaVersion: z.literal('news-audit-input.v1'),
  rules: NewsSignalManifestSchema,
  model: NewsEdgeModelSchema,
  evaluation: z.strictObject({
    plan: NewsEvaluationPlanSchema,
    dataset: HypothesisDatasetSchema,
    requests: z
      .array(z.strictObject({ observationId: IdSchema, request: NewsEdgeInferenceRequestSchema }))
      .min(1)
      .max(32),
  }),
});
export type NewsAuditInput = z.infer<typeof NewsAuditInputSchema>;
export const NewsExplainedDecisionSchema = z.strictObject({
  caseId: IdSchema,
  decision: NewsSignalDecisionSchema,
  prediction: NewsEdgePredictionSchema.nullable(),
  explanation: NewsExplanationSchema,
});
export const NewsEvaluationRowSchema = z.strictObject({
  observationId: IdSchema,
  decisionId: IdSchema,
  decisionAt: UtcTimestampSchema,
  endAt: UtcTimestampSchema,
  symbol: z.string(),
  side: z.enum(['LONG', 'SHORT', 'HOLD']),
  referenceSide: z.enum(['LONG', 'SHORT']),
  status: z.enum(['COMPLETE', 'MISSING_PRICES', 'UNAVAILABLE_NEWS']),
  lineageIds: z.array(IdSchema),
  barIds: z.array(IdSchema),
  grossReturn: DecimalStringSchema.nullable(),
  newsMarkout: DecimalStringSchema.nullable(),
  longMarkout: DecimalStringSchema.nullable(),
  cashMarkout: DecimalStringSchema.nullable(),
  deltaVsLong: DecimalStringSchema.nullable(),
  deltaVsCash: DecimalStringSchema.nullable(),
  outcomeClass: z.enum([
    'TRUE_POSITIVE',
    'FALSE_POSITIVE',
    'MISSED_EVENT',
    'CORRECT_ABSTENTION',
    'UNMEASURED',
  ]),
  outcomeKnowledge: z.literal('HINDSIGHT_PRICE_OUTCOME_NOT_EVENT_TRUTH'),
});
export type NewsEvaluationRow = z.infer<typeof NewsEvaluationRowSchema>;
const paired = z.strictObject({
  baseline: z.enum(['CASH', 'ALWAYS_LONG']),
  meanDelta: DecimalStringSchema.nullable(),
  interval: z
    .strictObject({
      lower: DecimalStringSchema,
      upper: DecimalStringSchema,
      nominalLevel: DecimalStringSchema,
      familySize: z.literal(2),
      method: z.literal('UTC_DAY_LINEAGE_WINDOW_BLOCK_BOOTSTRAP.v1'),
    })
    .nullable(),
});
export const NewsAuditReportSchema = z.strictObject({
  schemaVersion: z.literal('news-audit-report.v1'),
  execution: z.literal('DISABLED'),
  interpretation: z.literal('PAIRED_PRICE_MARKOUT_NOT_FILL_PNL_OR_CAUSAL'),
  codeVersion: z.string().min(1).max(200),
  inputHash: HashSchema,
  modelHash: HashSchema,
  planHash: HashSchema,
  adversarial: NewsSignalReportSchema,
  frames: z.array(NewsExplainedDecisionSchema).max(544),
  evaluation: z.strictObject({
    rows: z.array(NewsEvaluationRowSchema).max(32),
    opportunityCount: z.number().int(),
    measuredCount: z.number().int(),
    independentUnits: z.number().int(),
    unitMembers: z.array(z.array(IdSchema)),
    comparisons: z.array(paired).length(2),
    falsePositives: z.array(IdSchema),
    missedEvents: z.array(IdSchema),
    assessment: z.enum([
      'SYNTHETIC_ONLY',
      'INSUFFICIENT_EVIDENCE',
      'NO_INCREMENTAL_VALUE',
      'CONDITIONAL_POSITIVE_MARKOUT_ONLY',
    ]),
  }),
  snapshotHashes: z.array(HashSchema).max(352),
  extractionArchiveHash: HashSchema,
  handoffHash: HashSchema,
  logHead: HashSchema,
  warnings: z.array(z.string()),
});
export type NewsAuditReport = z.infer<typeof NewsAuditReportSchema>;
export const NewsExtractionArchiveSchema = z.strictObject({
  schemaVersion: z.literal('news-extraction-archive.v1'),
  prompt: z.strictObject({ version: IdSchema, instructions: z.string().min(1).max(4000) }),
  rows: z
    .array(
      z.strictObject({
        extractionHash: HashSchema,
        articleVersionId: IdSchema,
        sourceId: IdSchema,
        modelVersion: IdSchema,
        promptHash: HashSchema,
        promptVersion: IdSchema,
        exactPrompt: z.string().nullable(),
        fallback: z.literal('literal-news-grammar.v1'),
        status: z.enum(['EXTRACTED', 'REVIEW_NEEDED']),
        costStatus: z.enum(['ZERO_EXTERNAL_COST', 'UNKNOWN']),
        amountUsd: DecimalStringSchema.nullable(),
        sourceInputHash: HashSchema,
      }),
    )
    .max(512),
});
export const NewsAuditHandoffSchema = z.strictObject({
  schemaVersion: z.literal('news-module11-handoff.v1'),
  target: z.literal('MODULE_11_ITERATION_1'),
  execution: z.literal('DISABLED'),
  defaultAction: z.literal('HOLD'),
  modelHash: HashSchema,
  planHash: HashSchema,
  extractionArchiveHash: HashSchema,
  providerPorts: z.array(z.enum(['NewsSignalProvider', 'EstimatedNewsSignalProvider'])).length(2),
  promotion: z.literal('NOT_AUTHORIZED'),
  warnings: z.array(z.string()),
});
export const NewsAuditBundleSchema = z.strictObject({
  schemaVersion: z.literal('news-audit-bundle.v1'),
  id: IdSchema,
  reportHash: HashSchema,
  files: z.record(
    z
      .string()
      .regex(
        /^(input\.json|report\.json|report\.md|decisions\.jsonl|extractions\.json|handoff\.json|snapshots\/[a-f0-9]{64}\.json)$/,
      ),
    HashSchema,
  ),
});
