import { z } from 'zod';
import { HashSchema, DecimalStringSchema } from './primitives.js';
import { NewsResearchEvent, NewsResearchModel, NewsResearchEvaluation } from './news-research.js';
import { NewsV3Model } from './news-research-v3.js';
import { NewsV4Model } from './news-research-v4.js';
import { NewsV5Model, NewsV5Report, NewsV5Run, NewsV5Status } from './news-research-v5.js';
import type { V5Report } from './news-research-v5.js';

// PostgreSQL jsonb can reorder record keys. Compare values independently of object-key order.
const stableJson = (input: unknown) =>
  JSON.stringify(input, (_key, value: unknown) =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
        )
      : value,
  );

export const NewsV6CaseId = z.enum([
  'V2_BASELINE',
  'UNCERTAINTY_ONLY',
  'GROUP_VALIDATION_ONLY',
  'CONCENTRATION_SELECTION_ONLY',
]);
export const NewsV6Case = z
  .strictObject({
    id: NewsV6CaseId,
    change: z.string(),
    changedFields: z.array(z.string()).max(3),
    model: NewsResearchModel,
    validationScore: z.number(),
    validationDelta: DecimalStringSchema,
    finalDelta: DecimalStringSchema,
    validationWindows: z.array(NewsResearchEvaluation).length(3),
    groupChecks: z
      .array(
        z.strictObject({
          group: z.string(),
          validationTrades: z.number().int().nonnegative(),
          validationPnl: DecimalStringSchema,
          retained: z.boolean(),
        }),
      )
      .max(100),
  })
  .superRefine((a, c) => {
    const expected = {
      V2_BASELINE: [],
      UNCERTAINTY_ONLY: ['uncertaintyZ'],
      GROUP_VALIDATION_ONLY: ['categoryValidationGate'],
      CONCENTRATION_SELECTION_ONLY: ['candidateSelectionScore'],
    }[a.id];
    if (JSON.stringify(a.changedFields) !== JSON.stringify(expected))
      c.addIssue({ code: 'custom', message: 'Ablation must declare exactly its one changed rule' });
  });
export const NewsV6Model = NewsResearchModel.extend({
  version: z.literal('LEARNED_V6'),
  trainingMethod: z.literal('V2_SINGLE_FACTOR_ABLATIONS'),
  selectedCase: z.union([NewsV6CaseId, z.literal('CASH')]),
  ablations: z.array(NewsV6Case).length(4),
  eventsHash: HashSchema,
}).superRefine((m, c) => {
  if (
    m.ablations.map((a) => a.id).join(',') !==
    'V2_BASELINE,UNCERTAINTY_ONLY,GROUP_VALIDATION_ONLY,CONCENTRATION_SELECTION_ONLY'
  )
    c.addIssue({ code: 'custom', message: 'All four independent V2 cases required' });
  const selected = m.ablations.find((a) => a.id === m.selectedCase);
  const accountFields = [
    'config',
    'rules',
    'evaluations',
    'doubleCostTestPnl',
    'delayedTestPnl',
  ] as const;
  if (selected && accountFields.some((k) => stableJson(m[k]) !== stableJson(selected.model[k])))
    c.addIssue({ code: 'custom', message: 'Selected V6 account must equal its selected case' });
  if (m.selectedCase === 'CASH' && (m.rules.length || m.evaluations.some((e) => e.trades.length)))
    c.addIssue({ code: 'custom', message: 'Cash fallback cannot trade' });
});
export const NewsV6Report = z
  .strictObject({
    ...NewsV5Report.shape,
    version: z.literal('news-history-comparison.v6'),
    referenceV5RunId: z.string().uuid(),
    referenceV5ReportHash: HashSchema,
    limitationsV6: z.array(z.string()).max(12),
    protocolV6: z.strictObject({
      baselineCandidates: z.literal(36),
      singleFactorVariants: z.literal(3),
      selectionCases: z.literal(4),
      uncertaintyZ: z.literal(1.28),
      groupValidationMinimumTrades: z.literal(3),
      groupValidationCosts: z.literal('NORMAL_FEES_ONLY'),
      largestWinnerPenalty: z.literal(0.5),
      minimumValidationTrades: z.literal(3),
      validationWindows: z.literal(3),
      fedCategories: z.literal('UNCHANGED_V2_SEPARATE_EASING_TIGHTENING_OTHER'),
      controls: z.literal('UNCHANGED_V2_EVENT_UNIVERSE_AND_CONTROL_SAMPLING'),
      selection: z.literal('VALIDATION_ONLY_SINGLE_CASE_NO_COMBINED_CHANGES'),
    }),
    replayEventsV6: z.array(NewsResearchEvent).max(20000),
    rows: z
      .array(
        NewsV5Report.shape.rows.element.omit({ models: true }).extend({
          models: z
            .array(z.union([NewsResearchModel, NewsV3Model, NewsV4Model, NewsV5Model, NewsV6Model]))
            .max(6),
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
              'RULES_V1,LEARNED_V2,LEARNED_V3,LEARNED_V4,LEARNED_V5,LEARNED_V6'
      )
        c.addIssue({ code: 'custom', message: 'Six versions required; USDT stays cash' });
      const v6 = row.models.find((m) => m.version === 'LEARNED_V6');
      if (
        v6?.version === 'LEARNED_V6' &&
        stableJson(v6.ablations[0]!.model) !== stableJson(row.models[1])
      )
        c.addIssue({
          code: 'custom',
          message: 'V6 baseline must preserve the original V2 model exactly',
        });
    }
  });
export const NewsV6Run = NewsV5Run;
export const NewsV6Status = NewsV5Status;
export type V6Report = z.infer<typeof NewsV6Report>;
export type V6Model = z.infer<typeof NewsV6Model>;
export type V6Case = z.infer<typeof NewsV6Case>;
export type V6CaseId = z.infer<typeof NewsV6CaseId>;

/** Project away only V6's added fields and model; all inherited evidence must equal its parent. */
export function newsV6ParentProjection(report: V6Report, parent: V5Report) {
  const {
    referenceV5RunId,
    referenceV5ReportHash,
    protocolV6,
    replayEventsV6,
    limitationsV6,
    ...inherited
  } = report;
  void referenceV5RunId;
  void referenceV5ReportHash;
  void protocolV6;
  void replayEventsV6;
  void limitationsV6;
  return NewsV5Report.parse({
    ...inherited,
    version: parent.version,
    engineHash: parent.engineHash,
    generatedAt: parent.generatedAt,
    rows: report.rows.map((row) => ({ ...row, models: row.models.slice(0, 5) })),
  });
}
