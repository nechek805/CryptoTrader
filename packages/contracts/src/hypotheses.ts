import { z } from 'zod';
import { MarketBarSchema } from './domain.js';
import { MarketSnapshotManifestSchema } from './market-import.js';
import { NewsEventSnapshotSchema, NewsTemporalEventSchema } from './news-events.js';
import { NewsEventTypeSchema } from './news-extraction.js';
import { EventStudySeriesSchema } from './event-study.js';
import {
  DecimalStringSchema,
  NonNegativeDecimalSchema,
  HashSchema,
  IdSchema,
  ProvenanceSchema,
  SeedSchema,
  UtcTimestampSchema,
} from './primitives.js';

const text = z.string().trim().min(1).max(2000),
  nullableDecimal = DecimalStringSchema.nullable();
const PeriodSchema = z
  .strictObject({ from: UtcTimestampSchema, to: UtcTimestampSchema })
  .refine((v) => v.from < v.to, 'Period must have positive duration');
export const HypothesisCardContentSchema = z
  .strictObject({
    id: IdSchema,
    thesis: text,
    eventGroup: z.array(NewsEventTypeSchema).min(1).max(10),
    expectedDirection: z.enum(['UP', 'DOWN', 'UNSPECIFIED']),
    series: EventStudySeriesSchema,
    horizonSeconds: z.union([
      z.literal(60),
      z.literal(300),
      z.literal(900),
      z.literal(3600),
      z.literal(14400),
      z.literal(86400),
      z.literal(259200),
      z.literal(604800),
    ]),
    intervalSeconds: z.union([z.literal(60), z.literal(300), z.literal(900), z.literal(3600)]),
    roundTripCostBps: z.number().int().min(0).max(10000),
    assumptions: z.array(text).min(1).max(20),
    selectionBiases: z.array(text).min(1).max(20),
    eligibility: z.strictObject({
      firstSeenQualities: z
        .array(z.enum(['OBSERVED', 'ARCHIVED_CAPTURE']))
        .min(1)
        .max(2),
      allowUnverified: z.boolean(),
    }),
    samplePeriod: z.strictObject({ selection: PeriodSchema, validation: PeriodSchema }),
    reuseDisclosure: text.nullable(),
    tests: z.strictObject({
      primaryMetric: z.enum(['GROSS_RETURN', 'NET_RETURN']),
      minimumIndependentUnits: z.number().int().min(3).max(100),
      meanThreshold: NonNegativeDecimalSchema,
    }),
    claimType: z.enum(['ASSOCIATION', 'CAUSAL']),
    causalJustification: z
      .strictObject({
        design: text,
        identificationAssumptions: z.array(text).min(1).max(20),
        evidenceReferences: z.array(text).min(1).max(20),
        reviewer: IdSchema,
      })
      .nullable(),
    status: z.enum(['DRAFT', 'REGISTERED', 'RETIRED']),
  })
  .superRefine((v, ctx) => {
    if (v.horizonSeconds % v.intervalSeconds !== 0)
      ctx.addIssue({ code: 'custom', message: 'Horizon must align to the interval' });
    if (
      new Set(v.eventGroup).size !== v.eventGroup.length ||
      new Set(v.eligibility.firstSeenQualities).size !== v.eligibility.firstSeenQualities.length
    )
      ctx.addIssue({ code: 'custom', message: 'Duplicate eligibility or event group' });
    const a = v.samplePeriod.selection,
      b = v.samplePeriod.validation;
    if (a.from < b.to && b.from < a.to && v.reuseDisclosure === null)
      ctx.addIssue({ code: 'custom', message: 'Selection/validation overlap requires disclosure' });
    if (v.claimType === 'CAUSAL' && v.causalJustification === null)
      ctx.addIssue({
        code: 'custom',
        message: 'Causal claims require a documented design and justification',
      });
    if (
      v.claimType !== 'CAUSAL' &&
      /\b(?:caus(?:e|es|ed|ing|al|ally)|leads? to|drives?)\b|вызывает|причин/iu.test(v.thesis)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Causal thesis language requires an explicit causal claim and justification',
      });
  });
