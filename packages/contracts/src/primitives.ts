import { z } from 'zod';
import { Decimal } from 'decimal.js';

export const IdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
export const HashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const SeedSchema = z.number().int().min(0).max(0xffffffff);

/** UTC instants, 1970–9999, canonicalized to exactly nine fractional digits. */
export const UtcTimestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/)
  .refine((value) => {
    const seconds = value.slice(0, 19);
    const date = new Date(`${seconds}.000Z`);
    return (
      Number.isFinite(date.valueOf()) &&
      Number(value.slice(0, 4)) >= 1970 &&
      date.toISOString().slice(0, 19) === seconds
    );
  }, 'Expected a real UTC calendar instant between 1970 and 9999 (no leap seconds)')
  .transform(
    (value) => `${value.slice(0, 19)}.${(value.split('.')[1]?.slice(0, -1) ?? '').padEnd(9, '0')}Z`,
  )
  .brand<'UtcTimestamp'>();
export type UtcTimestamp = z.infer<typeof UtcTimestampSchema>;

/** Exact internal representation shared by schema invariants and core conversions. */
export function utcNanoseconds(value: UtcTimestamp): bigint {
  const timestamp = UtcTimestampSchema.parse(value);
  return (
    (BigInt(Date.parse(`${timestamp.slice(0, 19)}.000Z`)) / 1000n) * 1_000_000_000n +
    BigInt(timestamp.slice(20, 29))
  );
}

export const TimeUnitSchema = z.enum(['seconds', 'milliseconds', 'microseconds', 'nanoseconds']);
export type TimeUnit = z.infer<typeof TimeUnitSchema>;
export const ProviderTimestampSchema = z.strictObject({
  value: z
    .string()
    .regex(/^(0|[1-9]\d*)$/)
    .max(30),
  unit: TimeUnitSchema,
});

// Strings only: at most 80 digits in total, at most 36 fractional places, no exponent/coercion.
const ComparisonDecimal = Decimal.clone({ precision: 256 });
export const DecimalStringSchema = z
  .string()
  .max(82)
  .regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/)
  .pipe(
    z
      .string()
      .refine(
        (value) =>
          value.replace(/[-.]/g, '').length <= 80 && (value.split('.')[1]?.length ?? 0) <= 36,
        'Decimal exceeds 80 digits or 36 fractional places',
      ),
  )
  .brand<'DecimalString'>();
export type DecimalString = z.infer<typeof DecimalStringSchema>;
export const NonNegativeDecimalSchema = DecimalStringSchema.pipe(
  z.custom<DecimalString>(
    (value) => typeof value === 'string' && new ComparisonDecimal(value).gte(0),
    'Expected a nonnegative decimal',
  ),
);
export const PositiveDecimalSchema = DecimalStringSchema.pipe(
  z.custom<DecimalString>(
    (value) => typeof value === 'string' && new ComparisonDecimal(value).gt(0),
    'Expected a positive decimal',
  ),
);
export const UnitDecimalSchema = NonNegativeDecimalSchema.pipe(
  z.custom<DecimalString>(
    (value) => typeof value === 'string' && new ComparisonDecimal(value).lte(1),
    'Expected a decimal between zero and one',
  ),
);
export function compareDecimal(left: DecimalString, right: DecimalString): number {
  return new ComparisonDecimal(DecimalStringSchema.parse(left)).comparedTo(
    DecimalStringSchema.parse(right),
  );
}
export function decimalProductEquals(
  left: DecimalString,
  right: DecimalString,
  result: DecimalString,
): boolean {
  return new ComparisonDecimal(DecimalStringSchema.parse(left))
    .mul(DecimalStringSchema.parse(right))
    .eq(DecimalStringSchema.parse(result));
}

