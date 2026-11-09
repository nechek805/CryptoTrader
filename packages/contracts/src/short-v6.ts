import { z } from 'zod';
import {
  HashSchema,
  DecimalStringSchema as Decimal,
  PositiveDecimalSchema as Positive,
} from './primitives.js';
import { BtcReplayWindowSchema } from './btc-test.js';
import { SpecialistAssetSchema } from './specialist-tests.js';
import { SpecialistV5CandidateSchema } from './specialist-v5.js';
import {
  DirectionProfileSchema,
  DirectionReportSchema,
  DirectionDecisionSchema,
  DirectionMatrixSchema,
  DirectionCellSchema,
  DirectionViewSchema,
  DirectionSummarySchema,
} from './directional-tests.js';
export const ShortV6KeySchema = z.enum(['V1', 'V2', 'V3', 'V4', 'V5', 'V6']);
export type ShortV6Key = z.infer<typeof ShortV6KeySchema>;
export const ShortV6FeesSchema = z.strictObject({
  V1: z.boolean(),
  V2: z.boolean(),
  V3: z.boolean(),
  V4: z.boolean(),
  V5: z.boolean(),
  V6: z.boolean(),
});
export const DEFAULT_SHORT_V6_FEES = { V1: true, V2: true, V3: true, V4: true, V5: true, V6: true };
const Baseline = z.strictObject({ asset: SpecialistAssetSchema, kind: z.literal('BASELINE') });
const Tuned = z
  .strictObject({
    asset: SpecialistAssetSchema,
    kind: z.literal('TUNED'),
    minSlopeAtr: z.enum(['0', '0.5', '0.75', '1']),
    minDistanceAtr: z.enum(['0', '0.75']),
    maxDistanceAtr: z.enum(['3', '4', '6']).nullable(),
    targetAtr: z.enum(['2.5', '3', '3.5', '4', '4.5']),
    trailDistanceAtr: z.literal('1.5').optional(),
  })
  .refine(
    (c) =>
      c.asset === 'SOL'
        ? c.minDistanceAtr === '0' &&
          c.maxDistanceAtr === null &&
          ['2.5', '3', '4'].includes(c.targetAtr)
        : c.minSlopeAtr === '0' &&
          c.maxDistanceAtr !== null &&
          ['3', '3.5', '4.5'].includes(c.targetAtr) &&
          !c.trailDistanceAtr,
    'Coin-specific V6 protocol required',
  );
export const ShortV6CandidateSchema = z.union([Baseline, Tuned]);
export type ShortV6Candidate = z.infer<typeof ShortV6CandidateSchema>;
export const ShortV6ProfileSchema = z.union([
  DirectionProfileSchema,
  z
    .strictObject({
      asset: SpecialistAssetSchema,
      strategy: z.literal('V6'),
      candidate: SpecialistV5CandidateSchema,
      shortRules: ShortV6CandidateSchema,
    })
    .refine(
      (p) => p.asset === p.candidate.asset && p.asset === p.shortRules.asset,
      'V6 must retain its own coin parent',
    ),
]);
export type ShortV6Profile = z.infer<typeof ShortV6ProfileSchema>;
export const ShortV6ReportSchema = z
  .strictObject({
    ...DirectionReportSchema.shape,
    version: z.literal('short-v6-replay.v1'),
    window: BtcReplayWindowSchema,
    plan: DirectionReportSchema.shape.plan.extend({ profile: ShortV6ProfileSchema }),
    decisions: z
      .array(
        DirectionDecisionSchema.extend({
          shortSlopeAtr: Decimal.nullable(),
          shortDistanceAtr: Decimal.nullable(),
          shortTargetAtr: Positive,
        }),
      )
      .min(100)
      .max(6000),
  })
  .refine(
    (r) => r.asset === r.plan.profile.asset && r.symbol === r.asset + 'USDT',
    'V6 instrument mismatch',
  );
