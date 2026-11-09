import { z } from 'zod';

export const NewsSourceId = z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/);
const stamp = z.number().int().nonnegative();
export const LiveNewsSourceInput = z.strictObject({
  name: z.string().trim().min(2).max(120),
  homepage: z.string().url().max(1000),
  category: z.enum(['PUBLICATION', 'OFFICIAL', 'MACRO', 'AGGREGATOR', 'TELEGRAM', 'RESEARCH']),
  adapter: z.enum([
    'RSS_ATOM',
    'XRPL_BLOG',
    'BYBIT_JSON',
    'STATUSPAGE_JSON',
    'GDELT_DOC',
    'XRPL_LEDGER',
    'GOV_ARCHIVE',
    'SETUP_REQUIRED',
  ]),
  feedUrl: z.string().url().max(1000).nullable(),
  articleOrigins: z.array(z.string().url().max(200)).min(1).max(10),
  enabled: z.boolean(),
  pollIntervalSeconds: z.number().int().min(300).max(86400),
  independenceGroup: NewsSourceId,
  language: z.string().regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]+)?$/),
  collectionApproved: z.boolean(),
  aiAllowed: z.boolean(),
  maxExcerptChars: z.number().int().min(0).max(500),
  permissionReference: z.string().trim().min(5).max(1000),
  notes: z.string().max(1200),
});
export const LiveNewsSourceSchema = LiveNewsSourceInput.extend({
  id: NewsSourceId,
  revision: z.number().int().positive(),
  createdAt: stamp,
  updatedAt: stamp,
}).superRefine((s, c) => {
  if (s.enabled && (!s.collectionApproved || !s.feedUrl || s.adapter === 'SETUP_REQUIRED'))
    c.addIssue({ code: 'custom', message: 'Enable a supported approved feed first' });
  if (
    s.adapter === 'XRPL_BLOG' &&
    (s.feedUrl !== 'https://xrpl.org/blog' ||
      s.articleOrigins.length !== 1 ||
      s.articleOrigins[0] !== 'https://xrpl.org')
  )
    c.addIssue({
      code: 'custom',
      message: 'XRPL blog adapter requires its registered official URL and origin',
    });
  if (s.aiAllowed && !s.collectionApproved)
    c.addIssue({ code: 'custom', message: 'AI permission requires collection permission' });
  const fixed: Partial<Record<typeof s.adapter, string[]>> = {
    BYBIT_JSON: ['https://api.bybit.com/v5/announcements/index?locale=en-US&limit=100&page=1'],
    STATUSPAGE_JSON: [
      'https://status.solana.com/api/v2/incidents.json',
      'https://status.exchange.coinbase.com/api/v2/incidents.json',
    ],
    GDELT_DOC: [
      'https://api.gdeltproject.org/api/v2/doc/doc?query=%28bitcoin%20OR%20ethereum%20OR%20solana%20OR%20XRP%20OR%20dogecoin%20OR%20cardano%20OR%20chainlink%20OR%20avalanche%20OR%20BNB%20OR%20TRON%29&mode=artlist&format=json&maxrecords=250&timespan=1d',
    ],
    XRPL_LEDGER: ['https://xrplcluster.com/'],
    GOV_ARCHIVE: [
      'https://www.bls.gov/bls/news-release/cpi.htm',
      'https://www.bls.gov/bls/news-release/empsit.htm',
      'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm',
      'https://www.sec.gov/newsroom/press-releases?combine=crypto&page=0',
    ],
  };
  if (fixed[s.adapter] && !fixed[s.adapter]!.includes(s.feedUrl ?? ''))
    c.addIssue({
      code: 'custom',
      message: 'Public JSON/archive adapter requires a registered official endpoint',
    });
});
export type LiveNewsSource = z.infer<typeof LiveNewsSourceSchema>;
export const LiveNewsSourceHealth = z.object({
  lastAttemptAt: stamp.nullable(),
  lastSuccessAt: stamp.nullable(),
  nextAllowedAt: stamp,
  lastError: z.string().max(160).nullable(),
  lastHttpStatus: z.number().int().nullable(),
  consecutiveFailures: z.number().int().nonnegative(),
  lastItemCount: z.number().int().nonnegative(),
  totalArticles: z.number().int().nonnegative(),
  requestsToday: z.number().int().nonnegative(),
  state: z.enum(['HEALTHY', 'STALE', 'ERROR', 'DISABLED', 'NEEDS_SETUP', 'WAITING']),
});
export const LiveNewsSourceView = z.object({
  config: LiveNewsSourceSchema,
  health: LiveNewsSourceHealth,
});
export const LiveNewsAnalysisResult = z.strictObject({
  summary: z.string().trim().min(5).max(600),
  assets: z
    .array(
      z.enum([
        'BTC',
        'ETH',
        'SOL',
        'XRP',
        'USDT',
        'TRX',
        'BNB',
        'ADA',
        'DOGE',
        'AVAX',
        'LINK',
        'OTHER',
      ]),
    )
    .max(8),
  eventType: z.enum([
    'SECURITY',
    'REGULATION',
    'LISTING',
    'EXCHANGE_STATUS',
    'MONETARY_POLICY',
    'PROTOCOL',
    'MARKET_COMMENTARY',
    'OTHER',
  ]),
  direction: z.enum(['BULLISH', 'BEARISH', 'MIXED', 'UNCLEAR']),
  severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'UNKNOWN']),
  negated: z.boolean(),
  evidenceQuotes: z.array(z.string().min(3).max(240)).min(1).max(3),
  uncertainties: z.array(z.string().min(1).max(200)).max(6),
});
export type NewsAnalysisResult = z.infer<typeof LiveNewsAnalysisResult>;
export const LiveNewsAnalysisSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(['ANALYZED', 'REVIEW_REQUIRED', 'FAILED']),
  result: LiveNewsAnalysisResult.nullable(),
  error: z.string().max(160).nullable(),
  provider: z.string().max(200),
  model: z.string().max(120),
  promptVersion: z.string().max(80),
  profileHash: z.string(),
  inputHash: z.string(),
  responseHash: z.string().nullable(),
  processedAt: stamp,
  availableAt: stamp,
  promptTokens: z.number().int().nonnegative().nullable(),
  completionTokens: z.number().int().nonnegative().nullable(),
  evidenceStatus: z.enum(['OFFICIALLY_STATED', 'UNVERIFIED']),
});
export const LiveNewsVersionSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  articleId: z.string().regex(/^[a-f0-9]{64}$/),
  sourceId: NewsSourceId,
  sourceRevision: z.number().int().positive(),
  revision: z.number().int().positive(),
  publisher: z.string(),
  independenceGroup: NewsSourceId,
  title: z.string().min(1).max(500),
  url: z.string().url(),
  providerItemId: z.string().max(1000),
  excerpt: z.string().max(500),
  language: z.string().max(20),
  publishedAt: stamp.nullable(),
  publisherUpdatedAt: stamp.nullable(),
  firstSeenAt: stamp,
  fetchedAt: stamp,
  availableAt: stamp,
  contentHash: z.string(),
  feedHash: z.string(),
  duplicateGroup: z.string(),
  timestampStatus: z.enum(['VALID', 'MISSING', 'UNCERTAIN']),
  captureKind: z.enum(['INITIAL_SNAPSHOT', 'LIVE_POLL']),
  aiAllowed: z.boolean(),
});
export type LiveNewsVersion = z.infer<typeof LiveNewsVersionSchema>;
export const LiveNewsArticleView = z.object({
  version: LiveNewsVersionSchema,
  analysis: LiveNewsAnalysisSchema.nullable(),
  analysisState: z.enum(['PENDING', 'ANALYZED', 'REVIEW_REQUIRED', 'FAILED', 'NOT_PERMITTED']),
  duplicateCount: z.number().int().positive(),
});
export const LiveNewsQuery = z.object({
  source: NewsSourceId.optional(),
  search: z.string().trim().max(100).optional(),
  asset: z
    .string()
    .regex(/^[A-Z]{2,10}$/)
    .optional(),
  analysis: z
    .enum(['PENDING', 'ANALYZED', 'REVIEW_REQUIRED', 'FAILED', 'NOT_PERMITTED'])
    .optional(),
  from: z.coerce.number().int().nonnegative().optional(),
  to: z.coerce.number().int().nonnegative().optional(),
  sort: z.enum(['observed', 'published']).default('observed'),
  direction: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export const LiveNewsPage = z.object({
  items: z.array(LiveNewsArticleView),
  total: z.number().int().nonnegative(),
  page: z.number().int(),
  pageSize: z.number().int(),
});
export const LiveNewsAiProfile = z.object({
  provider: z.string().max(200),
  model: z.string().max(120),
  promptVersion: z.string().max(80),
  profileHash: z.string(),
  configured: z.boolean(),
  enabled: z.boolean(),
  dailyLimit: z.number().int().min(1).max(1000),
  requestsToday: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
  nextAllowedAt: stamp,
});