export const QualityFlagSchema = z.enum([
  'SYNTHETIC',
  'MISSING',
  'STALE',
  'GAP',
  'DUPLICATE',
  'CORRECTED',
  'OUT_OF_ORDER',
  'UNCERTAIN_TIMESTAMP',
  'CONFLICTING_EVIDENCE',
  'SURVIVORSHIP_BIAS',
]);
export const QualityFlagsSchema = z
  .array(QualityFlagSchema)
  .refine((flags) => new Set(flags).size === flags.length, 'Duplicate quality flag');
export type QualityFlag = z.infer<typeof QualityFlagSchema>;

export function uncertainValueSchema<T extends z.ZodType>(value: T) {
  return z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('KNOWN'), value }),
    z.strictObject({
      status: z.literal('UNCERTAIN'),
      value,
      reason: z.string().min(1),
      confidence: z.number().min(0).max(1),
    }),
    z.strictObject({ status: z.literal('MISSING'), reason: z.string().min(1) }),
  ]);
}

export const AvailabilityShape = {
  availableAt: UtcTimestampSchema.nullable(),
  availabilityBasis: z.enum(['OBSERVED', 'ARCHIVED_CAPTURE', 'ESTIMATED', 'UNKNOWN']),
  researchUse: z.enum(['ELIGIBLE', 'DESCRIPTIVE_ONLY']),
};
export const TemporalRecordSchema = z.object(AvailabilityShape).superRefine((record, ctx) => {
  if (
    record.researchUse === 'ELIGIBLE' &&
    (record.availableAt === null ||
      !['OBSERVED', 'ARCHIVED_CAPTURE'].includes(record.availabilityBasis))
  ) {
    ctx.addIssue({
      code: 'custom',
      message: 'Eligible data requires defensible availability',
      path: ['availableAt'],
    });
  }
});
export type TemporalRecord = z.infer<typeof TemporalRecordSchema>;

export const ProvenanceSchema = z.strictObject({
  origin: z.enum(['FIXTURE', 'PUBLIC_READ_ONLY', 'DERIVED']),
  sourceIds: z.array(IdSchema).min(1),
  parentIds: z.array(IdSchema),
  sourceVersion: z.string().min(1),
  capturedAt: UtcTimestampSchema,
  rawTimestamp: ProviderTimestampSchema.nullable(),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const ReproducibilitySchema = z.strictObject({
  datasetHashes: z.array(HashSchema).min(1),
  configHash: HashSchema,
  codeVersion: z.string().min(1),
  modelVersion: z.string().min(1),
  randomSeed: SeedSchema,
  randomAlgorithm: z.literal('mulberry32.v1'),
  clockSemantics: z.literal('utc-nanoseconds.v1'),
  generatedAt: UtcTimestampSchema,
  feeAssumptionsHash: HashSchema,
});
export type Reproducibility = z.infer<typeof ReproducibilitySchema>;

export const PortfolioSchema = z.enum(['BASELINE', 'NEWS_ONLY', 'MARKET_ONLY', 'FUSION']);
export const SymbolSchema = z.string().regex(/^[A-Z0-9][A-Z0-9._-]*\/[A-Z0-9][A-Z0-9._-]*$/);
export const CurrencySchema = z.string().regex(/^[A-Z0-9][A-Z0-9._-]{0,19}$/);

/** Shared causal validation; never infer availability from a publication timestamp. */
export function validateTemporal(
  record: TemporalRecord & { provenance?: { capturedAt: UtcTimestamp } },
  ctx: z.RefinementCtx,
): void {
  const result = TemporalRecordSchema.safeParse(record);
  if (!result.success)
    for (const issue of result.error.issues) {
      ctx.addIssue({ code: 'custom', message: issue.message, path: issue.path });
    }
  if (
    record.availableAt !== null &&
    record.provenance &&
    record.provenance.capturedAt > record.availableAt
  ) {
    ctx.addIssue({
      code: 'custom',
      message: 'Availability precedes provenance capture',
      path: ['availableAt'],
    });
  }
}
