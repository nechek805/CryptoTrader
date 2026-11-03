import { z } from 'zod';
import { TechnicalFeatureArtifactSchema } from './technical-features.js';
import { CrossFeatureArtifactSchema, CrossFeatureDatasetSchema } from './cross-features.js';
import { MarketDatasetSchema } from './market-data.js';
import {
  AvailabilityShape,
  DecimalStringSchema,
  HashSchema,
  IdSchema,
  ProvenanceSchema,
  UtcTimestampSchema,
  validateTemporal,
} from './primitives.js';

export const PanelGroupRevisionSchema = z
  .strictObject({
    schemaVersion: z.literal('panel-group-revision.v1'),
    id: IdSchema,
    instrumentKey: IdSchema,
    revision: z.number().int().positive(),
    groupId: IdSchema,
    effectiveFrom: UtcTimestampSchema,
    observedAt: UtcTimestampSchema,
    ...AvailabilityShape,
    provenance: ProvenanceSchema,
  })
  .superRefine((v, ctx) => {
    validateTemporal(v, ctx);
    if (v.availableAt !== null && v.observedAt > v.availableAt)
      ctx.addIssue({ code: 'custom', message: 'Group availability precedes receipt' });
  });
export const PanelFeatureCellSchema = z.strictObject({
  name: IdSchema,
  value: DecimalStringSchema.nullable(),
  status: z.string().min(1).max(100),
  definitionHash: HashSchema,
  sourceKind: z.enum(['TECHNICAL', 'CROSS', 'PROPOSED']),
  dependency: z.enum(['MARKET', 'LABEL']),
  sourceHashes: z.array(HashSchema),
  inputBarIds: z.array(IdSchema).max(10000),
  maxInputAvailableAt: UtcTimestampSchema.nullable(),
  maxInputEventAt: UtcTimestampSchema.nullable(),
});
export type PanelFeatureCell = z.infer<typeof PanelFeatureCellSchema>;
export const PanelFeatureAuditInputSchema = z.strictObject({
  instrumentKey: IdSchema,
  featureAsOf: UtcTimestampSchema,
  features: z.array(PanelFeatureCellSchema).max(50),
});
export const DatasetPanelInputSchema = z
  .strictObject({
    schemaVersion: z.literal('dataset-panel-input.v1'),
    market: MarketDatasetSchema,
    bindings: CrossFeatureDatasetSchema.shape.bindings,
    groups: z.array(PanelGroupRevisionSchema).max(1000),
    technicalArtifacts: z.array(TechnicalFeatureArtifactSchema).max(20),
    crossArtifacts: z.array(CrossFeatureArtifactSchema).max(10),
    proposedFeatures: z.array(PanelFeatureAuditInputSchema).max(100).default([]),
  })
  .refine(
    (v) => v.technicalArtifacts.length + v.crossArtifacts.length > 0,
    'At least one verified feature artifact is required',
  );
export type DatasetPanelInput = z.infer<typeof DatasetPanelInputSchema>;
const period = z
  .strictObject({ from: UtcTimestampSchema, to: UtcTimestampSchema })
  .refine((v) => v.from < v.to, 'Period must have positive duration');
export const DatasetSplitSchema = z.enum(['TRAIN', 'VALIDATION', 'TEST']);
export type DatasetSplit = z.infer<typeof DatasetSplitSchema>;
export const DatasetPanelRequestSchema = z
  .strictObject({
    schemaVersion: z.literal('dataset-panel-request.v1'),
    instrumentKeys: z.array(IdSchema).min(1).max(20),
    columns: z.array(IdSchema).min(1).max(40),
    intervalSeconds: z.number().int().min(1).max(86400),
    splits: z.strictObject({ train: period, validation: period, test: period }),
    embargoSeconds: z.number().int().min(0).max(604800),
    horizonsBars: z
      .array(z.number().int().min(1).max(100))
      .min(1)
      .max(10)
      .refine((v) => new Set(v).size === v.length, 'Duplicate label horizon')
      .transform((v) => [...v].sort((a, b) => a - b)),
    labelPublicationLagSeconds: z.number().int().min(0).max(3600),
    labelsAsOf: UtcTimestampSchema,
    generatedAt: UtcTimestampSchema,
    missingPolicy: z.enum(['KEEP_NULLS', 'DROP_ROW']),
    membership: z.enum(['POINT_IN_TIME_LISTED', 'POINT_IN_TIME_LIQUID']),
    cohortDisclosure: z.string().trim().min(1).max(2000),
  })
  .superRefine((v, ctx) => {
    if (v.splits.train.to > v.splits.validation.from || v.splits.validation.to > v.splits.test.from)
      ctx.addIssue({
        code: 'custom',
        message: 'Chronological train/validation/test periods must not overlap',
      });
    if (v.generatedAt < v.labelsAsOf)
      ctx.addIssue({ code: 'custom', message: 'Generation precedes label freeze' });
    if (
      new Set(v.columns).size !== v.columns.length ||
      new Set(v.instrumentKeys).size !== v.instrumentKeys.length
    )
      ctx.addIssue({ code: 'custom', message: 'Duplicate columns or instrument keys' });
    if (v.columns.some((k) => !k.startsWith('technical.') && !k.startsWith('cross.')))
      ctx.addIssue({
        code: 'custom',
        message: 'Only registered market-feature columns are allowed',
      });
  });
