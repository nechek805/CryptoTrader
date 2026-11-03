import { z } from 'zod';
import { DecimalStringSchema, HashSchema, IdSchema, UtcTimestampSchema } from './primitives.js';
import { EventClaimSchema } from './domain.js';
import { NewsSourceSchema } from './news-ingest.js';
import { NewsReviewedDocumentSchema } from './news-review.js';

export const NewsEventTypeSchema = z.enum([
  'SECURITY_INCIDENT',
  'INSOLVENCY',
  'REGULATORY_ACTION',
  'EXCHANGE_OUTAGE',
  'LISTING',
  'DELISTING',
  'ETF_DECISION',
  'TOKEN_UNLOCK',
  'RATE_ANNOUNCEMENT',
  'MACRO_SHOCK',
]);
export const NewsOntologySchema = z.strictObject({
  schemaVersion: z.literal('news-event-ontology.v1'),
  version: IdSchema,
  events: z
    .array(
      z.strictObject({
        type: NewsEventTypeSchema,
        predicate: IdSchema,
        triggers: z
          .array(
            z.strictObject({
              language: z.enum(['en', 'ru']),
              text: z.string().trim().min(2).max(100),
            }),
          )
          .min(1)
          .max(20),
      }),
    )
    .min(1)
    .max(20)
    .refine((v) => new Set(v.map((e) => e.type)).size === v.length),
  entities: z
    .array(
      z.strictObject({
        name: z.string().min(1).max(100),
        kind: z.enum(['ORGANIZATION', 'PERSON', 'REGULATOR', 'ASSET']),
        aliases: z.array(z.string().min(2).max(100)).min(1).max(10),
        asset: z
          .string()
          .regex(/^[A-Z][A-Z0-9]{0,19}$/)
          .nullable(),
      }),
    )
    .max(100),
  units: z
    .array(
      z.strictObject({
        symbol: z.string().regex(/^[A-Z][A-Z0-9]{0,19}$/),
        kind: z.enum(['CURRENCY', 'TOKEN']),
      }),
    )
    .max(40)
    .refine((v) => new Set(v.map((u) => u.symbol)).size === v.length),
});
export type NewsOntology = z.infer<typeof NewsOntologySchema>;
export const NewsEvidenceSpanSchema = z
  .strictObject({
    start: z.number().int().min(0).max(1500),
    end: z.number().int().min(1).max(1500),
    text: z.string().min(1).max(1500),
  })
  .refine((v) => v.end > v.start);
