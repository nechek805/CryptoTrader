import { z } from 'zod';
import { Decimal } from 'decimal.js';
import { LiveNewsVersionSchema, LiveNewsSourceSchema } from './live-news.js';
import { MARKET_ASSETS, MarketAssetSchema } from './market-tests.js';
import { HashSchema, DecimalStringSchema } from './primitives.js';

export const NEWS_RESEARCH_ASSETS = [...MARKET_ASSETS, 'USDT'] as const;
export const NewsResearchAsset = z.enum(NEWS_RESEARCH_ASSETS);
const time = z.number().int().nonnegative();
export const NewsResearchSnapshot = z.strictObject({
  capturedAt: time,
  total: z.number().int().min(0).max(20000),
  sources: z.array(LiveNewsSourceSchema).max(200),
  versions: z.array(LiveNewsVersionSchema).max(20000),
});
export const NewsResearchPlan = z
  .strictObject({
    version: z.literal('news-history-protocol.v1'),
    from: time,
    trainEnd: time,
    validationEnd: time,
    to: time,
    initialUsdt: z.literal('10000'),
    targetUsdt: z.literal('100'),
    allocation: z.literal('0.2'),
    feeRate: z.literal('0.001'),
    slippage: z.literal('0.0005'),
    shortBorrowHourly: z.literal('0.000003'),
    latencyMs: z.literal(300000),
    stopFraction: z.literal('0.025'),
    targetFraction: z.literal('0.05'),
    candidatesPerAsset: z.literal(36),
    holdoutPreviouslyViewed: z.boolean(),
  })
  .refine(
    (p) => p.from < p.trainEnd && p.trainEnd < p.validationEnd && p.validationEnd < p.to,
    'Chronological research split required',
  );
export const NewsResearchConfig = z.strictObject({
  id: z.string().max(80),
  horizonHours: z.number().int().min(1).max(168),
  minSamples: z.number().int().min(0).max(50),
  edgeBuffer: z.number().min(0).max(5),
  uncertaintyZ: z.number().min(0).max(3),
});
export const NewsResearchEvent = z.strictObject({
  id: HashSchema,
  versionId: z.string(),
  sourceId: z.string(),
  publisher: z.string(),
  independenceGroup: z.string(),
  url: z.string().url(),
  title: z.string().max(500),
  assets: z.array(MarketAssetSchema).max(10),
  group: z.string().max(80),
  publishedAt: time,
  availableAt: time,
  fixedSide: z.enum(['LONG', 'SHORT', 'HOLD']),
  scope: z.enum(['DIRECT', 'MARKET_CONTEXT']),
  timing: z.literal('DESCRIPTIVE_PUBLICATION_PROXY'),
});
export const NewsResearchTrade = z.strictObject({
  eventId: HashSchema,
  side: z.enum(['LONG', 'SHORT']),
  entryAt: time,
  exitAt: time,
  entryPrice: DecimalStringSchema,
  exitPrice: DecimalStringSchema,
  quantity: DecimalStringSchema,
  stop: DecimalStringSchema,
  target: DecimalStringSchema,
  netPnl: DecimalStringSchema,
  fees: DecimalStringSchema,
  financing: DecimalStringSchema,
  slippageCost: DecimalStringSchema,
  reason: z.enum(['STOP', 'TARGET', 'HORIZON', 'PERIOD_END']),
  status: z.enum(['WIN', 'LOSS', 'FLAT']),
});
const FinancialDecimal = Decimal.clone({ precision: 256, rounding: Decimal.ROUND_HALF_EVEN });
export const NewsResearchEvaluation = z
  .strictObject({
    phase: z.enum(['TRAIN', 'VALIDATION', 'TEST']),
    from: time,
    to: time,
    endingUsdt: DecimalStringSchema,
    netPnl: DecimalStringSchema,
    fees: DecimalStringSchema,
    financing: DecimalStringSchema,
    slippageCost: DecimalStringSchema,
    maxDrawdown: z.number().min(0).max(1),
    wins: z.number().int().nonnegative(),
    trades: z.array(NewsResearchTrade).max(2000),
    skipped: z.record(z.string(), z.number().int().nonnegative()),
  })
  .superRefine((e, c) => {
    const sum = (field: 'netPnl' | 'fees' | 'financing' | 'slippageCost') =>
      e.trades.reduce((n, t) => n.plus(t[field]), new FinancialDecimal(0));
    if (
      !sum('netPnl').eq(e.netPnl) ||
      !sum('fees').eq(e.fees) ||
      !sum('financing').eq(e.financing) ||
      !sum('slippageCost').eq(e.slippageCost) ||
      !new FinancialDecimal(e.endingUsdt).eq(new FinancialDecimal(10000).plus(e.netPnl))
    )
      c.addIssue({ code: 'custom', message: 'Research position/account reconciliation failed' });
    if (e.wins !== e.trades.filter((t) => t.status === 'WIN').length)
      c.addIssue({ code: 'custom', message: 'Win count mismatch' });
    for (let i = 0; i < e.trades.length; i++) {
      const t = e.trades[i]!,
        pnl = new FinancialDecimal(t.netPnl);
      const gross = new FinancialDecimal(t.quantity)
        .mul(new FinancialDecimal(t.exitPrice).minus(t.entryPrice))
        .mul(t.side === 'LONG' ? 1 : -1);
      if (
        !gross.minus(t.fees).minus(t.financing).toDecimalPlaces(8).eq(pnl) ||
        t.status !== (pnl.gt(0) ? 'WIN' : pnl.lt(0) ? 'LOSS' : 'FLAT')
      )
        c.addIssue({ code: 'custom', message: 'Research position P&L mismatch' });
      if (
        t.entryAt < e.from ||
        t.exitAt >= e.to ||
        t.exitAt < t.entryAt ||
        (i > 0 && t.entryAt <= e.trades[i - 1]!.exitAt)
      )
        c.addIssue({
          code: 'custom',
          message: 'Position crosses split or overlaps another position',
        });
    }
  });
