import { z } from 'zod';
import { HashSchema, DecimalStringSchema } from './primitives.js';
import { MarketAssetSchema } from './market-tests.js';
import type { NewsResearchEffect, NewsResearchRule } from './news-research.js';
import {
  NewsResearchReport,
  NewsResearchModel,
  NewsResearchRow,
  NewsResearchRun,
  NewsResearchEvaluation,
} from './news-research.js';

const stamp = z.number().int().nonnegative();
export const MacroExpectationSchema = z.strictObject({
  metric: z.enum(['CPI_MOM', 'PAYROLL_CHANGE', 'FED_TARGET_UPPER']),
  releaseAt: stamp,
  observedAt: stamp,
  publishedAt: stamp,
  value: DecimalStringSchema,
  unit: z.enum(['PERCENT', 'PERSONS']),
  sourceId: z.string(),
  url: z.string().url(),
  contentHash: HashSchema,
});
export const NewsV3Event = z.strictObject({
  id: HashSchema,
  versionId: z.string(),
  sourceId: z.string(),
  publisher: z.string(),
  independenceGroup: z.string(),
  title: z.string().max(500),
  url: z.string().url(),
  assets: z.array(MarketAssetSchema).max(10),
  publishedAt: stamp.nullable(),
  availableAt: stamp,
  kind: z.enum([
    'PROTOCOL',
    'SECURITY',
    'SERVICE',
    'REGULATORY',
    'ADOPTION',
    'MACRO',
    'ROUTINE',
    'OTHER',
  ]),
  stage: z.enum([
    'ACTIVATED',
    'ANNOUNCED',
    'PROPOSED',
    'TESTNET',
    'POSTPONED',
    'CANCELLED',
    'CONFIRMED',
    'RESOLVED',
    'NEGATED',
    'UNCONFIRMED',
    'ROUTINE',
    'UNKNOWN',
  ]),
  severity: z.enum(['HIGH', 'MEDIUM', 'LOW', 'UNKNOWN']),
  attribution: z.enum(['OFFICIALLY_STATED', 'VENDOR_COMMENTARY', 'UNVERIFIED']),
  group: z.string().max(80),
  scope: z.enum(['DIRECT', 'MARKET_CONTEXT']),
  gate: z.enum([
    'ELIGIBLE_FOR_DESCRIPTIVE_ESTIMATION',
    'HOLD_ROUTINE',
    'HOLD_PLANNED_OR_TESTNET',
    'HOLD_DELAY_OR_CANCELLATION',
    'HOLD_UNCERTAIN_OR_RESOLVED',
    'HOLD_MISSING_EXPECTATIONS',
    'HOLD_UNDATED',
    'HOLD_PERMISSION',
    'HOLD_IRRELEVANT',
    'HOLD_DUPLICATE',
  ]),
  evidenceQuotes: z.array(z.string().max(500)).min(1).max(2),
  macro: z
    .strictObject({
      metric: z.enum(['CPI_MOM', 'PAYROLL_CHANGE', 'FED_TARGET_UPPER']),
      unit: z.enum(['PERCENT', 'PERSONS']),
      actual: DecimalStringSchema.nullable(),
      consensus: DecimalStringSchema.nullable(),
      surprise: DecimalStringSchema.nullable(),
      expectationHash: HashSchema.nullable(),
      expectationAvailableAt: stamp.nullable(),
    })
    .nullable(),
});
export const NewsV3Model = NewsResearchModel.extend({
  version: z.literal('LEARNED_V3'),
  walkForward: z
    .array(
      z.strictObject({
        trainEnd: stamp,
        validationEnd: stamp,
        testEnd: stamp,
        configId: z.string(),
        evaluation: NewsResearchEvaluation,
      }),
    )
    .length(3),
  holdReasons: z.record(z.string(), z.number().int().nonnegative()),
  fitEvidence: z
    .array(
      z.strictObject({
        group: z.string(),
        count: z.number().int(),
        minimum: z.number().int(),
        lowerEdge: z.number(),
        requiredEdge: z.number(),
        side: z.enum(['LONG', 'SHORT', 'HOLD']),
      }),
    )
    .max(100),
});
export const NewsV3Row = NewsResearchRow.omit({ models: true }).extend({
  models: z.array(z.union([NewsResearchModel, NewsV3Model])).max(3),
  v3Coverage: z.strictObject({
    relevant: z.number().int(),
    dated: z.number().int(),
    eligible: z.number().int(),
    independentGroups: z.number().int(),
    historicallyTimely: z.number().int(),
    gates: z.record(z.string(), z.number().int()),
  }),
});
export const NewsMinuteDiagnostic = z.strictObject({
  asset: MarketAssetSchema,
  eventId: HashSchema,
  status: z.enum(['COMPLETE', 'UNAVAILABLE']),
  datasetHash: HashSchema.nullable(),
  firstMinuteEntryAt: stamp.nullable(),
  hourlyEntryAt: stamp,
  return5m: z.number().nullable(),
  return15m: z.number().nullable(),
  return60m: z.number().nullable(),
  error: z.string().nullable(),
});
export const NewsV3Report = z
  .strictObject({
    ...NewsResearchReport.shape,
    version: z.literal('news-history-comparison.v3'),
    baselineRunId: z.string().uuid(),
    baselineReportHash: HashSchema,
    baselineEngineHash: HashSchema,
    protocolV3: z.strictObject({
      version: z.literal('structured-news.v3'),
      candidates: z.literal(6),
      minimumSamples: z.tuple([z.literal(12), z.literal(20)]),
      uncertaintyZ: z.literal(1.96),
      costBuffer: z.literal(2),
      purgeHours: z.literal(72),
      minimumValidationTrades: z.literal(5),
      hourlyComparison: z.literal(true),
      minuteDiagnostics: z.literal('SEPARATE_DESCRIPTIVE_REACTION_WINDOWS'),
      expectationProvider: z.literal('NOT_CONFIGURED'),
    }),
    rows: z.array(NewsV3Row).length(11),
    structuredEvents: z.array(NewsV3Event).max(20000),
    minuteDiagnostics: z.array(NewsMinuteDiagnostic).max(24),
  })
  .superRefine((r, c) => {
    if (new Set(r.rows.map((x) => x.asset)).size !== 11)
      c.addIssue({ code: 'custom', message: 'All tokens and USDT must appear once' });
    for (const row of r.rows) {
      if (row.asset === 'USDT') {
        if (row.status !== 'CASH_CONTROL' || row.models.length)
          c.addIssue({ code: 'custom', message: 'USDT must remain cash' });
      } else if (
        row.status === 'COMPLETE' &&
        (row.models.length !== 3 ||
          row.models.map((m) => m.version).join(',') !== 'RULES_V1,LEARNED_V2,LEARNED_V3')
      )
        c.addIssue({ code: 'custom', message: 'Comparison requires frozen V1/V2 plus V3' });
    }
  });
export const NewsV3Run = NewsResearchRun.extend({ baselineRunId: z.string().uuid() });
export const NewsV3Status = z.strictObject({
  runs: z.array(NewsV3Run).max(20),
  workerHealthy: z.boolean(),
});
export type V3Event = z.infer<typeof NewsV3Event>;
export type V3Report = z.infer<typeof NewsV3Report>;
export type V3Model = z.infer<typeof NewsV3Model>;
export type MacroExpectation = z.infer<typeof MacroExpectationSchema>;
export type MinuteDiagnostic = z.infer<typeof NewsMinuteDiagnostic>;
export type V3Rule = z.infer<typeof NewsResearchRule>;
export type V3Effect = z.infer<typeof NewsResearchEffect>;