export type HypothesisCardContent = z.infer<typeof HypothesisCardContentSchema>;
export const HypothesisCardRevisionRequestSchema = z.strictObject({
  expectedPreviousHash: HashSchema.nullable(),
  author: IdSchema,
  reason: text,
  content: HypothesisCardContentSchema,
});
export const HypothesisCardSchema = z.strictObject({
  schemaVersion: z.literal('hypothesis-card.v1'),
  revision: z.number().int().min(1),
  previousHash: HashSchema.nullable(),
  recordedAt: UtcTimestampSchema,
  author: IdSchema,
  reason: text,
  content: HypothesisCardContentSchema,
  hash: HashSchema,
});
export type HypothesisCard = z.infer<typeof HypothesisCardSchema>;
export const HypothesisObservationSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('POINT_IN_TIME'),
    id: IdSchema,
    eventId: IdSchema,
    snapshotHash: HashSchema,
    decisionAt: UtcTimestampSchema,
  }),
  z.strictObject({
    kind: z.literal('HISTORICAL_DESCRIPTIVE'),
    id: IdSchema,
    eventId: IdSchema,
    eventGroup: NewsEventTypeSchema,
    decisionAt: UtcTimestampSchema,
    researchUse: z.literal('DESCRIPTIVE_ONLY'),
    firstSeenQuality: z.enum(['ESTIMATED', 'UNKNOWN']),
    availableAt: UtcTimestampSchema.nullable(),
    reason: text,
    provenance: ProvenanceSchema,
  }),
]);
export const HypothesisDatasetSchema = z.strictObject({
  schemaVersion: z.literal('hypothesis-dataset.v1'),
  newsSnapshots: z.array(NewsEventSnapshotSchema).max(20),
  marketBars: z.array(MarketBarSchema).max(200000),
  marketSnapshots: z.array(MarketSnapshotManifestSchema).max(10).default([]),
  observations: z.array(HypothesisObservationSchema).max(1000),
});
export type HypothesisDataset = z.infer<typeof HypothesisDatasetSchema>;
export const HypothesisRegistryInputSchema = z.strictObject({
  schemaVersion: z.literal('hypothesis-registry-input.v1'),
  cards: z.array(HypothesisCardSchema).min(1).max(100),
  dataset: HypothesisDatasetSchema,
});
export const HypothesisRegistryRequestSchema = z
  .strictObject({
    schemaVersion: z.literal('hypothesis-registry-request.v1'),
    analysisAsOf: UtcTimestampSchema,
    generatedAt: UtcTimestampSchema,
    bootstrapSamples: z.number().int().min(200).max(2000),
    seed: SeedSchema,
  })
  .refine((v) => v.generatedAt >= v.analysisAsOf, 'Generation precedes analysis cutoff');