export const NewsResearchEffect = z.strictObject({
  group: z.string(),
  horizonHours: z.number(),
  count: z.number().int(),
  upFraction: z.number().min(0).max(1),
  meanReturn: z.number(),
  meanExcessReturn: z.number(),
  standardError: z.number().nonnegative(),
  controlCount: z.number().int(),
  examples: z.array(HashSchema).max(3),
});
export const NewsResearchRule = z.strictObject({
  group: z.string(),
  count: z.number().int(),
  side: z.enum(['LONG', 'SHORT', 'HOLD']),
  meanExcessReturn: z.number(),
  standardError: z.number().nonnegative(),
});
export const NewsResearchModel = z.strictObject({
  version: z.enum(['RULES_V1', 'LEARNED_V2']),
  config: NewsResearchConfig,
  rules: z.array(NewsResearchRule).max(100),
  trials: z.number().int(),
  candidates: z
    .array(
      z.strictObject({
        config: NewsResearchConfig,
        validationPnl: DecimalStringSchema,
        validationTrades: z.number().int(),
        score: z.number(),
      }),
    )
    .max(36),
  evaluations: z.array(NewsResearchEvaluation).length(3),
  doubleCostTestPnl: DecimalStringSchema,
  delayedTestPnl: DecimalStringSchema,
  targetReachedDescriptively: z.boolean(),
  qualifiedForForwardTest: z.literal(false),
  rejectionReasons: z.array(z.string()).max(20),
  modelHash: HashSchema,
});
export const NewsResearchRow = z.strictObject({
  asset: NewsResearchAsset,
  status: z.enum(['COMPLETE', 'NO_MARKET_DATA', 'CASH_CONTROL']),
  marketHash: HashSchema.nullable(),
  eventCount: z.number().int(),
  historicallyAvailableEvents: z.number().int(),
  effects: z.array(NewsResearchEffect).max(500),
  models: z.array(NewsResearchModel).max(2),
  buyHoldNetPnl: DecimalStringSchema.nullable(),
  error: z.string().nullable(),
});
export const NewsResearchReport = z
  .strictObject({
    version: z.literal('news-history-report.v1'),
    origin: z.literal('PUBLIC_HISTORICAL'),
    interpretation: z.literal('DESCRIPTIVE_ONLY_NOT_A_TRADABLE_BACKTEST'),
    generatedAt: time,
    engineHash: HashSchema,
    snapshotHash: HashSchema,
    planHash: HashSchema,
    plan: NewsResearchPlan,
    coverage: z.strictObject({
      collected: z.number().int(),
      datedInWindow: z.number().int(),
      undated: z.number().int(),
      permissionExcluded: z.number().int(),
      irrelevant: z.number().int(),
      deduplicated: z.number().int(),
      eligibleHistoricalVersions: z.number().int(),
      earliestFirstSeen: time.nullable(),
      bySource: z
        .array(
          z.strictObject({
            id: z.string(),
            name: z.string(),
            total: z.number().int(),
            datedInWindow: z.number().int(),
            eligible: z.number().int(),
          }),
        )
        .max(200),
    }),
    events: z.array(NewsResearchEvent).max(20000),
    rows: z.array(NewsResearchRow).length(11),
    limitations: z.array(z.string()).max(25),
  })
  .superRefine((r, c) => {
    if (new Set(r.rows.map((row) => row.asset)).size !== 11)
      c.addIssue({
        code: 'custom',
        message: 'Every token and cash control must appear exactly once',
      });
    for (const row of r.rows) {
      if (
        row.status === 'COMPLETE' &&
        (!row.marketHash || row.asset === 'USDT' || row.models.length !== 2)
      )
        c.addIssue({
          code: 'custom',
          message: 'Complete token research requires both models and a market snapshot',
        });
      if (row.asset === 'USDT' && (row.status !== 'CASH_CONTROL' || row.models.length))
        c.addIssue({ code: 'custom', message: 'USDT must remain a cash control' });
    }
  });
export const NewsResearchRun = z.strictObject({
  id: z.string().uuid(),
  createdAt: time,
  updatedAt: time,
  engineHash: HashSchema,
  plan: NewsResearchPlan,
  state: z.enum(['QUEUED', 'RUNNING', 'COMPLETE', 'FAILED']),
  stage: z.string().max(200),
  error: z.string().nullable(),
  reportHash: HashSchema.nullable(),
});
export const NewsResearchStatus = z.strictObject({
  runs: z.array(NewsResearchRun).max(20),
  workerHealthy: z.boolean(),
});
export type ResearchTrade = z.infer<typeof NewsResearchTrade>;
export type ResearchPlan = z.infer<typeof NewsResearchPlan>;
export type ResearchEvent = z.infer<typeof NewsResearchEvent>;
export type ResearchConfig = z.infer<typeof NewsResearchConfig>;
export type ResearchRule = z.infer<typeof NewsResearchRule>;
export type ResearchEvaluation = z.infer<typeof NewsResearchEvaluation>;
export type ResearchReport = z.infer<typeof NewsResearchReport>;
export type ResearchSnapshot = z.infer<typeof NewsResearchSnapshot>;
