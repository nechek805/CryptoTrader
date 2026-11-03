import { z } from 'zod';
import { HypothesisDatasetSchema } from './hypotheses.js';
import { EventStudySeriesSchema } from './event-study.js';
import { NewsEventTypeSchema } from './news-extraction.js';
import {
  NewsSignalConfigSchema,
  NewsSignalQuerySchema,
  NewsSignalStateSchema,
} from './news-signals.js';
import { NewsEventSnapshotSchema } from './news-events.js';
import {
  DecimalStringSchema,
  NonNegativeDecimalSchema,
  HashSchema,
  IdSchema,
  UtcTimestampSchema,
  SeedSchema,
} from './primitives.js';

const period = z
  .strictObject({ from: UtcTimestampSchema, to: UtcTimestampSchema })
  .refine((v) => v.from < v.to, 'Empty news estimation period');
const recurrence = z.enum(['FIRST_SEEN_IN_CORPUS', 'REPEATED_PATTERN']);
export const NewsEdgePlanSchema = z
  .strictObject({
    schemaVersion: z.literal('news-edge-plan.v1'),
    algorithmVersion: z.literal('matched-news-block-means.v1'),
    declaredAt: UtcTimestampSchema,
    training: period,
    validation: period,
    analysisAsOf: UtcTimestampSchema,
    availableAt: UtcTimestampSchema,
    decisionLagSeconds: z.number().int().min(0).max(300),
    intervalSeconds: z.literal(60),
    horizonsSeconds: z
      .array(z.union([z.literal(60), z.literal(300), z.literal(900)]))
      .min(1)
      .max(3),
    preWindowSeconds: z.number().int().min(60).max(3600),
    benchmark: EventStudySeriesSchema,
    controlAnchors: z.array(UtcTimestampSchema).min(1).max(128),
    minimumMatchedControls: z.number().int().min(2).max(8),
    preMoveCaliper: NonNegativeDecimalSchema,
    minimumTrainingUnits: z.number().int().min(3).max(100),
    minimumValidationUnits: z.number().int().min(3).max(100),
    roundTripCostBps: z.number().int().min(0).max(10000),
    uncertaintyBufferBps: z.number().int().min(1).max(10000),
    bootstrapSamples: z.number().int().min(200).max(5000),
    seed: SeedSchema,
    admission: NewsSignalConfigSchema,
    hypotheses: z
      .array(
        z.strictObject({
          id: IdSchema,
          eventType: NewsEventTypeSchema,
          recurrence,
          series: EventStudySeriesSchema,
        }),
      )
      .min(1)
      .max(4),
  })
  .superRefine((v, c) => {
    if (
      v.declaredAt > v.training.from ||
      v.training.to > v.validation.from ||
      v.validation.to > v.analysisAsOf ||
      v.analysisAsOf > v.availableAt ||
      v.admission.declaredAt > v.declaredAt ||
      v.preWindowSeconds % 60 !== 0
    )
      c.addIssue({
        code: 'custom',
        message:
          'News plan must be declared before disjoint chronological training/validation and availability',
      });
    if (
      new Set(v.horizonsSeconds).size !== v.horizonsSeconds.length ||
      new Set(v.controlAnchors).size !== v.controlAnchors.length ||
      new Set(v.hypotheses.map((h) => h.id)).size !== v.hypotheses.length ||
      new Set(v.hypotheses.map((h) => `${h.eventType}|${h.recurrence}|${h.series.instrumentId}`))
        .size !== v.hypotheses.length
    )
      c.addIssue({ code: 'custom', message: 'Duplicate news hypothesis, control or horizon' });
    if (
      v.hypotheses.some(
        (h) =>
          h.series.instrumentId === v.benchmark.instrumentId ||
          !v.admission.symbols.some(
            (s) => s.symbol === h.series.instrumentId && s.asset === h.series.asset,
          ) ||
          !v.admission.rules.some((r) => r.eventType === h.eventType),
      )
    )
      c.addIssue({
        code: 'custom',
        message: 'Missing admission binding or independent benchmark series',
      });
  });
