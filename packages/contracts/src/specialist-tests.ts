import { z } from 'zod';
import { HashSchema, NonNegativeDecimalSchema } from './primitives.js';
import { BtcReplayWindowSchema, BtcAttributionSchema } from './btc-test.js';
import {
  MarketReportSchema,
  MarketHistorySchema,
  MarketFeeModeSchema,
  MarketFiltersSchema,
  MarketSummarySchema,
  MarketReplayDecisionSchema,
} from './market-tests.js';
export const SpecialistAssetSchema = z.enum(['SOL', 'XRP']);
export type SpecialistAsset = z.infer<typeof SpecialistAssetSchema>;
export const SpecialistKeySchema = z.enum(['V1', 'V2', 'V3', 'V4']);
export type SpecialistKey = z.infer<typeof SpecialistKeySchema>;
export const SpecialistFeesSchema = z.strictObject({
  V1: z.boolean(),
  V2: z.boolean(),
  V3: z.boolean(),
  V4: z.boolean(),
});
export const DEFAULT_SPECIALIST_FEES = { V1: true, V2: true, V3: true, V4: true };
export const SpecialistCandidateSchema = z
  .strictObject({
    asset: SpecialistAssetSchema,
    base: z.enum(['V2', 'V3']),
    stopAtr: z.enum(['1.5', '2', '2.5']),
    targetAtr: z.enum(['3', '3.5', '4', '4.5', '5', '6']),
    minSignalRangeAtr: z.enum(['0.8', '1', '1.25']).optional(),
    trendSlopeHours: z.union([z.literal(12), z.literal(24), z.literal(48)]),
  })
  .refine(
    (c) =>
      c.asset === 'XRP'
        ? c.base === 'V3' && c.stopAtr === '2'
        : c.base === 'V2' &&
          c.trendSlopeHours === 24 &&
          !c.minSignalRangeAtr &&
          ['3', '4', '5', '6'].includes(c.targetAtr),
    'Candidate must follow its coin-specific search protocol',
  );
export type SpecialistCandidate = z.infer<typeof SpecialistCandidateSchema>;
export const SpecialistPlanSchema = z.strictObject({
  strategy: z.literal('V4'),
  candidate: SpecialistCandidateSchema,
  feeMode: MarketFeeModeSchema,
  reference: MarketReportSchema.shape.plan.shape.reference,
  filters: MarketFiltersSchema,
});
export const SpecialistReportSchema = MarketReportSchema.omit({
  version: true,
  asset: true,
  plan: true,
  decisions: true,
})
  .extend({
    version: z.literal('specialist-replay.v1'),
    asset: SpecialistAssetSchema,
    plan: SpecialistPlanSchema,
    window: BtcReplayWindowSchema,
    decisions: z
      .array(
        MarketReplayDecisionSchema.extend({
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
        }),
      )
      .min(100)
      .max(6000),
  })
  .refine(
    (r) => r.asset === r.plan.candidate.asset && r.symbol === r.asset + 'USDT',
    'Specialist instrument mismatch',
  );
export type SpecialistReport = z.infer<typeof SpecialistReportSchema>;
export const SpecialistCellSchema = z.strictObject({
  strategy: SpecialistKeySchema,
  reportId: HashSchema,
  summary: MarketSummarySchema,
  attribution: BtcAttributionSchema,
  exposureFraction: NonNegativeDecimalSchema,
});
const Evidence = z.strictObject({ reportId: HashSchema, summary: MarketSummarySchema });
export const SpecialistSearchRowSchema = z.strictObject({
  candidate: SpecialistCandidateSchema,
  development: Evidence,
  eligible: z.boolean(),
  selected: z.boolean(),
});
export const SpecialistRowSchema = z
  .strictObject({
    asset: SpecialistAssetSchema,
    datasetId: HashSchema,
    baseline: z.enum(['V2', 'V3']),
    selected: SpecialistCandidateSchema,
    diagnosis: z.array(z.string()),
    search: z.array(SpecialistSearchRowSchema).min(12).max(24),
    development: z.strictObject({
      fromIndex: z.literal(0),
      toIndex: z.number().int(),
      baseline: Evidence,
      selected: Evidence,
    }),
    check: z.strictObject({
      fromIndex: z.number().int(),
      toIndex: z.number().int(),
      baseline: Evidence,
      selected: Evidence,
    }),
    variants: z.strictObject({
      STANDARD: z.array(SpecialistCellSchema).length(4),
      ZERO: z.array(SpecialistCellSchema).length(4),
    }),
  })
  .refine(
    (r) => r.selected.asset === r.asset && r.search.filter((c) => c.selected).length === 1,
    'One selected candidate per coin',
  );
export const SpecialistMatrixSchema = z
  .strictObject({
    version: z.literal('sol-xrp-lab.v1'),
    origin: z.literal('PUBLIC_HISTORICAL'),
    engineHash: HashSchema,
    generatedAt: z.string().datetime().optional(),
    sourceMatrixId: HashSchema,
    from: z.number().int(),
    to: z.number().int(),
    splitIndex: z.number().int(),
    initialUsdt: z.literal('10000'),
    interval: z.literal('1h'),
    selection: z.literal('DEVELOPMENT_NET_PNL_FIXED_RISK_NOT_GLOBAL_OPTIMUM'),
    historyUse: z.literal('PREVIOUSLY_SEEN_HISTORY_EXPLORATORY_CHECK'),
    candidatesPerCoin: z.literal(12),
    candidateCounts: z.strictObject({ SOL: z.literal(12), XRP: z.literal(24) }).optional(),
    searchNotes: z.array(z.string()).optional(),
    rows: z.array(SpecialistRowSchema).length(2),
  })
  .refine((m) => new Set(m.rows.map((r) => r.asset)).size === 2, 'Both SOL and XRP are required');
export type SpecialistMatrix = z.infer<typeof SpecialistMatrixSchema>;
export const SpecialistJobSchema = z.strictObject({
  id: z.string().uuid(),
  status: z.enum(['RUNNING', 'DONE', 'FAILED']),
  message: z.string(),
  completed: z.number().int().min(0).max(2),
  total: z.literal(2),
});
export const SpecialistStateSchema = z.strictObject({
  matrixId: HashSchema.nullable(),
  job: SpecialistJobSchema.nullable(),
  fees: SpecialistFeesSchema,
});
export const SpecialistViewSchema = z.strictObject({
  id: HashSchema,
  report: z.union([MarketReportSchema, SpecialistReportSchema]),
  attribution: BtcAttributionSchema,
  dataset: MarketHistorySchema.omit({ bars: true, captures: true }),
  bars: MarketHistorySchema.shape.bars,
  sources: z
    .array(
      z.strictObject({
        url: z.string().url(),
        receivedAt: z.string().datetime(),
        hash: HashSchema,
      }),
    )
    .max(9),
});
