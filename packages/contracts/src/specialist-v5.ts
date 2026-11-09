import { z } from 'zod';
import {
  HashSchema,
  PositiveDecimalSchema,
  DecimalStringSchema as DecimalSchema,
} from './primitives.js';
import { BtcReplayWindowSchema } from './btc-test.js';
import { MarketReportSchema, MarketFeeModeSchema } from './market-tests.js';
import {
  SpecialistAssetSchema,
  SpecialistReportSchema,
  SpecialistCellSchema,
  SpecialistRowSchema,
  SpecialistMatrixSchema,
  SpecialistJobSchema,
  SpecialistViewSchema,
} from './specialist-tests.js';
export const SpecialistV5KeySchema = z.enum(['V1', 'V2', 'V3', 'V4', 'V5']);
export type SpecialistV5Key = z.infer<typeof SpecialistV5KeySchema>;
export const SpecialistV5FeesSchema = z.strictObject({
  V1: z.boolean(),
  V2: z.boolean(),
  V3: z.boolean(),
  V4: z.boolean(),
  V5: z.boolean(),
});
export const DEFAULT_SPECIALIST_V5_FEES = { V1: true, V2: true, V3: true, V4: true, V5: true };
export const SpecialistV5CandidateSchema = z
  .strictObject({
    asset: SpecialistAssetSchema,
    base: z.enum(['V2', 'V3']),
    stopAtr: z.enum(['2', '2.5']),
    targetAtr: z.enum(['3.5', '5', '6']),
    minSignalRangeAtr: z.literal('0.8').optional(),
    trendSlopeHours: z.literal(24),
    trailDistanceAtr: z.enum(['1.5', '2', '2.5', '3', '3.5']).optional(),
    lowVolatilityThreshold: z.enum(['0.004', '0.006', '0.008']).optional(),
    lowVolatilityTargetAtr: z.enum(['3', '4']).optional(),
    adaptiveLowerAtr: z.enum(['1', '1.25', '1.5']).optional(),
    adaptiveTargetAtr: z.enum(['4.5', '5', '5.5', '6']).optional(),
  })
  .refine(
    (c) =>
      c.asset === 'SOL'
        ? c.base === 'V2' &&
          c.stopAtr === '2.5' &&
          ['5', '6'].includes(c.targetAtr) &&
          !c.minSignalRangeAtr &&
          !c.adaptiveLowerAtr &&
          !c.adaptiveTargetAtr &&
          !!c.lowVolatilityThreshold === !!c.lowVolatilityTargetAtr &&
          (!c.lowVolatilityThreshold || !c.trailDistanceAtr)
        : c.base === 'V3' &&
          c.stopAtr === '2' &&
          c.targetAtr === '3.5' &&
          c.minSignalRangeAtr === '0.8' &&
          !c.trailDistanceAtr &&
          !c.lowVolatilityThreshold &&
          !c.lowVolatilityTargetAtr &&
          !!c.adaptiveLowerAtr === !!c.adaptiveTargetAtr,
    'V5 profile must obey its coin-specific protocol',
  );
export type SpecialistV5Candidate = z.infer<typeof SpecialistV5CandidateSchema>;
export const SpecialistV5ReportSchema = MarketReportSchema.omit({
  version: true,
  asset: true,
  plan: true,
  decisions: true,
})
  .extend({
    version: z.literal('specialist-v5-replay.v1'),
    asset: SpecialistAssetSchema,
    plan: z.strictObject({
      strategy: z.literal('V5'),
      candidate: SpecialistV5CandidateSchema,
      feeMode: MarketFeeModeSchema,
      reference: MarketReportSchema.shape.plan.shape.reference,
      filters: MarketReportSchema.shape.plan.shape.filters,
    }),
    window: BtcReplayWindowSchema,
    decisions: z
      .array(
        MarketReportSchema.shape.decisions.element.extend({
          entryGate: z
            .enum([
              'WARMUP',
              'TREND_BLOCK',
              'COST_BLOCK',
              'SHOCK_BLOCK',
              'WEAK_CLOSE_BLOCK',
              'QUIET_BLOCK',
              'PASS',
            ])
            .optional(),
          targetAtrUsed: PositiveDecimalSchema,
        }),
      )
      .min(100)
      .max(6000),
  })
  .refine(
    (r) => r.asset === r.plan.candidate.asset && r.symbol === r.asset + 'USDT',
    'V5 instrument mismatch',
  );
