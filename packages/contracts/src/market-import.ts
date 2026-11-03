import { z } from 'zod';
import { MarketBarSchema } from './domain.js';
import { HashSchema, IdSchema, SymbolSchema, UtcTimestampSchema } from './primitives.js';

export const FixedIntervalSchema = z.enum([
  '1s',
  '1m',
  '3m',
  '5m',
  '15m',
  '30m',
  '1h',
  '2h',
  '4h',
  '6h',
  '8h',
  '12h',
  '1d',
]);
export type FixedInterval = z.infer<typeof FixedIntervalSchema>;
export const MarketImportRequestSchema = z
  .strictObject({
    schemaVersion: z.literal('market-import-request.v1'),
    provider: z.enum(['fixture', 'binance-archive']),
    symbols: z
      .array(z.string().regex(/^[A-Z0-9]{2,30}$/))
      .min(1)
      .max(10)
      .refine((values) => new Set(values).size === values.length, 'Duplicate symbol')
      .transform((values) => [...values].sort()),
    interval: FixedIntervalSchema.default('1m'),
    from: UtcTimestampSchema,
    to: UtcTimestampSchema,
  })
  .refine((value) => value.from < value.to, 'Import window must have positive duration');
export type MarketImportRequest = z.output<typeof MarketImportRequestSchema>;
export const SymbolMappingSchema = z.strictObject({
  providerSymbol: z.string().regex(/^[A-Z0-9]{2,30}$/),
  instrumentId: SymbolSchema,
});
export const MarketSourceSchema = z
  .strictObject({
    schemaVersion: z.literal('market-source.v1'),
    provider: z.enum(['fixture', 'binance-archive']),
    providerVersion: z.string().min(1),
    format: z.enum(['fixture-ohlcv.v1', 'binance-spot-klines-ms.v1', 'binance-spot-klines-us.v1']),
    symbol: z.string().regex(/^[A-Z0-9]{2,30}$/),
    instrumentId: SymbolSchema,
    marketType: z.literal('SPOT'),
    interval: FixedIntervalSchema,
    period: z.string().regex(/^\d{4}-\d{2}(?:-\d{2})?$/),
    timestampUnit: z.enum(['milliseconds', 'microseconds']),
    capturedAt: UtcTimestampSchema,
    uri: z.string().min(1).max(2000),
    fileHash: HashSchema,
    member: z.string().min(1).max(200),
    memberHash: HashSchema,
    checksumStatus: z.enum(['VERIFIED', 'NOT_SUPPLIED']),
    origin: z.enum(['FIXTURE', 'PUBLIC_READ_ONLY']),
    license: z.enum(['SYNTHETIC', 'CC-BY-NC-SA-4.0']),
    termsUrl: z.string().min(1),
  })
  .superRefine((source, ctx) => {
    const fixture = source.provider === 'fixture',
      modern = source.period >= '2025-01';
    if (
      fixture
        ? source.origin !== 'FIXTURE' ||
          source.license !== 'SYNTHETIC' ||
          source.format !== 'fixture-ohlcv.v1'
        : source.origin !== 'PUBLIC_READ_ONLY' ||
          source.license !== 'CC-BY-NC-SA-4.0' ||
          source.format !== (modern ? 'binance-spot-klines-us.v1' : 'binance-spot-klines-ms.v1') ||
          source.timestampUnit !== (modern ? 'microseconds' : 'milliseconds')
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Provider format, origin, license and timestamp profile must agree',
      });
    }
  });
