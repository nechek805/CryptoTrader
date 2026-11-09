import { z } from 'zod';
import { HashSchema, DecimalStringSchema } from './primitives.js';
import { NewsResearchEvent, NewsResearchModel, NewsResearchRow } from './news-research.js';
import { NewsV3Model } from './news-research-v3.js';
import { NewsV4Model, NewsV4Report, NewsV4Run, NewsV4Status } from './news-research-v4.js';

const AttributionBucket = z.strictObject({
  label: z.string(),
  trades: z.number().int().nonnegative(),
  wins: z.number().int().nonnegative(),
  netPnl: DecimalStringSchema,
  fees: DecimalStringSchema,
});
export const NewsV2Attribution = z.strictObject({
  groups: z.array(AttributionBucket),
  directions: z.array(AttributionBucket),
  months: z.array(AttributionBucket),
  largestWin: DecimalStringSchema,
  withoutLargestWin: DecimalStringSchema,
  explanation: z.array(z.string()).max(12),
});
export const NewsV5GroupCheck = z.strictObject({
  configId: z.string(),
  group: z.string(),
  side: z.enum(['LONG', 'SHORT', 'HOLD']),
  trainingCount: z.number().int().nonnegative(),
  validationTrades: z.number().int().nonnegative(),
  validationMonths: z.number().int().nonnegative(),
  validationPnl: DecimalStringSchema,
  doubleCostValidationPnl: DecimalStringSchema,
  accepted: z.boolean(),
  reason: z.string(),
});
export const NewsV5Model = NewsResearchModel.extend({
  version: z.literal('LEARNED_V5'),
  trainingMethod: z.literal('RELEASE_GROUP_REACTIONS_WITH_COSTED_GROUP_VALIDATION'),
  groupChecks: z.array(NewsV5GroupCheck).max(300),
});
export const NewsV5Report = z
  .strictObject({
    ...NewsV4Report.shape,
    version: z.literal('news-history-comparison.v5'),
    referenceV4RunId: z.string().uuid(),
    referenceV4ReportHash: HashSchema,
    protocolV5: z.strictObject({
      candidates: z.literal(3),
      minimumTrainingSamples: z.literal(8),
      costBuffer: z.literal(2),
      uncertaintyZ: z.literal(0),
      minimumGroupValidationTrades: z.literal(3),
      minimumGroupValidationMonths: z.literal(2),
      minimumValidationTrades: z.literal(5),
      largestWinnerPenalty: z.literal(0.5),
      selection: z.literal('TRAIN_DIRECTIONS_VALIDATION_GROUPS_AND_HORIZON_NO_FINAL_LABELS'),
    }),
    replayEventsV5: z.array(NewsResearchEvent).max(20000),
    rows: z
      .array(
        NewsResearchRow.omit({ models: true }).extend({
          models: z
            .array(z.union([NewsResearchModel, NewsV3Model, NewsV4Model, NewsV5Model]))
            .max(5),
          v4Coverage: NewsV4Report.shape.rows.element.shape.v4Coverage,
          v2Attribution: NewsV2Attribution.nullable(),
        }),
      )
      .length(11),
  })
  .superRefine((r, c) => {
    if (
      new Set(r.rows.map((x) => x.asset)).size !== 11 ||
      new Set(r.markets.map((x) => x.asset)).size !== 10
    )
      c.addIssue({ code: 'custom', message: 'Complete frozen universe required' });
    for (const row of r.rows) {
      if (
        row.asset === 'USDT'
          ? row.models.length !== 0 || row.status !== 'CASH_CONTROL'
          : row.status !== 'COMPLETE' ||
            row.models.map((m) => m.version).join(',') !==
              'RULES_V1,LEARNED_V2,LEARNED_V3,LEARNED_V4,LEARNED_V5' ||
            !row.v2Attribution
      )
        c.addIssue({
          code: 'custom',
          message: 'Five comparable versions and V2 attribution required; USDT stays cash',
        });
    }
  });
export const NewsV5Run = NewsV4Run;
export const NewsV5Status = NewsV4Status;
export type V5Report = z.infer<typeof NewsV5Report>;
export type V5Model = z.infer<typeof NewsV5Model>;
export type V2Attribution = z.infer<typeof NewsV2Attribution>;
