import { z } from 'zod';
import {
  DecimalStringSchema,
  HashSchema,
  IdSchema,
  NonNegativeDecimalSchema,
  PortfolioSchema,
  PositiveDecimalSchema,
  SymbolSchema,
  UtcTimestampSchema,
} from './primitives.js';
import { PaperReportSchema, PaperFillSchema } from './paper-broker.js';
import { EvaluationReportSchema } from './evaluation.js';
import { NewsEventSnapshotSchema } from './news-events.js';
import { SignalCandidateSchema } from './domain.js';
import { DecisionRecordSchema } from './decision-audit.js';
import { EventStudyArtifactSchema } from './event-study.js';

export const OpsDatasetSchema = z.strictObject({
  schemaVersion: z.literal('ops-dataset.v1'),
  paper: PaperReportSchema,
  evaluation: EvaluationReportSchema.nullable(),
  newsSnapshots: z.array(NewsEventSnapshotSchema).max(20),
  studies: z.array(EventStudyArtifactSchema).max(3).default([]),
});
export const OpsQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(1000000).default(0),
  portfolio: PortfolioSchema.optional(),
  symbol: SymbolSchema.optional(),
});
export const OpsSourceSchema = z.strictObject({
  id: IdSchema,
  kind: z.enum(['MARKET', 'NEWS']),
  status: z.enum(['READY_IN_REPLAY', 'STALE', 'REVIEW_REQUIRED', 'DISCONNECTED', 'NOT_ATTACHED']),
  lastObservedAt: UtcTimestampSchema.nullable(),
  flags: z.array(z.string()).max(100),
});
export const OpsOverviewSchema = z.strictObject({
  schemaVersion: z.literal('ops-overview.v1'),
  execution: z.literal('SIMULATED'),
  origin: z.enum(['SYNTHETIC', 'PUBLIC_READ_ONLY']),
  runHash: HashSchema,
  manifestHash: HashSchema,
  status: z.enum(['RUNNING', 'PAUSED', 'KILLED', 'STOPPED']),
  asOf: UtcTimestampSchema,
  quoteCurrency: z.string().min(1),
  initialCapitalPerArm: PositiveDecimalSchema,
  portfolios: z
    .array(
      z.strictObject({
        portfolio: PortfolioSchema,
        cash: NonNegativeDecimalSchema,
        equity: NonNegativeDecimalSchema.nullable(),
        netPnl: DecimalStringSchema.nullable(),
        exposure: NonNegativeDecimalSchema.nullable(),
        fees: NonNegativeDecimalSchema,
      }),
    )
    .length(4),
  counts: z.strictObject({
    candidates: z.number().int().nonnegative(),
    holds: z.number().int().nonnegative(),
    riskVetoes: z.number().int().nonnegative(),
    fills: z.number().int().nonnegative(),
    alerts: z.number().int().nonnegative(),
  }),
  sources: z.array(OpsSourceSchema).max(11),
  report: z
    .strictObject({
      hash: HashSchema,
      recommendation: z.enum(['CONTINUE', 'REVISE', 'STOP']),
      warnings: z.array(z.string()),
    })
    .nullable(),
});
export type OpsOverview = z.infer<typeof OpsOverviewSchema>;
export const OpsSignalSchema = z.strictObject({
  id: IdSchema,
  portfolio: PortfolioSchema,
  symbol: SymbolSchema,
  at: UtcTimestampSchema,
  side: z.enum(['LONG', 'SHORT', 'HOLD']),
  allowed: z.boolean(),
  reasons: z.array(z.string()),
  featureCutoff: UtcTimestampSchema,
  calibration: z.enum(['BOUND_KNOWN', 'UNCALIBRATED']),
  fills: z.number().int().nonnegative(),
});
export type OpsSignal = z.infer<typeof OpsSignalSchema>;
export const OpsTraceSchema = z.strictObject({
  schemaVersion: z.literal('ops-trace.v1'),
  execution: z.literal('SIMULATED'),
  candidate: SignalCandidateSchema,
  decision: DecisionRecordSchema,
  fills: z.array(PaperFillSchema).max(50000),
  sourceContentStatus: z.literal('REFERENCED_SOURCE_ARTIFACTS_MUST_BE_RESOLVED'),
  predictiveFeatureStatus: z.literal('SEE_PRODUCER_SOURCE_SNAPSHOT_NO_INVENTED_VECTOR'),
  realizedNetPnl: DecimalStringSchema.nullable(),
  manifestHash: HashSchema,
});
export type OpsTrace = z.infer<typeof OpsTraceSchema>;
export const OpsCurveSchema = z.strictObject({
  schemaVersion: z.literal('ops-curve.v1'),
  execution: z.literal('SIMULATED'),
  runHash: HashSchema,
  aggregation: z.literal('BUCKET_CLOSE_ANY_MISSING_CREATES_GAP'),
  series: z
    .array(
      z.strictObject({
        portfolio: PortfolioSchema,
        sourcePoints: z.number().int().nonnegative(),
        points: z
          .array(
            z.strictObject({
              at: UtcTimestampSchema,
              value: NonNegativeDecimalSchema.nullable(),
              minimum: NonNegativeDecimalSchema.nullable(),
              maximum: NonNegativeDecimalSchema.nullable(),
              hasMissing: z.boolean(),
            }),
          )
          .max(512),
      }),
    )
    .length(4),
});
export type OpsCurve = z.infer<typeof OpsCurveSchema>;
export function opsPageSchema<T extends z.ZodType>(item: T) {
  return z.strictObject({
    schemaVersion: z.literal('ops-page.v1'),
    runHash: HashSchema,
    total: z.number().int().nonnegative(),
    nextOffset: z.number().int().nonnegative().nullable(),
    items: z.array(item).max(100),
  });
}
export const OpsSecuritySchema = z.strictObject({
  schemaVersion: z.literal('ops-security.v1'),
  mode: z.enum(['LOCAL', 'DEPLOYMENT']),
  readerTokenHash: HashSchema,
  adminTokenHash: HashSchema,
  allowedOrigins: z.array(z.url()).min(1).max(5),
  requestsPerMinute: z.number().int().min(10).max(1000).default(240),
  sessionTtlSeconds: z.number().int().min(60).max(3600).default(900),
});
