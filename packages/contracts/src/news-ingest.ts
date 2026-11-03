import { z } from 'zod';
import { NewsDocumentSchema } from './domain.js';
import { HashSchema, IdSchema, UtcTimestampSchema } from './primitives.js';

export const NewsProviderRecordSchema = z.strictObject({
  schemaVersion: z.literal('news-provider.v1'),
  id: IdSchema,
  version: z.string().min(1).max(100),
  kind: z.enum(['FIXTURE', 'RSS_ATOM', 'JSON_FEED', 'GDELT']),
  enabled: z.boolean(),
  reference: z.string().min(1).max(2000),
  knownAt: UtcTimestampSchema,
});
export const NewsSourceSchema = z
  .strictObject({
    schemaVersion: z.literal('news-source.v1'),
    id: IdSchema,
    version: z.number().int().positive(),
    providerId: IdSchema,
    owner: z.string().min(1).max(200),
    region: z.string().min(1).max(100),
    reliabilityNotes: z.string().min(1).max(1000),
    publicationType: z.enum([
      'OFFICIAL_SECURITY',
      'INDEPENDENT_REPORTING',
      'SYNDICATED',
      'UNVERIFIED_RUMOR',
    ]),
    independenceGroup: IdSchema,
    languages: z
      .array(z.string().regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/))
      .min(1)
      .max(20),
    feedUrl: z.string().url().max(2000),
    articleOrigins: z.array(z.string().url().max(2000)).min(1).max(10),
    format: z.enum(['RSS2', 'ATOM', 'JSON_FEED_1_1']),
    accessMethod: z.enum(['FIXTURE', 'PUBLIC_HTTPS']),
    updateCadenceSeconds: z.number().int().min(1).max(86400),
    polling: z.strictObject({
      minIntervalSeconds: z.number().int().min(1).max(86400),
      maxRequestsPerDay: z.number().int().min(1).max(1440),
    }),
    allowedFields: z
      .array(z.enum(['id', 'url', 'title', 'language', 'publishedAt', 'updatedAt', 'snippet']))
      .min(3)
      .max(7)
      .refine(
        (v) =>
          new Set(v).size === v.length &&
          ['id', 'url', 'title'].every((f) => v.includes(f as 'id')),
        'Require unique identity/title fields',
      ),
    licensing: z.strictObject({
      policy: z.enum(['SYNTHETIC', 'METADATA_ONLY', 'LICENSED', 'OFFICIAL_PUBLIC']),
      reference: z.string().min(1).max(2000),
      restrictions: z.string().min(1).max(1000),
      permitsSnippet: z.boolean(),
      maxSnippetChars: z.number().int().min(0).max(1000),
      permitsRawStorage: z.boolean(),
      approvedForLive: z.boolean(),
    }),
    limits: z.strictObject({
      maxBytes: z.number().int().min(128).max(262144),
      maxItems: z.number().int().min(1).max(100),
      timeoutMs: z.number().int().min(100).max(10000),
    }),
    knownAt: UtcTimestampSchema,
  })
  .superRefine((s, ctx) => {
    if (
      (s.allowedFields.includes('snippet') &&
        (!s.licensing.permitsSnippet || s.licensing.maxSnippetChars === 0)) ||
      (!s.licensing.permitsSnippet && s.licensing.maxSnippetChars !== 0)
    )
      ctx.addIssue({ code: 'custom', message: 'Snippet field exceeds source license' });
    if (
      s.accessMethod === 'FIXTURE' &&
      (s.licensing.policy !== 'SYNTHETIC' || s.licensing.approvedForLive)
    )
      ctx.addIssue({ code: 'custom', message: 'Fixture policy mismatch' });
    if (s.licensing.approvedForLive && s.licensing.policy === 'SYNTHETIC')
      ctx.addIssue({ code: 'custom', message: 'Synthetic sources cannot enable live access' });
  });