export type SpecialistV5Report = z.infer<typeof SpecialistV5ReportSchema>;
const Cell = SpecialistCellSchema.extend({ strategy: SpecialistV5KeySchema });
export const SpecialistV5TradeChangeSchema = z.strictObject({
  entryIndex: z.number().int().nonnegative(),
  entryAt: z.number().int(),
  v4Exit: z.number().int().nullable(),
  v5Exit: z.number().int().nullable(),
  v4Net: DecimalSchema.nullable(),
  v5Net: DecimalSchema.nullable(),
  delta: DecimalSchema,
  v4Reason: z.string().nullable(),
  v5Reason: z.string().nullable(),
});
export const SpecialistV5RowSchema = z
  .strictObject({
    ...SpecialistRowSchema.shape,
    baseline: z.literal('V4'),
    selected: SpecialistV5CandidateSchema,
    tradeChanges: z.array(SpecialistV5TradeChangeSchema).max(6000),
    search: z
      .array(
        z.strictObject({
          candidate: SpecialistV5CandidateSchema,
          development: SpecialistRowSchema.shape.search.element.shape.development,
          eligible: z.boolean(),
          selected: z.boolean(),
        }),
      )
      .min(13)
      .max(18),
    variants: z.strictObject({ STANDARD: z.array(Cell).length(5), ZERO: z.array(Cell).length(5) }),
  })
  .refine(
    (r) =>
      r.selected.asset === r.asset &&
      r.search.length === (r.asset === 'SOL' ? 18 : 13) &&
      r.search.filter((t) => t.selected).length === 1 &&
      JSON.stringify(r.search.find((t) => t.selected)?.candidate) === JSON.stringify(r.selected) &&
      new Set(r.search.map((t) => JSON.stringify(t.candidate))).size === r.search.length &&
      r.search.every((t) => t.candidate.asset === r.asset) &&
      ['STANDARD', 'ZERO'].every(
        (m) => new Set(r.variants[m as 'STANDARD' | 'ZERO'].map((c) => c.strategy)).size === 5,
      ),
    'Complete coin-specific trials and V1-V5 variants required',
  );
export const SpecialistV5MatrixSchema = z
  .strictObject({
    ...SpecialistMatrixSchema.shape,
    version: z.literal('sol-xrp-v5.v1'),
    rows: z.array(SpecialistV5RowSchema).length(2),
    candidatesPerCoin: z
      .literal(12)
      .describe('Legacy initial V4 grid size; V5 uses candidateCounts'),
    candidateCounts: z.strictObject({ SOL: z.literal(18), XRP: z.literal(13) }),
    sourceV4MatrixId: HashSchema,
  })
  .refine(
    (m) =>
      new Set(m.rows.map((r) => r.asset)).size === 2 &&
      m.splitIndex === Math.floor((((m.to - m.from) / 3600000) * 2) / 3) &&
      m.rows.every(
        (r) =>
          r.development.toIndex === m.splitIndex &&
          r.check.fromIndex === m.splitIndex &&
          r.check.toIndex === (m.to - m.from) / 3600000,
      ),
    'Both assets must use the same frozen chronological split',
  );
export type SpecialistV5Matrix = z.infer<typeof SpecialistV5MatrixSchema>;
export const SpecialistV5StateSchema = z.strictObject({
  matrixId: HashSchema.nullable(),
  job: SpecialistJobSchema.nullable(),
  fees: SpecialistV5FeesSchema,
});
export const SpecialistV5ViewSchema = SpecialistViewSchema.extend({
  report: z.union([MarketReportSchema, SpecialistReportSchema, SpecialistV5ReportSchema]),
});