const amount = z.strictObject({
  evidence: NewsEvidenceSpanSchema,
  value: DecimalStringSchema.nullable(),
  unit: z
    .string()
    .regex(/^[A-Z][A-Z0-9]{0,19}$/)
    .nullable(),
  kind: z.enum(['CURRENCY', 'TOKEN', 'PERCENT', 'UNKNOWN']),
});
export const NewsExtractionCandidateSchema = z.strictObject({
  eventType: NewsEventTypeSchema,
  predicate: IdSchema,
  language: z.enum(['en', 'ru']),
  evidence: NewsEvidenceSpanSchema,
  trigger: NewsEvidenceSpanSchema,
  subject: NewsEvidenceSpanSchema.nullable(),
  polarity: z.enum(['AFFIRMED', 'NEGATED', 'UNCERTAIN']),
  amounts: z.array(amount).max(10),
  eventTime: z.strictObject({
    evidence: NewsEvidenceSpanSchema.nullable(),
    granularity: z.enum(['SECOND', 'MINUTE', 'DAY', 'MONTH', 'YEAR', 'UNKNOWN']),
    at: UtcTimestampSchema.nullable(),
  }),
  entities: z
    .array(
      z.strictObject({
        name: z.string().min(1).max(100),
        kind: z.enum(['ORGANIZATION', 'PERSON', 'REGULATOR', 'ASSET']),
        evidence: NewsEvidenceSpanSchema,
      }),
    )
    .max(20),
  affectedAssets: z
    .array(
      z.strictObject({
        symbol: z.string().regex(/^[A-Z][A-Z0-9]{0,19}$/),
        relationship: z.literal('MENTIONED'),
        evidence: NewsEvidenceSpanSchema,
      }),
    )
    .max(20),
  unknownFields: z
    .array(z.enum(['SUBJECT', 'AMOUNT', 'EVENT_TIME', 'ASSETS', 'ENTITIES', 'POLARITY']))
    .max(6),
});
export type NewsExtractionCandidate = z.infer<typeof NewsExtractionCandidateSchema>;
export const NewsStructuredResponseSchema = z.strictObject({
  schemaVersion: z.literal('news-structured-extraction.v1'),
  candidates: z.array(NewsExtractionCandidateSchema).max(20),
});
export const NewsExtractionInputSchema = z.strictObject({
  schemaVersion: z.literal('news-extraction-input.v1'),
  article: NewsReviewedDocumentSchema,
  source: NewsSourceSchema,
  field: z.enum(['TITLE', 'APPROVED_SNIPPET']),
  dataCutoff: UtcTimestampSchema,
});
export type NewsExtractionInput = z.infer<typeof NewsExtractionInputSchema>;
export const NewsExtractorDescriptorSchema = z.strictObject({
  kind: z.enum(['DETERMINISTIC', 'INJECTED_STRUCTURED']),
  modelVersion: IdSchema,
  promptVersion: IdSchema,
});
export const NewsExtractionConfigSchema = z.strictObject({
  ontology: NewsOntologySchema,
  maxRequests: z.number().int().min(1).max(1000),
  minIntervalMs: z.number().int().min(0).max(60000),
  timeoutMs: z.number().int().min(10).max(10000),
  maxResponseBytes: z.number().int().min(128).max(131072),
});
export const NewsExtractionResultSchema = z
  .strictObject({
    schemaVersion: z.literal('news-extraction-result.v1'),
    execution: z.literal('DISABLED'),
    input: NewsExtractionInputSchema,
    inputHash: HashSchema,
    config: NewsExtractionConfigSchema,
    configHash: HashSchema,
    ontologyHash: HashSchema,
    promptHash: HashSchema,
    adapter: NewsExtractorDescriptorSchema,
    codeVersion: z.string().min(1).max(200),
    randomSeed: z.literal(0),
    offsetUnit: z.literal('UTF16_CODE_UNIT'),
    startedAt: UtcTimestampSchema,
    processedAt: UtcTimestampSchema,
    responseHash: HashSchema.nullable(),
    status: z.enum(['EXTRACTED', 'REVIEW_NEEDED']),
    reviewReasons: z
      .array(
        z.enum([
          'INPUT_POLICY',
          'FUTURE_OR_EXCLUDED',
          'UNSUPPORTED_LANGUAGE',
          'INSTRUCTION_LIKE_TEXT',
          'NO_CANDIDATES',
          'INVALID_RESPONSE',
          'UNGROUNDED_RESPONSE',
          'AMBIGUOUS_FIELDS',
          'RATE_LIMIT',
          'TIMEOUT',
          'ADAPTER_ERROR',
        ]),
      )
      .max(12),
    claims: z
      .array(
        z.strictObject({
          id: IdSchema,
          candidate: NewsExtractionCandidateSchema,
          canonical: EventClaimSchema,
        }),
      )
      .max(20),
    cost: z.strictObject({
      status: z.enum(['ZERO_EXTERNAL_COST', 'UNKNOWN']),
      amount: DecimalStringSchema.nullable(),
      currency: z.literal('USD'),
    }),
  })
  .refine(
    (v) =>
      v.processedAt >= v.startedAt &&
      v.claims.every(
        (c) =>
          c.canonical.verifiedStatus === 'UNVERIFIED' &&
          c.canonical.id === c.id &&
          c.canonical.firstKnownAt === v.processedAt &&
          (c.canonical.availableAt === null || c.canonical.availableAt >= v.processedAt),
      ),
  );
export type NewsExtractionResult = z.infer<typeof NewsExtractionResultSchema>;
export const NewsExtractionBatchSchema = z.strictObject({
  schemaVersion: z.literal('news-extraction-batch.v1'),
  execution: z.literal('DISABLED'),
  snapshotHash: HashSchema.nullable(),
  results: z.array(NewsExtractionResultSchema).max(100),
});
export const NewsExtractionPersistenceSchema = z.strictObject({
  schemaVersion: z.literal('news-extraction-persistence.v1'),
  created: z.boolean(),
  hash: HashSchema,
  audit: z.strictObject({
    valid: z.literal(true),
    count: z.number().int().nonnegative(),
    headHash: HashSchema.nullable(),
  }),
});