export type NewsSource = z.infer<typeof NewsSourceSchema>;
export const NewsRegistrySchema = z.strictObject({
  schemaVersion: z.literal('news-registry.v1'),
  providers: z.array(NewsProviderRecordSchema).min(1).max(20),
  sources: z.array(NewsSourceSchema).min(1).max(100),
});
export const NewsCaptureSchema = z
  .strictObject({
    schemaVersion: z.literal('news-capture.v1'),
    sourceId: IdSchema,
    sourceVersion: z.number().int().positive(),
    feedUrl: z.string().url().max(2000),
    origin: z.enum(['FIXTURE', 'PUBLIC_READ_ONLY']),
    observedAt: UtcTimestampSchema,
    processedAt: UtcTimestampSchema,
    availabilityEvidence: z.enum(['OBSERVED', 'ARCHIVED_CAPTURE', 'UNKNOWN']),
    raw: z.string().max(262144),
    rawHash: HashSchema,
    rawRetention: z.enum(['RETAINED', 'HASH_ONLY']),
  })
  .refine((v) => v.processedAt >= v.observedAt);
export type NewsCapture = z.infer<typeof NewsCaptureSchema>;
export const ParsedNewsItemSchema = z.strictObject({
  schemaVersion: z.literal('parsed-news-item.v1'),
  providerItemId: z.string().min(1).max(500),
  canonicalUrl: z.string().url().max(2000),
  title: z.string().min(1).max(500),
  language: z.string().min(2).max(20),
  publishedAt: UtcTimestampSchema.nullable(),
  updatedAt: UtcTimestampSchema.nullable(),
  rawPublishedAt: z.string().max(100).nullable(),
  rawUpdatedAt: z.string().max(100).nullable(),
  approvedSnippet: z.string().max(1000).nullable(),
  contentHash: HashSchema,
  timestampStatus: z.enum(['VALID', 'MISSING', 'UNCERTAIN']),
});
export type ParsedNewsItem = z.infer<typeof ParsedNewsItemSchema>;
export const NewsParseResultSchema = z.strictObject({
  schemaVersion: z.literal('news-parse-result.v1'),
  parserVersion: z.literal('news-feed-parser.v1'),
  sourceId: IdSchema,
  rawHash: HashSchema,
  feedStatus: z.enum(['PARSED', 'REJECTED']),
  feedError: z.enum(['FORMAT', 'LIMIT']).nullable(),
  items: z.array(ParsedNewsItemSchema).max(100),
  rejected: z
    .array(
      z.strictObject({
        index: z.number().int().nonnegative(),
        reason: z.enum([
          'ITEM_SCHEMA',
          'ARTICLE_URL',
          'TIMESTAMP',
          'LANGUAGE',
          'DUPLICATE_ID',
          'TEXT',
        ]),
      }),
    )
    .max(100),
});
export const NewsDocumentVersionSchema = z.strictObject({
  schemaVersion: z.literal('news-document-version.v1'),
  versionId: IdSchema,
  entityId: IdSchema,
  revision: z.number().int().positive(),
  previousVersionId: IdSchema.nullable(),
  providerItemId: z.string().min(1).max(500),
  sourceVersion: z.number().int().positive(),
  sourceHash: HashSchema,
  captureHash: HashSchema,
  rawHash: HashSchema,
  contentHash: HashSchema,
  observedAt: UtcTimestampSchema,
  processedAt: UtcTimestampSchema,
  updatedAt: UtcTimestampSchema.nullable(),
  rawPublishedAt: z.string().max(100).nullable(),
  rawUpdatedAt: z.string().max(100).nullable(),
  independenceGroup: IdSchema,
  publicationType: NewsSourceSchema.shape.publicationType,
  document: NewsDocumentSchema,
});
export type NewsDocumentVersion = z.infer<typeof NewsDocumentVersionSchema>;
export const NewsStoreSchema = z.strictObject({
  schemaVersion: z.literal('news-store.v1'),
  registry: NewsRegistrySchema,
  captures: z.array(NewsCaptureSchema).max(1000),
  parseResults: z.array(NewsParseResultSchema).max(1000),
  documents: z.array(NewsDocumentVersionSchema).max(2000),
});
// Live receipts keep malformed provider dates as uncertain evidence instead of losing titles.
export const NewsParseResultV2Schema = NewsParseResultSchema.extend({
  schemaVersion: z.literal('news-parse-result.v2'),
  parserVersion: z.literal('news-feed-parser.v2'),
});
export const AnyNewsParseResultSchema = z.union([NewsParseResultSchema, NewsParseResultV2Schema]);
export const NewsStoreV2Schema = NewsStoreSchema.extend({
  schemaVersion: z.literal('news-store.v2'),
  parseResults: z.array(AnyNewsParseResultSchema).max(1000),
});
