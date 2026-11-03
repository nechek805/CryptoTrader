import { z } from 'zod';
import { HashSchema, IdSchema, UtcTimestampSchema } from './primitives.js';
import { NewsCaptureSchema, AnyNewsParseResultSchema, NewsRegistrySchema } from './news-ingest.js';

export const NewsPollConfigSchema = z
  .strictObject({
    schemaVersion: z.literal('news-poll-config.v1'),
    registry: NewsRegistrySchema,
    gates: z
      .array(
        z.strictObject({
          sourceId: IdSchema,
          role: z.enum(['OFFICIAL', 'AGGREGATION', 'FIXTURE']),
          reviewedAt: UtcTimestampSchema,
          expiresAt: UtcTimestampSchema,
          references: z.array(z.string().url()).min(1).max(5),
          rationale: z.string().min(1).max(1500),
          citation: z.string().min(1).max(500),
        }),
      )
      .min(1)
      .max(10),
    maxAttempts: z.number().int().min(1).max(5),
    baseBackoffMs: z.number().int().min(1000).max(60000),
    maxBackoffMs: z.number().int().min(1000).max(3600000),
    minGlobalIntervalMs: z.number().int().min(250).max(60000),
  })
  .refine((v) => v.maxBackoffMs >= v.baseBackoffMs);
export type NewsPollConfig = z.infer<typeof NewsPollConfigSchema>;
const common = {
  sourceId: IdSchema,
  cycleId: IdSchema,
  attempt: z.number().int().min(1).max(5),
  at: UtcTimestampSchema,
};
export const NewsPollActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...common, kind: z.literal('RESERVED') }),
  z.strictObject({
    ...common,
    kind: z.literal('SUCCEEDED'),
    capture: NewsCaptureSchema,
    parsed: AnyNewsParseResultSchema,
    requestStartedAt: UtcTimestampSchema,
    networkLatencyNs: z.string().regex(/^\d+$/),
    processingLatencyNs: z.string().regex(/^\d+$/),
  }),
  z.strictObject({
    ...common,
    kind: z.literal('FAILED'),
    reason: z.enum(['NETWORK', 'HTTP', 'RATE_LIMIT', 'POLICY', 'FORMAT', 'INTERRUPTED', 'CLOCK']),
    status: z.number().int().min(100).max(599).nullable(),
    retryAt: UtcTimestampSchema.nullable(),
    deadLetter: z.boolean(),
  }),
]);
export type NewsPollAction = z.infer<typeof NewsPollActionSchema>;
export const NewsPollRecordSchema = z.strictObject({
  schemaVersion: z.literal('news-poll-record.v1'),
  index: z.number().int().nonnegative().max(4999),
  previousHash: HashSchema,
  configHash: HashSchema,
  codeVersion: z.string().min(1).max(200),
  action: NewsPollActionSchema,
  hash: HashSchema,
});
export const NewsDeliverySchema = z.strictObject({
  schemaVersion: z.literal('news-delivery.v1'),
  id: IdSchema,
  captureHash: HashSchema,
  sourceId: IdSchema,
  providerItemId: z.string().min(1).max(500),
  entityId: IdSchema,
  versionId: IdSchema,
  originalUrl: z.string().url().max(2000),
  canonicalUrl: z.string().url().max(2000),
  approvedTextHash: HashSchema,
  observedAt: UtcTimestampSchema,
  availableAt: UtcTimestampSchema,
  independenceGroup: IdSchema,
  publicationLagNs: z
    .string()
    .regex(/^-?\d+$/)
    .nullable(),
});
export type NewsDelivery = z.infer<typeof NewsDeliverySchema>;
export const NewsDuplicateViewSchema = z.strictObject({
  schemaVersion: z.literal('news-duplicate-view.v1'),
  decisionAt: UtcTimestampSchema,
  groups: z
    .array(
      z.strictObject({
        id: IdSchema,
        firstObservedAt: UtcTimestampSchema,
        deliveryIds: z.array(IdSchema).max(5000),
        sourceIds: z.array(IdSchema).max(100),
        independenceGroups: z.array(IdSchema).max(100),
        possibleDependency: z.boolean(),
        confirmedFacts: z.literal(0),
      }),
    )
    .max(5000),
});
export const NewsPollReportSchema = z.strictObject({
  schemaVersion: z.literal('news-poll-report.v1'),
  execution: z.literal('DISABLED'),
  configHash: HashSchema,
  journalHead: HashSchema.nullable(),
  records: z.number().int().min(0).max(5000),
  captures: z.number().int().min(0).max(1000),
  versions: z.number().int().min(0).max(2000),
  deliveries: z.number().int().min(0).max(5000),
  rejectedItems: z.number().int().min(0).max(100000),
  uncertainTimestamps: z.number().int().min(0).max(100000),
  duplicateView: NewsDuplicateViewSchema,
  jobs: z
    .array(
      z.strictObject({
        sourceId: IdSchema,
        nextAt: UtcTimestampSchema.nullable(),
        deadLetter: z.boolean(),
      }),
    )
    .max(10),
  deadLetters: z
    .array(NewsPollActionSchema)
    .max(5000)
    .refine((v) => v.every((a) => a.kind === 'FAILED' && a.deadLetter)),
  stateHash: HashSchema,
});
