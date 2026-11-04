import { z } from 'zod';
import { RiskConfigSchema, RiskRequestSchema, RiskResultSchema } from './risk-engine.js';
import { FusionCalibrationSchema, FusionEvidenceSchema } from './fusion.js';
import {
  DecimalStringSchema,
  HashSchema,
  IdSchema,
  UnitDecimalSchema,
  UtcTimestampSchema,
  PortfolioSchema,
} from './primitives.js';

export const DecisionPolicySchema = z.strictObject({
  schemaVersion: z.literal('decision-policy.v1'),
  risk: RiskConfigSchema,
  allowedRegimes: z
    .array(z.enum(['TREND', 'RANGE', 'HIGH_VOLATILITY']))
    .min(1)
    .max(3),
  uncalibratedDiscount: UnitDecimalSchema,
});
export const DecisionRequestSchema = z.strictObject({
  schemaVersion: z.literal('decision-request.v1'),
  risk: RiskRequestSchema,
  runManifestHash: HashSchema,
  sourceSnapshotHash: HashSchema,
  evidence: z.array(FusionEvidenceSchema).min(1).max(512),
  regime: z.strictObject({
    id: IdSchema,
    kind: z.enum(['TREND', 'RANGE', 'HIGH_VOLATILITY', 'UNKNOWN']),
    availableAt: UtcTimestampSchema,
  }),
  calibration: FusionCalibrationSchema.nullable(),
  previousHash: HashSchema,
});
export const DecisionRecordSchema = z.strictObject({
  schemaVersion: z.literal('decision-record.v1'),
  id: IdSchema,
  request: DecisionRequestSchema,
  policy: DecisionPolicySchema,
  risk: RiskResultSchema,
  featureCutoff: UtcTimestampSchema,
  calibration: z.enum(['BOUND_KNOWN', 'UNCALIBRATED']),
  finalReasons: z.array(z.string().min(1)).min(1),
  configHash: HashSchema,
  previousHash: HashSchema,
  hash: HashSchema,
});
export type DecisionRecord = z.infer<typeof DecisionRecordSchema>;
export const CounterfactualOutcomeSchema = z.strictObject({
  candidateId: IdSchema,
  exitAt: UtcTimestampSchema,
  availableAt: UtcTimestampSchema,
  netUnitReturn: DecimalStringSchema.nullable(),
  evidenceHash: HashSchema,
});
export const ArmDayPerformanceSchema = z.strictObject({
  portfolio: PortfolioSchema,
  day: z.iso.date(),
  availableAt: UtcTimestampSchema,
  netPnl: DecimalStringSchema,
  netReturn: DecimalStringSchema,
  evidenceHash: HashSchema,
});