export type DatasetPanelRequest = z.infer<typeof DatasetPanelRequestSchema>;
export const PanelLabelSchema = z
  .strictObject({
    horizonBars: z.number().int().positive(),
    status: z.enum([
      'READY',
      'MISSING_START',
      'MISSING_FUTURE_BAR',
      'FUTURE_OBSERVATION_WINDOW',
      'LISTING_OR_MAPPING',
      'NON_FUTURE_TARGET',
    ]),
    value: DecimalStringSchema.nullable(),
    startCloseAt: UtcTimestampSchema.nullable(),
    endAt: UtcTimestampSchema.nullable(),
    decisionAt: UtcTimestampSchema.nullable(),
    availableAt: UtcTimestampSchema.nullable(),
    inputBarIds: z.array(IdSchema),
    inputMetadataIds: z.array(IdSchema),
  })
  .refine(
    (v) => (v.status === 'READY') === (v.value !== null),
    'Only complete labels have numeric targets',
  );
export type PanelLabel = z.infer<typeof PanelLabelSchema>;
export const DatasetPanelRowSchema = z
  .strictObject({
    schemaVersion: z.literal('dataset-panel-row.v1'),
    id: IdSchema,
    instrumentKey: IdSchema,
    sourceId: IdSchema,
    symbol: z.string(),
    groupId: IdSchema.nullable(),
    groupRevisionId: IdSchema.nullable(),
    featureAsOf: UtcTimestampSchema,
    split: DatasetSplitSchema.nullable(),
    status: z.enum(['INCLUDED', 'PURGED', 'EMBARGOED', 'QUARANTINED', 'OUTSIDE_SPLITS']),
    reasons: z.array(z.string().min(1).max(100)),
    features: z.array(PanelFeatureCellSchema).max(40),
    labels: z.array(PanelLabelSchema).max(10),
    sourceHashes: z.array(HashSchema),
    inputMetadataIds: z.array(IdSchema),
    maxInputAvailableAt: UtcTimestampSchema.nullable(),
    maxInputEventAt: UtcTimestampSchema.nullable(),
  })
  .superRefine((v, ctx) => {
    if (v.status !== 'INCLUDED') return;
    if (
      v.maxInputAvailableAt === null ||
      v.maxInputAvailableAt > v.featureAsOf ||
      (v.maxInputEventAt !== null && v.maxInputEventAt > v.featureAsOf) ||
      v.features.some(
        (f) =>
          f.dependency !== 'MARKET' ||
          f.sourceKind === 'PROPOSED' ||
          (f.maxInputAvailableAt !== null && f.maxInputAvailableAt > v.featureAsOf) ||
          (f.maxInputEventAt !== null && f.maxInputEventAt > v.featureAsOf),
      )
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Included feature row contains leakage or unsupported predictors',
      });
    if (v.split === null || v.groupId === null || v.labels.some((l) => l.status !== 'READY'))
      ctx.addIssue({
        code: 'custom',
        message: 'Included row lacks a split, known group or complete labels',
      });
  });