export type ShortV6Report = z.infer<typeof ShortV6ReportSchema>;
export const ShortV6EvidenceSchema = z.strictObject({
  reportId: HashSchema,
  summary: DirectionSummarySchema,
});
export const ShortV6SliceSchema = z.strictObject({
  fromIndex: z.number().int(),
  toIndex: z.number().int(),
  v5Short: ShortV6EvidenceSchema,
  v6Short: ShortV6EvidenceSchema,
  v5Combined: ShortV6EvidenceSchema,
  v6Combined: ShortV6EvidenceSchema,
});
export const ShortV6TradeSchema = z.strictObject({
  entryIndex: z.number().int(),
  exitIndex: z.number().int(),
  entryAt: z.number().int(),
  net: Decimal,
  fees: Decimal,
  financing: Decimal,
  slippage: Decimal,
  reason: z.string(),
  slopeAtr: Decimal,
  distanceAtr: Decimal,
  mfeBeforeExitAtr: Decimal,
});
export const ShortV6ChangeSchema = z.strictObject({
  direction: z.enum(['LONG', 'SHORT']),
  entryIndex: z.number().int(),
  entryAt: z.number().int(),
  v5Net: Decimal.nullable(),
  v6Net: Decimal.nullable(),
  delta: Decimal,
  v5Exit: z.number().int().nullable(),
  v6Exit: z.number().int().nullable(),
});
export const ShortV6ResearchRowSchema = z
  .strictObject({
    asset: SpecialistAssetSchema,
    parent: DirectionProfileSchema,
    selected: ShortV6CandidateSchema,
    diagnosis: z.array(z.string()),
    v5ShortTrades: z.array(ShortV6TradeSchema),
    tradeChanges: z.array(ShortV6ChangeSchema),
    search: z
      .array(
        z.strictObject({
          candidate: ShortV6CandidateSchema,
          development: ShortV6EvidenceSchema,
          eligible: z.boolean(),
          selected: z.boolean(),
        }),
      )
      .min(19)
      .max(25),
    development: ShortV6SliceSchema,
    check: ShortV6SliceSchema,
  })
  .refine(
    (r) =>
      r.selected.asset === r.asset &&
      r.parent.asset === r.asset &&
      r.parent.strategy === 'V5' &&
      r.search.every((t) => t.candidate.asset === r.asset) &&
      new Set(r.search.map((t) => JSON.stringify(t.candidate))).size === r.search.length &&
      r.search.length === (r.asset === 'SOL' ? 25 : 19) &&
      r.search.filter((t) => t.selected).length === 1 &&
      JSON.stringify(r.search.find((t) => t.selected)?.candidate) === JSON.stringify(r.selected),
    'Complete V6 search and one winner required',
  );
const Cell = DirectionCellSchema.extend({ strategy: ShortV6KeySchema });
export const ShortV6MatrixSchema = z
  .strictObject({
    ...DirectionMatrixSchema.shape,
    version: z.literal('short-v6-matrix.v1'),
    sourceDirectionMatrixId: HashSchema,
    splitIndex: z.number().int(),
    selection: z.literal('EARLIER_SHORT_NET_WITH_FEES_MIN_TWO_TRADES_DRAWDOWN_2_PERCENT'),
    historyUse: z.literal('PREVIOUSLY_SEEN_HISTORY_EXPLORATORY_CHECK'),
    profiles: z.array(ShortV6ProfileSchema).length(36),
    cells: z.array(Cell).length(216),
    research: z.array(ShortV6ResearchRowSchema).length(2),
    searchNotes: z.array(z.string()),
  })
  .refine(
    (m) =>
      new Set(m.cells.map((c) => `${c.asset}/${c.strategy}/${c.mode}/${c.feeMode}`)).size === 216 &&
      new Set(m.profiles.map((p) => `${p.asset}/${p.strategy}`)).size === 36 &&
      new Set(m.research.map((r) => r.asset)).size === 2 &&
      m.splitIndex === Math.floor((((m.to - m.from) / 3600000) * 2) / 3) &&
      m.research.every(
        (r) =>
          r.development.fromIndex === 0 &&
          r.development.toIndex === m.splitIndex &&
          r.check.fromIndex === m.splitIndex &&
          r.check.toIndex === (m.to - m.from) / 3600000,
      ),
    'Both coins and all frozen windows required',
  );
export type ShortV6Matrix = z.infer<typeof ShortV6MatrixSchema>;
export const ShortV6JobSchema = z.strictObject({
  id: z.string().uuid(),
  status: z.enum(['RUNNING', 'DONE', 'FAILED']),
  completed: z.number().int().min(0).max(2),
  total: z.literal(2),
  message: z.string(),
});
export const ShortV6StateSchema = z.strictObject({
  matrixId: HashSchema.nullable(),
  job: ShortV6JobSchema.nullable(),
  fees: ShortV6FeesSchema,
});
export const ShortV6SelectionSchema = z
  .strictObject({
    asset: DirectionMatrixSchema.shape.profiles.element.shape.asset,
    strategy: ShortV6KeySchema,
    mode: DirectionMatrixSchema.shape.cells.element.shape.mode,
  })
  .refine(
    (s) => !['V4', 'V5', 'V6'].includes(s.strategy) || ['SOL', 'XRP'].includes(s.asset),
    'Specialists only exist for SOL and XRP',
  );
export const ShortV6ViewSchema = DirectionViewSchema.extend({
  report: z.union([ShortV6ReportSchema, ...DirectionViewSchema.shape.report.options]),
});
