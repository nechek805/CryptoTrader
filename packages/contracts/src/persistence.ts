import { z } from 'zod';
import { EventEnvelopeSchema, ExperimentManifestSchema } from './domain.js';
import { HashSchema, IdSchema, ReproducibilitySchema, UtcTimestampSchema } from './primitives.js';

export const DatabaseOptionsSchema = z.strictObject({
  connectionString: z.url({ protocol: /^postgres(?:ql)?$/ }),
  schema: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,62}$/)
    .default('crypto_research'),
});
export type DatabaseOptions = z.input<typeof DatabaseOptionsSchema>;
export const SequenceSchema = z.string().regex(/^[1-9]\d*$/);
export const PageRequestSchema = z.strictObject({
  limit: z.number().int().min(1).max(500).default(100),
  cursor: z.string().min(1).max(2048).optional(),
  includeArchived: z.boolean().default(false),
});
export type PageRequest = z.input<typeof PageRequestSchema>;
export type Page<T> = { items: T[]; nextCursor: string | null };

export const RawIngestSchema = z.strictObject({
  envelope: EventEnvelopeSchema,
  sourceRawId: IdSchema.nullable(),
});
export const StoredRawEventSchema = z.strictObject({
  schemaVersion: z.literal('stored-raw-event.v1'),
  id: IdSchema,
  sequence: SequenceSchema,
  contentHash: HashSchema,
  storedAt: UtcTimestampSchema,
  envelope: EventEnvelopeSchema,
});
export type StoredRawEvent = z.infer<typeof StoredRawEventSchema>;

export const DerivedKindSchema = z.enum(['MARKET_BAR', 'NEWS_DOCUMENT']);
export type DerivedKind = z.infer<typeof DerivedKindSchema>;
export const RevisionOptionsSchema = z.strictObject({
  knownAt: UtcTimestampSchema,
  sourceRawIds: z
    .array(IdSchema)
    .min(1)
    .refine((ids) => new Set(ids).size === ids.length, 'Duplicate source reference'),
  previousVersionId: IdSchema.nullable(),
});
export type RevisionOptions = z.input<typeof RevisionOptionsSchema>;
export function storedRevisionSchema<T extends z.ZodType>(record: T) {
  return z.strictObject({
    schemaVersion: z.literal('stored-revision.v1'),
    versionId: IdSchema,
    entityId: IdSchema,
    kind: DerivedKindSchema,
    revision: z.number().int().positive(),
    previousVersionId: IdSchema.nullable(),
    sourceRawIds: z.array(IdSchema).min(1),
    contentHash: HashSchema,
    sequence: SequenceSchema,
    storedAt: UtcTimestampSchema,
    knownAt: UtcTimestampSchema,
    record,
  });
}
export type StoredRevision<T> = {
  schemaVersion: 'stored-revision.v1';
  versionId: string;
  entityId: string;
  kind: DerivedKind;
  revision: number;
  previousVersionId: string | null;
  sourceRawIds: string[];
  contentHash: string;
  sequence: string;
  storedAt: z.infer<typeof UtcTimestampSchema>;
  knownAt: z.infer<typeof UtcTimestampSchema>;
  record: T;
};

export const InputReferenceSchema = z.strictObject({
  kind: z.enum(['RAW_EVENT', 'MARKET_BAR', 'NEWS_DOCUMENT']),
  id: IdSchema,
  contentHash: HashSchema,
});
export type InputReference = z.infer<typeof InputReferenceSchema>;
export const InputReferencesSchema = z
  .array(InputReferenceSchema)
  .min(1)
  .refine(
    (refs) => new Set(refs.map((ref) => `${ref.kind}:${ref.id}`)).size === refs.length,
    'Duplicate input reference',
  );
export const ResearchRunSchema = z
  .strictObject({
    schemaVersion: z.literal('research-run.v1'),
    id: IdSchema,
    purpose: z.enum(['FIXTURE_IMPORT', 'BACKTEST', 'FORWARD_PAPER', 'DESCRIPTIVE_STUDY']),
    execution: z.literal('SIMULATED'),
    experimentId: IdSchema.nullable(),
    startedAt: UtcTimestampSchema,
    completedAt: UtcTimestampSchema,
    status: z.enum(['SUCCEEDED', 'FAILED']),
    reproducibility: ReproducibilitySchema,
  })
  .superRefine((run, ctx) => {
    if (run.completedAt < run.startedAt || run.reproducibility.generatedAt < run.completedAt) {
      ctx.addIssue({
        code: 'custom',
        message: 'Run completion/generation timestamps are out of order',
      });
    }
  });
export type ResearchRun = z.infer<typeof ResearchRunSchema>;
export const StoredResearchRecordSchema = z.strictObject({
  schemaVersion: z.literal('stored-research-record.v1'),
  id: IdSchema,
  sequence: SequenceSchema,
  contentHash: HashSchema,
  storedAt: UtcTimestampSchema,
  inputs: InputReferencesSchema,
  record: z.union([ResearchRunSchema, ExperimentManifestSchema]),
});
export type StoredResearchRecord = z.infer<typeof StoredResearchRecordSchema>;

export const AuditActionSchema = z.enum([
  'RAW_INGESTED',
  'RAW_ALIAS_LINKED',
  'REVISION_APPENDED',
  'RUN_RECORDED',
  'EXPERIMENT_RECORDED',
  'RETENTION_ARCHIVED',
]);
export const AuditEntitySchema = z.enum([
  'RAW_EVENT',
  'MARKET_BAR',
  'NEWS_DOCUMENT',
  'RUN',
  'EXPERIMENT',
]);
export const AuditEntrySchema = z.strictObject({
  schemaVersion: z.literal('audit-entry.v1'),
  id: IdSchema,
  sequence: SequenceSchema,
  action: AuditActionSchema,
  entityType: AuditEntitySchema,
  entityId: IdSchema,
  occurredAt: UtcTimestampSchema,
  contentHash: HashSchema,
  previousHash: HashSchema.nullable(),
  entryHash: HashSchema,
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;
export const RetentionRequestSchema = z.strictObject({
  kind: z.enum(['RAW_EVENT', 'MARKET_BAR', 'NEWS_DOCUMENT']),
  before: UtcTimestampSchema,
  limit: z.number().int().min(1).max(500).default(100),
  dryRun: z.boolean().default(true),
});
export type RetentionRequest = z.input<typeof RetentionRequestSchema>;
export const RetentionResultSchema = z.strictObject({
  schemaVersion: z.literal('retention-result.v1'),
  dryRun: z.boolean(),
  ids: z.array(IdSchema),
});