export type HypothesisRegistryRequest = z.infer<typeof HypothesisRegistryRequestSchema>;
export const HypothesisSampleSchema = z.strictObject({
  observationId: IdSchema,
  eventId: IdSchema,
  decisionAt: UtcTimestampSchema,
  endAt: UtcTimestampSchema,
  phase: z.enum(['SELECTION', 'VALIDATION']),
  firstSeenQuality: z.enum(['OBSERVED', 'ARCHIVED_CAPTURE', 'ESTIMATED', 'UNKNOWN']),
  availableAt: UtcTimestampSchema.nullable(),
  status: z.enum([
    'COMPLETE',
    'DESCRIPTIVE_ONLY',
    'UNAVAILABLE_AT_DECISION',
    'QUALITY_EXCLUDED',
    'UNVERIFIED_EXCLUDED',
    'MISSING_PRICES',
    'OUTCOME_OUTSIDE_PERIOD',
    'FUTURE_OUTCOME',
  ]),
  lineageIds: z.array(IdSchema),
  eventContextHash: HashSchema.nullable(),
  sourceIds: z.array(IdSchema),
  grossReturn: nullableDecimal,
  netReturn: nullableDecimal,
  barIds: z.array(IdSchema),
  missingCloseTimes: z.array(UtcTimestampSchema),
});
export type HypothesisSample = z.infer<typeof HypothesisSampleSchema>;
const StatsSchema = z.strictObject({
  sampleCount: z.number().int().nonnegative(),
  completeCount: z.number().int().nonnegative(),
  quarantinedCount: z.number().int().nonnegative(),
  independentUnits: z.number().int().nonnegative(),
  unitDefinition: z.literal('CONNECTED_LINEAGE_OR_OVERLAPPING_OUTCOME'),
  unitMembers: z.array(z.array(IdSchema)),
  mean: nullableDecimal,
  confidenceInterval: z
    .strictObject({
      method: z.literal('LINEAGE_BLOCK_BOOTSTRAP_PERCENTILE.v1'),
      level: DecimalStringSchema,
      familySize: z.number().int().positive(),
      multiplicity: z.literal('BONFERRONI_TARGET_95_FAMILY'),
      interpretation: z.literal('CONDITIONAL_RESAMPLING_NOT_CAUSAL_OR_POPULATION_GUARANTEE'),
      lower: DecimalStringSchema,
      upper: DecimalStringSchema,
      resamples: z.number().int(),
      seed: SeedSchema,
    })
    .nullable(),
  uncertaintyReason: z.enum(['INSUFFICIENT_INDEPENDENT_UNITS', 'NO_COMPLETE_SAMPLES']).nullable(),
});
export type HypothesisStats = z.infer<typeof StatsSchema>;
export const HypothesisEvaluationSchema = z.strictObject({
  cardId: IdSchema,
  cardHash: HashSchema,
  revision: z.number().int(),
  independence: z.enum(['SEPARATE_PERIODS_AND_LINEAGE', 'REUSE_DISCLOSED']),
  reuseReasons: z.array(
    z.enum(['PERIOD_OVERLAP', 'LINEAGE_ACROSS_PERIODS', 'FREEZE_AFTER_VALIDATION_START']),
  ),
  selection: StatsSchema,
  validation: StatsSchema,
  samples: z.array(HypothesisSampleSchema),
  contradictoryExamples: z.array(IdSchema),
  finding: z.enum(['SUPPORTED_IN_SAMPLE', 'CONTRADICTED_IN_SAMPLE', 'INCONCLUSIVE', 'UNTESTED']),
  finalStatus: z.enum([
    'DRAFT',
    'RETIRED',
    'EXPLORATORY_REUSE',
    'INSUFFICIENT_DATA',
    'NEGATIVE_FINDING',
    'INCONCLUSIVE',
    'SYNTHETIC_ONLY',
    'ASSOCIATION_ONLY',
    'CAUSAL_REVIEW_REQUIRED',
  ]),
});
export type HypothesisEvaluation = z.infer<typeof HypothesisEvaluationSchema>;
export const HypothesisRegistryArtifactSchema = z.strictObject({
  schemaVersion: z.literal('hypothesis-registry-artifact.v1'),
  algorithmVersion: z.literal('hypothesis-registry.v1'),
  execution: z.literal('DISABLED'),
  interpretation: z.literal('OBSERVATIONAL_RESEARCH_NOT_CAUSAL_OR_EXECUTABLE'),
  clockSemantics: z.literal('utc-nanoseconds.v1'),
  randomAlgorithm: z.literal('mulberry32.v1'),
  codeVersion: text,
  input: HypothesisRegistryInputSchema,
  inputHash: HashSchema,
  request: HypothesisRegistryRequestSchema,
  configHash: HashSchema,
  synthetic: z.boolean(),
  evaluations: z.array(HypothesisEvaluationSchema),
});
export const HypothesisHandoffRequestSchema = z.strictObject({
  decisionAt: UtcTimestampSchema,
  purpose: z.enum(['NEWS_STRATEGY_RESEARCH', 'TRADABLE_BACKTEST_INPUT']),
});
export const HypothesisHandoffSchema = z
  .strictObject({
    schemaVersion: z.literal('hypothesis-news-strategy-inputs.v1'),
    execution: z.literal('DISABLED'),
    defaultAction: z.literal('HOLD'),
    purpose: z.enum(['NEWS_STRATEGY_RESEARCH', 'TRADABLE_BACKTEST_INPUT']),
    registryHash: HashSchema,
    decisionAt: UtcTimestampSchema,
    cards: z.array(HypothesisCardSchema),
    events: z.array(
      z.strictObject({
        observationId: IdSchema,
        observationDecisionAt: UtcTimestampSchema,
        cardHashes: z.array(HashSchema).min(1),
        eventContextHash: HashSchema,
        event: NewsTemporalEventSchema,
        firstSeenQuality: z.enum(['OBSERVED', 'ARCHIVED_CAPTURE']),
        sourceIds: z.array(IdSchema),
      }),
    ),
    quarantined: z.array(
      z.strictObject({
        observationId: IdSchema,
        reason: z.enum(['DESCRIPTIVE_ONLY', 'UNAVAILABLE_AT_DECISION', 'QUALITY_EXCLUDED']),
      }),
    ),
  })
  .superRefine((v, ctx) => {
    for (const row of v.events) {
      if (
        !row.event.active ||
        !row.event.replayEligible ||
        row.event.availableAt === null ||
        row.event.availableAt > row.observationDecisionAt ||
        row.observationDecisionAt > v.decisionAt ||
        row.cardHashes.some(
          (hash) =>
            !v.cards.some(
              (c) =>
                c.hash === hash &&
                c.recordedAt <= row.observationDecisionAt &&
                c.content.status === 'REGISTERED' &&
                c.content.claimType === 'ASSOCIATION',
            ),
        )
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Handoff cannot promote unavailable news or future card versions',
        });
    }
  });