export type NewsEdgePlan = z.infer<typeof NewsEdgePlanSchema>;
export const NewsEdgeInputSchema = z.strictObject({
  schemaVersion: z.literal('news-edge-input.v1'),
  dataset: HypothesisDatasetSchema,
  plan: NewsEdgePlanSchema,
});
export type NewsEdgeInput = z.infer<typeof NewsEdgeInputSchema>;
export const NewsEdgeRowSchema = z.strictObject({
  hypothesisId: IdSchema,
  horizonSeconds: z.number().int(),
  observationId: IdSchema,
  eventId: IdSchema,
  phase: z.enum(['TRAIN', 'VALIDATION']),
  decisionAt: UtcTimestampSchema,
  from: UtcTimestampSchema,
  endAt: UtcTimestampSchema,
  status: z.enum([
    'COMPLETE',
    'DESCRIPTIVE_ONLY',
    'UNAVAILABLE_NEWS',
    'NEWS_ADMISSION_REJECTED',
    'RECURRENCE_EXCLUDED',
    'DECISION_LAG_MISMATCH',
    'OUTCOME_OUTSIDE_PERIOD',
    'MISSING_PRICES',
    'INSUFFICIENT_MATCHED_CONTROLS',
  ]),
  contextHash: HashSchema.nullable(),
  sourceIds: z.array(IdSchema),
  lineageIds: z.array(IdSchema),
  controlIds: z.array(IdSchema),
  baselineReturns: z.array(DecimalStringSchema),
  barIds: z.array(IdSchema),
  grossReturn: DecimalStringSchema.nullable(),
  benchmarkReturn: DecimalStringSchema.nullable(),
  preNewsMove: DecimalStringSchema.nullable(),
  baselineMean: DecimalStringSchema.nullable(),
  excessReturn: DecimalStringSchema.nullable(),
});
export type NewsEdgeRow = z.infer<typeof NewsEdgeRowSchema>;
const interval = z.strictObject({
  lower: DecimalStringSchema,
  upper: DecimalStringSchema,
  level: DecimalStringSchema,
  familySize: z.number().int().positive(),
  resamples: z.number().int(),
  seed: SeedSchema,
  method: z.literal('CONNECTED_EVIDENCE_BLOCK_BOOTSTRAP.v1'),
  interpretation: z.literal('CONDITIONAL_MEAN_INTERVAL_NOT_INDIVIDUAL_FORECAST_OR_CAUSAL'),
});
export const NewsEdgeStatsSchema = z.strictObject({
  sampleCount: z.number().int().nonnegative(),
  completeCount: z.number().int().nonnegative(),
  independentUnits: z.number().int().nonnegative(),
  unitMembers: z.array(z.array(IdSchema)),
  meanGross: DecimalStringSchema.nullable(),
  meanExcess: DecimalStringSchema.nullable(),
  grossInterval: interval.nullable(),
  excessInterval: interval.nullable(),
  baselineDistribution: z.strictObject({
    count: z.number().int().nonnegative(),
    minimum: DecimalStringSchema.nullable(),
    median: DecimalStringSchema.nullable(),
    maximum: DecimalStringSchema.nullable(),
  }),
  uncertaintyReason: z
    .enum(['INSUFFICIENT_UNITS', 'INSUFFICIENT_RESAMPLING_RESOLUTION'])
    .nullable(),
});
export type NewsEdgeStats = z.infer<typeof NewsEdgeStatsSchema>;
export const NewsEdgeFitSchema = z.strictObject({
  hypothesisId: IdSchema,
  horizonSeconds: z.number().int(),
  side: z.enum(['LONG', 'SHORT', 'HOLD']),
  training: NewsEdgeStatsSchema,
  validation: NewsEdgeStatsSchema,
  trainingMargin: DecimalStringSchema.nullable(),
  validationMargin: DecimalStringSchema.nullable(),
  selectedOnTraining: z.boolean(),
  reasons: z.array(z.string()),
});
export type NewsEdgeFit = z.infer<typeof NewsEdgeFitSchema>;
export const NewsEdgeModelSchema = z.strictObject({
  schemaVersion: z.literal('news-edge-model.v1'),
  execution: z.literal('DISABLED'),
  interpretation: z.literal('CONDITIONAL_ASSOCIATION_NOT_FACTUAL_CONFIDENCE_OR_EXECUTION'),
  codeVersion: z.string().min(1).max(200),
  input: NewsEdgeInputSchema,
  inputHash: HashSchema,
  planHash: HashSchema,
  synthetic: z.boolean(),
  dataVintage: UtcTimestampSchema,
  availableAt: UtcTimestampSchema,
  rows: z.array(NewsEdgeRowSchema).max(1536),
  fits: z.array(NewsEdgeFitSchema).max(12),
  warnings: z.array(z.string()),
});
export type NewsEdgeModel = z.infer<typeof NewsEdgeModelSchema>;
export const NewsEdgePredictionSchema = z.strictObject({
  schemaVersion: z.literal('news-edge-prediction.v1'),
  modelHash: HashSchema,
  hypothesisId: IdSchema,
  decisionAt: UtcTimestampSchema,
  dataVintage: UtcTimestampSchema,
  modelAvailableAt: UtcTimestampSchema,
  synthetic: z.boolean(),
  side: z.enum(['LONG', 'SHORT', 'HOLD']),
  horizonSeconds: z.number().int().nullable(),
  trainingSampleSize: z.number().int(),
  validationSampleSize: z.number().int(),
  trainingUnits: z.number().int(),
  validationUnits: z.number().int(),
  expectedGrossReturn: DecimalStringSchema.nullable(),
  expectedExcessReturn: DecimalStringSchema.nullable(),
  grossInterval: interval.nullable(),
  excessInterval: interval.nullable(),
  conservativeNetEdge: DecimalStringSchema.nullable(),
  eventSupportGrade: z.string(),
  eventTruthProbability: z.null(),
  reasons: z.array(z.string()),
});
export const NewsEdgeInferenceRequestSchema = z.strictObject({
  schemaVersion: z.literal('news-edge-inference.v1'),
  hypothesisId: IdSchema,
  snapshot: NewsEventSnapshotSchema,
  query: NewsSignalQuerySchema,
  state: NewsSignalStateSchema.optional(),
  roundTripCostBps: z.number().int().min(0).max(10000),
});
