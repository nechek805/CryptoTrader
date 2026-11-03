import { z } from 'zod';
import { DecimalStringSchema, HashSchema, IdSchema, UtcTimestampSchema } from './primitives.js';
import { NewsEventTypeSchema } from './news-extraction.js';
import {
  NewsGraphConfigSchema,
  NewsGraphRecordSchema,
  NewsGraphViewSchema,
  NewsIndependenceScoreSchema,
} from './news-graph.js';

export const NewsEventConfigSchema = z.strictObject({
  schemaVersion: z.literal('news-event-config.v1'),
  algorithmVersion: z.literal('news-temporal-events.v1'),
  noveltyWindowHours: z.number().int().min(1).max(168),
});
const symbol = z.string().regex(/^[A-Z][A-Z0-9]{0,19}$/);
const expectedAmount = z.strictObject({ value: DecimalStringSchema, unit: symbol });
export const NewsEventActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('MERGE'),
    eventIds: z.array(IdSchema).min(2).max(20),
    label: z.string().trim().min(1).max(100),
  }),
  z.strictObject({
    kind: z.literal('SPLIT'),
    eventId: IdSchema,
    partitions: z
      .array(
        z.strictObject({
          label: z.string().trim().min(1).max(100),
          claimIds: z.array(IdSchema).min(1).max(1000),
        }),
      )
      .min(2)
      .max(20),
  }),
  z.strictObject({
    kind: z.literal('MAP_ASSET'),
    subject: z.string().trim().min(1).max(100),
    eventTypes: z.array(NewsEventTypeSchema).min(1).max(10),
    symbol,
    relationship: z.enum(['DIRECT', 'SECOND_ORDER']),
    reference: z.string().trim().min(1).max(1000),
  }),
  z.strictObject({
    kind: z.literal('EXPECT'),
    anchorKey: z.string().trim().min(1).max(100),
    subject: z.string().trim().min(1).max(100),
    eventType: NewsEventTypeSchema,
    amounts: z.array(expectedAmount).min(1).max(10),
    reference: z.string().trim().min(1).max(1000),
  }),
]);
export const NewsEventDecisionSchema = z.strictObject({
  schemaVersion: z.literal('news-event-decision.v1'),
  expectedGraphHeadHash: HashSchema,
  expectedHeadHash: HashSchema,
  operator: IdSchema,
  reason: z.string().trim().min(1).max(1000),
  action: NewsEventActionSchema,
});
export const NewsEventIdentitySchema = z.strictObject({
  id: IdSchema,
  kind: z.enum(['BASE', 'MERGED', 'SPLIT', 'UNASSIGNED']),
  label: z.string().min(1).max(100),
  claimIds: z.array(IdSchema).max(1000),
  baseClusterIds: z.array(IdSchema).max(1000),
  parentIds: z.array(IdSchema).max(20),
  createdAt: UtcTimestampSchema,
});
export type NewsEventIdentity = z.infer<typeof NewsEventIdentitySchema>;
export const NewsEventRecordSchema = z.strictObject({
  schemaVersion: z.literal('news-event-record.v1'),
  index: z.number().int().min(0).max(4999),
  previousHash: HashSchema,
  configHash: HashSchema,
  graphHeadHash: HashSchema,
  codeVersion: z.string().min(1).max(200),
  recordedAt: UtcTimestampSchema,
  operator: IdSchema,
  reason: z.string().trim().min(1).max(1000),
  action: NewsEventActionSchema,
  targetHash: HashSchema,
  resolution: z.strictObject({
    parents: z.array(NewsEventIdentitySchema).max(20),
    children: z.array(NewsEventIdentitySchema).max(20),
  }),
  hash: HashSchema,
});
export type NewsEventRecord = z.infer<typeof NewsEventRecordSchema>;
export const NewsEventQuerySchema = z.strictObject({
  decisionAt: UtcTimestampSchema,
  graphHeadHash: HashSchema.optional(),
  metadataHeadHash: HashSchema.optional(),
});
const milestone = z.strictObject({
  sourceKnownAt: UtcTimestampSchema,
  eventKnownAt: UtcTimestampSchema,
  claimIds: z.array(IdSchema).min(1).max(1000),
  recordHash: HashSchema,
});
const correction = z.strictObject({
  knownAt: UtcTimestampSchema,
  kind: z.string().min(1).max(40),
  recordHash: HashSchema,
  operator: IdSchema.nullable(),
  reason: z.string().max(1000).nullable(),
});
export const NewsTemporalEventSchema = z.strictObject({
  identity: NewsEventIdentitySchema,
  active: z.boolean(),
  supersededBy: z.array(IdSchema).max(100),
  status: NewsGraphViewSchema.shape.clusters.element.shape.status,
  firstKnownAt: UtcTimestampSchema,
  lastUpdatedAt: UtcTimestampSchema,
  availableAt: UtcTimestampSchema.nullable(),
  replayEligible: z.boolean(),
  confidence: z.strictObject({
    grade: z.enum([
      'UNVERIFIED',
      'ATTRIBUTED',
      'MULTI_ORIGIN',
      'DISPUTED',
      'WITHDRAWN',
      'IDENTITY_REVIEW',
    ]),
    explanation: z.array(z.string().min(1).max(1000)).min(1).max(12),
    uncertaintyBand: z.strictObject({
      interpretation: z.literal('UNAUTHENTICATED_ORIGIN_COUNT_NOT_PROBABILITY'),
      minimumOrigins: z.literal(0),
      maximumOrigins: z.number().int().min(0).max(1000),
    }),
  }),
  independence: NewsIndependenceScoreSchema,
  history: z.strictObject({
    firstRumor: milestone.nullable(),
    firstIndependentCorroboration: milestone.nullable(),
    firstOfficialStatement: milestone.nullable(),
    corrections: z.array(correction).max(10000),
    sourceReviewHashes: z.array(HashSchema).max(5000),
  }),
  assets: z
    .array(
      z.strictObject({
        symbol,
        relationship: z.enum(['MENTION_ONLY', 'DIRECT', 'SECOND_ORDER']),
        knownAt: UtcTimestampSchema,
        claimIds: z.array(IdSchema).max(1000),
        ruleHash: HashSchema.nullable(),
        reference: z.string().max(1000).nullable(),
        rationale: z.string().min(1).max(1000),
      }),
    )
    .max(2000),
  novelty: z.strictObject({
    pattern: z.enum(['FIRST_SEEN_IN_CORPUS', 'REPEATED_PATTERN', 'UNKNOWN']),
    priorEventIds: z.array(IdSchema).max(1000),
    updateKind: z.enum(['NEW_REPORT', 'REPOST_ONLY', 'CORRECTION', 'REVIEW_ONLY', 'UNKNOWN']),
    rationale: z.string().min(1).max(1000),
  }),
  surprise: z.strictObject({
    marker: z.enum(['UNKNOWN', 'SCHEDULED_MATCH', 'EXPECTATION_MISMATCH', 'NOT_COMPARABLE']),
    expectationHash: HashSchema.nullable(),
    rationale: z.string().min(1).max(1000),
  }),
  abstentionReasons: z.array(z.string().min(1).max(100)).max(10),
});
export const NewsEventViewSchema = z.strictObject({
  schemaVersion: z.literal('news-event-view.v1'),
  execution: z.literal('DISABLED'),
  decisionAt: UtcTimestampSchema,
  graphHeadHash: HashSchema,
  metadataHeadHash: HashSchema,
  config: NewsEventConfigSchema,
  graph: NewsGraphViewSchema,
  events: z.array(NewsTemporalEventSchema).max(3000),
});
export const NewsEventSnapshotRequestSchema = NewsEventQuerySchema.extend({
  generatedAt: UtcTimestampSchema,
}).refine((r) => r.generatedAt >= r.decisionAt);
export const NewsEventSnapshotSchema = z.strictObject({
  schemaVersion: z.literal('news-event-snapshot.v1'),
  execution: z.literal('DISABLED'),
  algorithmVersion: z.literal('news-temporal-events.v1'),
  clockSemantics: z.literal('utc-nanoseconds.v1'),
  randomSeed: z.literal(0),
  codeVersion: z.string().min(1).max(200),
  request: NewsEventSnapshotRequestSchema,
  config: NewsEventConfigSchema,
  graphConfig: NewsGraphConfigSchema,
  input: z.strictObject({
    graphRecords: z.array(NewsGraphRecordSchema).max(5000),
    metadataRecords: z.array(NewsEventRecordSchema).max(5000),
  }),
  inputHash: HashSchema,
  configHash: HashSchema,
  view: NewsEventViewSchema,
});
export const NewsEventInputsSchema = z.strictObject({
  schemaVersion: z.literal('news-event-research-inputs.v1'),
  decisionAt: UtcTimestampSchema,
  purpose: z.enum(['EVENT_STUDY', 'NEWS_SIGNAL_INPUT']),
  events: z.array(NewsTemporalEventSchema).max(3000),
});
export const NewsEventPersistenceSchema = z.strictObject({
  schemaVersion: z.literal('news-event-persistence.v1'),
  created: z.number().int().min(0).max(5001),
  audit: z.strictObject({
    valid: z.literal(true),
    count: z.number().int().nonnegative(),
    headHash: HashSchema.nullable(),
  }),
});
