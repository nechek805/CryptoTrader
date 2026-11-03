import { z } from 'zod';
import { HashSchema, IdSchema, UtcTimestampSchema } from './primitives.js';
import {
  NewsEvidenceSpanSchema,
  NewsExtractionResultSchema,
  NewsExtractionBatchSchema,
  NewsExtractionPersistenceSchema,
} from './news-extraction.js';

export const NewsGraphConfigSchema = z.strictObject({
  schemaVersion: z.literal('news-graph-config.v1'),
  algorithmVersion: z.literal('news-independence.v1'),
  nearDuplicateThresholdBps: z.number().int().min(8000).max(10000),
  minSharedTokens: z.number().int().min(8).max(100),
  maxExtractions: z.number().int().min(1).max(100),
  maxNodes: z.number().int().min(1).max(1000),
});
export const NewsDependencyKindSchema = z.enum([
  'WIRE_REPRINT',
  'REWRITE',
  'CITES',
  'ATTRIBUTION',
  'QUOTED_OFFICIAL',
  'INFERRED_SYNDICATION',
  'SAME_ORIGIN_GROUP',
  'SAME_ARTICLE',
]);
export const NewsGraphDecisionActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ACKNOWLEDGE'), reviewId: IdSchema }),
  z.strictObject({ kind: z.literal('RETRACT'), claimId: IdSchema }),
  z.strictObject({ kind: z.literal('RESTORE'), claimId: IdSchema }),
  z.strictObject({
    kind: z.literal('LINK'),
    from: IdSchema,
    to: IdSchema,
    relationship: z.enum(['WIRE_REPRINT', 'REWRITE', 'CITES', 'ATTRIBUTION', 'QUOTED_OFFICIAL']),
  }),
]);
export const NewsGraphDecisionRequestSchema = z.strictObject({
  schemaVersion: z.literal('news-graph-decision-request.v1'),
  expectedHeadHash: HashSchema,
  operator: IdSchema,
  reason: z.string().trim().min(1).max(1000),
  action: NewsGraphDecisionActionSchema,
});
export const NewsGraphActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('OBSERVE'), extraction: NewsExtractionResultSchema }),
  z.strictObject({
    kind: z.literal('REVIEW'),
    operator: IdSchema,
    reason: z.string().trim().min(1).max(1000),
    targetHash: HashSchema,
    decision: NewsGraphDecisionActionSchema,
  }),
]);
export const NewsGraphRecordSchema = z.strictObject({
  schemaVersion: z.literal('news-graph-record.v1'),
  index: z.number().int().min(0).max(4999),
  previousHash: HashSchema,
  configHash: HashSchema,
  codeVersion: z.string().min(1).max(200),
  recordedAt: UtcTimestampSchema,
  action: NewsGraphActionSchema,
  hash: HashSchema,
});
export type NewsGraphRecord = z.infer<typeof NewsGraphRecordSchema>;
export const NewsGraphObserveResultSchema = z.strictObject({
  created: z.boolean(),
  record: NewsGraphRecordSchema.nullable(),
});
export const NewsGraphNodeSchema = z.strictObject({
  id: IdSchema,
  clusterId: IdSchema,
  extractionHash: HashSchema,
  articleId: IdSchema,
  articleVersionId: IdSchema,
  sourceId: IdSchema,
  sourceHash: HashSchema,
  independenceGroup: IdSchema,
  publicationType: z.enum([
    'OFFICIAL_SECURITY',
    'INDEPENDENT_REPORTING',
    'SYNDICATED',
    'UNVERIFIED_RUMOR',
  ]),
  canonicalUrl: z.string().url(),
  field: z.enum(['TITLE', 'APPROVED_SNIPPET']),
  anchor: NewsEvidenceSpanSchema.nullable(),
  anchorKey: z.string().max(100).nullable(),
  broadKey: HashSchema,
  text: z.string().min(1).max(1500),
  polarity: z.enum(['AFFIRMED', 'NEGATED', 'UNCERTAIN']),
  reportingBasis: z.enum(['ASSERTED_ORIGINAL', 'OFFICIAL_PRIMARY', 'DEPENDENT', 'UNKNOWN']),
  basisEvidence: NewsEvidenceSpanSchema.nullable(),
  firstObservedAt: UtcTimestampSchema,
  extractedAt: UtcTimestampSchema,
  knownAt: UtcTimestampSchema,
  articleProcessedAt: UtcTimestampSchema,
  eligible: z.boolean(),
  active: z.boolean(),
  retracted: z.boolean(),
});
export type NewsGraphNode = z.infer<typeof NewsGraphNodeSchema>;
export const NewsGraphEdgeSchema = z.strictObject({
  id: IdSchema,
  from: IdSchema,
  to: IdSchema,
  relationship: NewsDependencyKindSchema,
  knownAt: UtcTimestampSchema,
  evidence: NewsEvidenceSpanSchema.nullable(),
  rationale: z.string().min(1).max(500),
  manualRecordHash: HashSchema.nullable(),
});
export type NewsGraphEdge = z.infer<typeof NewsGraphEdgeSchema>;
export const NewsIndependenceScoreSchema = z.strictObject({
  valueBps: z.number().int().min(0).max(10000),
  interpretation: z.literal('ORIGIN_FRACTION_NOT_PROBABILITY'),
  affirmativeArticleOccurrences: z.number().int().min(0).max(1000),
  independentAffirmativeOrigins: z.number().int().min(0).max(1000),
  groups: z
    .array(
      z.strictObject({
        id: IdSchema,
        claimIds: z.array(IdSchema).max(1000),
        sourceIds: z.array(IdSchema).max(1000),
        rootClaimIds: z.array(IdSchema).max(1000),
        affirmative: z.boolean(),
        official: z.boolean(),
      }),
    )
    .max(1000),
});
export const NewsGraphClusterSchema = z.strictObject({
  id: IdSchema,
  identity: z.enum(['ANCHORED', 'PROVISIONAL']),
  claimIds: z.array(IdSchema).max(1000),
  activeClaimIds: z.array(IdSchema).max(1000),
  status: z.enum(['UNVERIFIED', 'CORROBORATED', 'OFFICIALLY_STATED', 'DISPUTED', 'RETRACTED']),
  firstKnownAt: UtcTimestampSchema,
  independence: NewsIndependenceScoreSchema,
  contradictions: z
    .array(
      z.strictObject({
        id: IdSchema,
        affirmed: z.array(IdSchema).max(1000),
        negated: z.array(IdSchema).max(1000),
        active: z.boolean(),
      }),
    )
    .max(1),
});
export const NewsGraphReviewSchema = z.strictObject({
  id: IdSchema,
  clusterId: IdSchema.nullable(),
  claimIds: z.array(IdSchema).max(1000),
  category: z.enum([
    'AMBIGUOUS_IDENTITY',
    'POSSIBLE_MATCH',
    'DETAIL_CONFLICT',
    'UNKNOWN_ORIGIN',
    'UNRESOLVED_ATTRIBUTION',
    'INFERRED_SYNDICATION',
    'CIRCULAR_ATTRIBUTION',
    'CONTRADICTION',
    'RETRACTION',
    'EXTRACTION_REVIEW',
  ]),
  detail: z.string().min(1).max(1000),
  knownAt: UtcTimestampSchema,
  status: z.enum(['OPEN', 'ACKNOWLEDGED']),
});
export const NewsGraphQuerySchema = z.strictObject({ decisionAt: UtcTimestampSchema });
export const NewsGraphViewSchema = z.strictObject({
  schemaVersion: z.literal('news-graph-view.v1'),
  execution: z.literal('DISABLED'),
  decisionAt: UtcTimestampSchema,
  config: NewsGraphConfigSchema,
  configHash: HashSchema,
  journalHeadHash: HashSchema,
  nodes: z.array(NewsGraphNodeSchema).max(1000),
  edges: z.array(NewsGraphEdgeSchema).max(10000),
  clusters: z.array(NewsGraphClusterSchema).max(1000),
  review: z.array(NewsGraphReviewSchema).max(10000),
  timeline: z
    .array(
      z.strictObject({
        recordHash: HashSchema,
        knownAt: UtcTimestampSchema,
        kind: z.enum(['OBSERVE', 'ACKNOWLEDGE', 'RETRACT', 'RESTORE', 'LINK']),
        claimIds: z.array(IdSchema).max(1000),
        operator: IdSchema.nullable(),
        reason: z.string().max(1000).nullable(),
      }),
    )
    .max(5000),
});
export const NewsGraphPersistenceSchema = z.strictObject({
  schemaVersion: z.literal('news-graph-persistence.v1'),
  created: z.number().int().min(0).max(5000),
  audit: z.strictObject({
    valid: z.literal(true),
    count: z.number().int().nonnegative(),
    headHash: HashSchema.nullable(),
  }),
});
export const NewsGraphBatchInputSchema = NewsExtractionBatchSchema.extend({
  persistence: z.array(NewsExtractionPersistenceSchema).max(100).optional(),
});
export const NewsGraphReviewQueueSchema = z.strictObject({
  schemaVersion: z.literal('news-graph-review-queue.v1'),
  decisionAt: UtcTimestampSchema,
  journalHeadHash: HashSchema,
  items: NewsGraphViewSchema.shape.review,
});