export type MarketSource = z.infer<typeof MarketSourceSchema>;
export const RawMarketRowSchema = z.strictObject({
  line: z.number().int().positive(),
  raw: z.string().max(8192),
  fields: z.array(z.string().max(8192)).nullable(),
});
export type RawMarketRow = z.infer<typeof RawMarketRowSchema>;
export const MarketSourceBundleSchema = z.strictObject({
  source: MarketSourceSchema,
  rows: z.array(RawMarketRowSchema).max(200000),
});
export type MarketSourceBundle = z.infer<typeof MarketSourceBundleSchema>;
export const QuarantineReasonSchema = z.enum([
  'CSV_SYNTAX',
  'COLUMN_COUNT',
  'IDENTITY_MISMATCH',
  'TIMESTAMP_UNIT',
  'TIMESTAMP_OR_PERIOD',
  'INTERVAL_ALIGNMENT',
  'INVALID_VALUE',
  'INVALID_OHLCV',
  'UNAVAILABLE_AT_CAPTURE',
  'CONFLICTING_DUPLICATE',
]);
export const QuarantinedMarketRowSchema = z.strictObject({
  schemaVersion: z.literal('market-quarantine.v1'),
  sourceHash: HashSchema,
  sourceUri: z.string(),
  line: z.number().int().positive(),
  symbol: z.string(),
  raw: z.string(),
  rawHash: HashSchema,
  reason: QuarantineReasonSchema,
});
export type QuarantinedMarketRow = z.infer<typeof QuarantinedMarketRowSchema>;
export const ImportedMarketBarSchema = z.strictObject({
  schemaVersion: z.literal('imported-market-bar.v1'),
  bar: MarketBarSchema,
  source: MarketSourceSchema,
  row: RawMarketRowSchema,
  captureId: IdSchema,
});
export type ImportedMarketBar = z.infer<typeof ImportedMarketBarSchema>;
export const CoverageReportSchema = z.strictObject({
  schemaVersion: z.literal('market-coverage.v1'),
  symbol: z.string(),
  instrumentId: SymbolSchema,
  expectedBars: z.number().int().nonnegative(),
  acceptedBars: z.number().int().nonnegative(),
  missingBars: z.number().int().nonnegative(),
  quarantinedRows: z.number().int().nonnegative(),
  duplicateRows: z.number().int().nonnegative(),
  conflictingRows: z.number().int().nonnegative(),
  outOfOrderRows: z.number().int().nonnegative(),
  outsideWindowRows: z.number().int().nonnegative(),
  eligibleBars: z.number().int().nonnegative(),
  descriptiveOnlyBars: z.number().int().nonnegative(),
  missingRanges: z.array(
    z.strictObject({
      from: UtcTimestampSchema,
      to: UtcTimestampSchema,
      bars: z.number().int().positive(),
    }),
  ),
});
export type CoverageReport = z.infer<typeof CoverageReportSchema>;
export const NormalizedMarketImportSchema = z.strictObject({
  schemaVersion: z.literal('normalized-market-import.v1'),
  normalizationVersion: z.literal('ohlcv-normalizer.v1'),
  request: MarketImportRequestSchema,
  sources: z.array(MarketSourceSchema),
  bars: z.array(ImportedMarketBarSchema),
  quarantine: z.array(QuarantinedMarketRowSchema),
  coverage: z.array(CoverageReportSchema),
  rawBundles: z.array(MarketSourceBundleSchema),
});
export type NormalizedMarketImport = z.infer<typeof NormalizedMarketImportSchema>;
export const MarketSnapshotManifestSchema = z.strictObject({
  schemaVersion: z.literal('market-snapshot.v1'),
  id: IdSchema,
  normalizationVersion: z.literal('ohlcv-normalizer.v1'),
  codeVersion: z.string().min(1),
  writer: z.literal('duckdb-1.4.4/parquet-v1'),
  request: MarketImportRequestSchema,
  sources: z.array(MarketSourceSchema),
  configHash: HashSchema,
  datasetHash: HashSchema,
  parquetHash: HashSchema,
  quarantineHash: HashSchema,
  rawRowsHash: HashSchema,
  coverage: z.array(CoverageReportSchema),
  rowCount: z.number().int().nonnegative(),
});
export type MarketSnapshotManifest = z.infer<typeof MarketSnapshotManifestSchema>;
export const MarketSnapshotReferenceSchema = z.strictObject({
  schemaVersion: z.literal('market-snapshot-reference.v1'),
  snapshotId: IdSchema,
  uri: z.string().min(1),
  metadataHash: HashSchema,
  datasetHash: HashSchema,
  parquetHash: HashSchema,
  codeVersion: z.string().min(1),
});
