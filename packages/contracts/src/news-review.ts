import { z } from 'zod';
import { HashSchema, IdSchema, UtcTimestampSchema } from './primitives.js';
import {
  AnyNewsParseResultSchema,
  NewsCaptureSchema,
  NewsDocumentVersionSchema,
  NewsRegistrySchema,
} from './news-ingest.js';

export const NewsTemporalClassSchema = z.enum([
  'POINT_IN_TIME_VERIFIED',
  'POINT_IN_TIME_ESTIMATED',
  'DESCRIPTIVE_ONLY',
]);
export const NewsReviewTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('DOCUMENT'), versionId: IdSchema }),
  z.strictObject({
    kind: z.literal('CAPTURE'),
    captureHash: HashSchema,
    itemIndex: z.number().int().min(0).max(99).nullable(),
  }),
]);
export const NewsReviewCategorySchema = z.enum([
  'UNPARSED',
  'LEGAL_RESTRICTIONS',
  'SUSPICIOUS_TIMESTAMP',
]);
export const NewsCorrectionActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ACKNOWLEDGE'), category: NewsReviewCategorySchema }),
  z.strictObject({ kind: z.literal('EXCLUDE') }),
  z.strictObject({ kind: z.literal('RESET') }),
  z.strictObject({
    kind: z.literal('SET_PUBLICATION_TIME'),
    publishedAt: UtcTimestampSchema.nullable(),
  }),
  z.strictObject({
    kind: z.literal('ESTIMATE_AVAILABILITY'),
    estimatedAvailableAt: UtcTimestampSchema,
    evidenceReferences: z.array(z.string().trim().min(1).max(1000)).min(1).max(5),
  }),
]);
export const NewsCorrectionRequestSchema = z.strictObject({
  schemaVersion: z.literal('news-correction-request.v1'),
  target: NewsReviewTargetSchema,
  operator: IdSchema,
  reason: z.string().trim().min(1).max(1000),
  expectedHeadHash: HashSchema,
  action: NewsCorrectionActionSchema,
});
export const NewsCorrectionRecordSchema = z.strictObject({
  schemaVersion: z.literal('news-correction-record.v1'),
  index: z.number().int().min(0).max(4999),
  previousHash: HashSchema,
  target: NewsReviewTargetSchema,
  targetHash: HashSchema,
  operator: IdSchema,
  reason: z.string().trim().min(1).max(1000),
  recordedAt: UtcTimestampSchema,
  codeVersion: z.string().min(1).max(200),
  action: NewsCorrectionActionSchema,
  hash: HashSchema,
});
export type NewsCorrectionRecord = z.infer<typeof NewsCorrectionRecordSchema>;
export type NewsReviewTarget = z.infer<typeof NewsReviewTargetSchema>;
export const NewsReviewQuerySchema = z.strictObject({ decisionAt: UtcTimestampSchema });
export const NewsArticleQuerySchema = NewsReviewQuerySchema.extend({
  mode: z.enum(['RESEARCH', 'REPLAY']).default('RESEARCH'),
  allowEstimated: z.boolean().default(false),
});
export const NewsReviewedDocumentSchema = z.strictObject({
  version: NewsDocumentVersionSchema,
  versionHash: HashSchema,
  temporalClass: NewsTemporalClassSchema,
  effectiveAvailableAt: UtcTimestampSchema.nullable(),
  effectivePublishedAt: UtcTimestampSchema.nullable(),
  excluded: z.boolean(),
  replayEligible: z.boolean(),
  correctionHashes: z.array(HashSchema).max(5000),
});
export type NewsReviewedDocument = z.infer<typeof NewsReviewedDocumentSchema>;
export const NewsArticleResultSchema = z.strictObject({
  schemaVersion: z.literal('news-reviewed-articles.v1'),
  decisionAt: UtcTimestampSchema,
  mode: z.enum(['RESEARCH', 'REPLAY']),
  allowEstimated: z.boolean(),
  correctionHeadHash: HashSchema,
  articles: z.array(NewsReviewedDocumentSchema).max(2000),
});
export const NewsReviewItemSchema = z.strictObject({
  id: IdSchema,
  target: NewsReviewTargetSchema,
  sourceId: IdSchema,
  sourceHash: HashSchema,
  category: NewsReviewCategorySchema,
  detail: z.string().min(1).max(1500),
  knownAt: UtcTimestampSchema,
  status: z.enum(['OPEN', 'ACKNOWLEDGED', 'EXCLUDED']),
  correctionHashes: z.array(HashSchema).max(5000),
});
export const NewsReviewQueueSchema = z.strictObject({
  schemaVersion: z.literal('news-review-queue.v1'),
  decisionAt: UtcTimestampSchema,
  correctionHeadHash: HashSchema,
  items: z.array(NewsReviewItemSchema).max(110000),
});
const counts = {
  articles: z.number().int().min(0).max(2000),
  verified: z.number().int().min(0).max(2000),
  estimated: z.number().int().min(0).max(2000),
  descriptive: z.number().int().min(0).max(2000),
};
export const NewsCoverageReportSchema = z.strictObject({
  schemaVersion: z.literal('news-coverage-report.v1'),
  decisionAt: UtcTimestampSchema,
  correctionHeadHash: HashSchema,
  ...counts,
  defensibleFirstObservedPercent: z
    .string()
    .regex(/^\d{1,3}\.\d{2}$/)
    .nullable(),
  replayEligible: z.number().int().min(0).max(2000),
  excluded: z.number().int().min(0).max(2000),
  unparsedFeeds: z.number().int().min(0).max(1000),
  rejectedItems: z.number().int().min(0).max(100000),
  languages: z
    .array(
      z.strictObject({
        language: z.string().min(2).max(20),
        ...counts,
        sourceIds: z.array(IdSchema).max(100),
      }),
    )
    .max(2000),
  sources: z
    .array(
      z.strictObject({
        sourceId: IdSchema,
        sourceHash: HashSchema,
        declaredLanguages: z.array(z.string()).max(20),
        observedLanguages: z.array(z.string()).max(2000),
        articles: z.number().int().min(0).max(2000),
      }),
    )
    .max(100),
});
// Export only policy-approved metadata, never raw feed bodies.
export const NewsSnapshotInputSchema = z.strictObject({
  registry: NewsRegistrySchema,
  captures: z
    .array(
      z.strictObject({
        capture: NewsCaptureSchema.refine((c) => c.raw === '' && c.rawRetention === 'HASH_ONLY'),
        parsed: AnyNewsParseResultSchema,
      }),
    )
    .max(1000),
});
export const NewsSnapshotRequestSchema = NewsArticleQuerySchema.extend({
  generatedAt: UtcTimestampSchema,
}).refine((r) => r.generatedAt >= r.decisionAt);
export const NewsSnapshotSchema = z.strictObject({
  schemaVersion: z.literal('news-snapshot.v1'),
  algorithmVersion: z.literal('news-review.v1'),
  clockSemantics: z.literal('utc-nanoseconds.v1'),
  execution: z.literal('DISABLED'),
  codeVersion: z.string().min(1).max(200),
  request: NewsSnapshotRequestSchema,
  input: NewsSnapshotInputSchema,
  inputHash: HashSchema,
  configHash: HashSchema,
  sourceHashes: z.array(HashSchema).max(100),
  versionHashes: z.array(HashSchema).max(2000),
  corrections: z.array(NewsCorrectionRecordSchema).max(5000),
  result: NewsArticleResultSchema,
  coverage: NewsCoverageReportSchema,
  review: NewsReviewQueueSchema,
});
export interface NewsReviewApi {
  queue(input: unknown): z.infer<typeof NewsReviewQueueSchema>;
  coverage(input: unknown): z.infer<typeof NewsCoverageReportSchema>;
  articles(input: unknown): z.infer<typeof NewsArticleResultSchema>;
  correct(input: unknown): Promise<NewsCorrectionRecord>;
}
export const NewsCorrectionPersistenceSchema = z.strictObject({
  schemaVersion: z.literal('news-correction-persistence.v1'),
  created: z.number().int().min(0).max(5000),
  audit: z.strictObject({
    valid: z.literal(true),
    count: z.number().int().nonnegative(),
    headHash: HashSchema.nullable(),
  }),
});