export type DatasetPanelRow = z.infer<typeof DatasetPanelRowSchema>;
export const PanelLeakageIssueSchema = z.strictObject({
  instrumentKey: IdSchema,
  featureAsOf: UtcTimestampSchema,
  feature: IdSchema,
  reason: z.enum([
    'FUTURE_INPUT',
    'LABEL_DEPENDENCY',
    'UNREGISTERED_SOURCE',
    'UNKNOWN_EVIDENCE',
    'WATERMARK_UNDERSTATED',
  ]),
});
export type PanelLeakageIssue = z.infer<typeof PanelLeakageIssueSchema>;
export const DatasetPanelAuditSchema = z.strictObject({
  candidateCount: z.number().int().nonnegative(),
  includedCount: z.number().int().nonnegative(),
  purgedCount: z.number().int().nonnegative(),
  embargoedCount: z.number().int().nonnegative(),
  quarantinedCount: z.number().int().nonnegative(),
  outsideSplitCount: z.number().int().nonnegative(),
  splits: z.array(
    z.strictObject({
      split: DatasetSplitSchema,
      candidates: z.number().int().nonnegative(),
      included: z.number().int().nonnegative(),
    }),
  ),
  missingness: z.array(
    z.strictObject({
      column: IdSchema,
      rows: z.number().int().nonnegative(),
      missing: z.number().int().nonnegative(),
      statuses: z.array(
        z.strictObject({ status: z.string(), count: z.number().int().nonnegative() }),
      ),
    }),
  ),
  duplicates: z.array(
    z.strictObject({
      kind: z.enum(['EXACT_SOURCE_DUPLICATE', 'CONFLICTING_FEATURE']),
      id: z.string(),
      sourceHashes: z.array(HashSchema),
    }),
  ),
  leakage: z.array(PanelLeakageIssueSchema),
  purgeScope: z.literal('GLOBAL_ACROSS_SYMBOLS_AND_GROUPS_BOUNDARY_TOUCH_EXCLUDED'),
  proposalPolicy: z.literal('AUDIT_ONLY_NEVER_TRAINING_COLUMNS'),
  survivorship: z.strictObject({
    policy: z.enum(['POINT_IN_TIME_LISTED', 'POINT_IN_TIME_LIQUID']),
    scope: z.literal('EXPLICIT_COHORT_NOT_COMPLETE_HISTORICAL_MARKET'),
    disclosure: z.string(),
    coverage: z.array(
      z.strictObject({
        instrumentKey: IdSchema,
        candidateRows: z.number().int().nonnegative(),
        includedRows: z.number().int().nonnegative(),
        metadataRejected: z.number().int().nonnegative(),
        missingLabels: z.number().int().nonnegative(),
      }),
    ),
  }),
});
export const DatasetPanelArtifactSchema = z.strictObject({
  schemaVersion: z.literal('dataset-panel-artifact.v1'),
  algorithmVersion: z.literal('dataset-panel.v1'),
  execution: z.literal('DISABLED'),
  clockSemantics: z.literal('utc-nanoseconds.v1'),
  randomSeed: z.literal(0),
  codeVersion: z.string().min(1).max(200),
  input: DatasetPanelInputSchema,
  inputHash: HashSchema,
  request: DatasetPanelRequestSchema,
  configHash: HashSchema,
  featureCatalog: z.array(
    z.strictObject({
      name: IdSchema,
      definitionHash: HashSchema,
      description: z.string(),
      realTimePolicy: z.literal('INPUT_TIME_GATED_COMPUTATION_LAG_UNMODELED'),
    }),
  ),
  rows: z.array(DatasetPanelRowSchema).max(10000),
  audit: DatasetPanelAuditSchema,
});
export type DatasetPanelArtifact = z.infer<typeof DatasetPanelArtifactSchema>;
export const DatasetPanelManifestSchema = z.strictObject({
  schemaVersion: z.literal('dataset-panel-manifest.v1'),
  id: IdSchema,
  writer: z.literal('duckdb-1.4.4/panel-parquet.v1'),
  artifactHash: HashSchema,
  inputHash: HashSchema,
  configHash: HashSchema,
  rowsHash: HashSchema,
  parquetHash: HashSchema,
  artifactFileHash: HashSchema,
  codeVersion: z.string().min(1).max(200),
  generatedAt: UtcTimestampSchema,
  rowCount: z.number().int().nonnegative(),
  featureColumns: z.array(
    z.strictObject({ name: IdSchema, parquetColumn: z.string().regex(/^feature_[0-9]+$/) }),
  ),
  labelColumns: z.array(
    z.strictObject({
      horizonBars: z.number().int().positive(),
      parquetColumn: z.string().regex(/^label_[0-9]+$/),
    }),
  ),
});
