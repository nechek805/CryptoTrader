import { z } from 'zod';
import { NewsEventSnapshotSchema } from './news-events.js';
import { NewsEventTypeSchema } from './news-extraction.js';
import { MarketStrategySourceSchema } from './market-strategies.js';
import { MarketBarSchema, SignalCandidateSchema } from './domain.js';
import { HashSchema, IdSchema, PositiveDecimalSchema, UtcTimestampSchema } from './primitives.js';
export const NewsRuleSchema = z.strictObject({
  id: IdSchema,
  eventType: NewsEventTypeSchema,
  side: z.enum(['LONG', 'SHORT']),
  minimumReportedAmount: z.strictObject({
    value: PositiveDecimalSchema,
    unit: z.string().regex(/^[A-Z][A-Z0-9]{0,19}$/),
  }),
  horizonSeconds: z.number().int().min(60).max(86400),
  maximumFirstKnownAgeSeconds: z.number().int().min(1).max(86400),
});
export const NewsSignalConfigSchema = z
  .strictObject({
    schemaVersion: z.literal('news-signal-config.v1'),
    algorithmVersion: z.literal('conservative-news-rules.v1'),
    declaredAt: UtcTimestampSchema,
    symbols: z
      .array(
        z.strictObject({
          asset: z.string().regex(/^[A-Z][A-Z0-9]{0,19}$/),
          symbol: SignalCandidateSchema.shape.symbol,
        }),
      )
      .min(1)
      .max(4),
    minimumIndependentOrigins: z.number().int().min(2).max(10),
    requireExpectationMismatch: z.boolean(),
    requireFirstSeen: z.boolean(),
    maximumMarketAgeSeconds: z.number().int().min(1).max(3600),
    maximumReceiptLagSeconds: z.number().int().min(0).max(86400),
    holdValiditySeconds: z.number().int().min(1).max(300),
    rules: z.array(NewsRuleSchema).min(1).max(10),
  })
  .superRefine((p, c) => {
    if (
      new Set(p.rules.map((r) => r.eventType)).size !== p.rules.length ||
      new Set(p.rules.map((r) => r.id)).size !== p.rules.length ||
      new Set(p.symbols.map((s) => s.symbol)).size !== p.symbols.length ||
      new Set(p.symbols.map((s) => s.asset)).size !== p.symbols.length
    )
      c.addIssue({ code: 'custom', message: 'Duplicate news rule or symbol binding' });
  });
export type NewsSignalConfig = z.infer<typeof NewsSignalConfigSchema>;
export const NewsFreshnessSchema = z.strictObject({
  schemaVersion: z.literal('news-freshness-veto.v1'),
  policy: z.literal('VETO_ONLY_NO_DIRECTION_OR_PRICE_V1'),
  symbol: SignalCandidateSchema.shape.symbol,
  decisionAt: UtcTimestampSchema,
  status: z.enum(['FRESH', 'MISSING', 'STALE', 'INELIGIBLE']),
  barId: IdSchema.nullable(),
  closeAt: UtcTimestampSchema.nullable(),
  availableAt: UtcTimestampSchema.nullable(),
  sourceIds: z.array(IdSchema),
  metadataIds: z.array(IdSchema),
  proofHash: HashSchema,
});
export type NewsFreshness = z.infer<typeof NewsFreshnessSchema>;
export const NewsFreshnessRequestSchema = z.strictObject({
  schemaVersion: z.literal('news-freshness-request.v1'),
  source: MarketStrategySourceSchema,
  bars: z.array(MarketBarSchema).max(256),
  decisionAt: UtcTimestampSchema,
  maximumAgeSeconds: z.number().int().min(1).max(3600),
});
export const NewsSignalQuerySchema = z.strictObject({
  schemaVersion: z.literal('news-signal-query.v1'),
  decisionAt: UtcTimestampSchema,
  eventId: IdSchema.nullable(),
  symbol: SignalCandidateSchema.shape.symbol,
  freshness: NewsFreshnessSchema,
});
export const NewsSignalStateSchema = z.strictObject({
  schemaVersion: z.literal('news-signal-state.v1'),
  providerHash: HashSchema,
  lastDecisionAt: UtcTimestampSchema.nullable(),
  slots: z
    .array(
      z.strictObject({
        eventId: IdSchema,
        symbol: SignalCandidateSchema.shape.symbol,
        materialHash: HashSchema,
        side: z.enum(['LONG', 'SHORT']),
      }),
    )
    .max(256),
});
export type NewsSignalState = z.infer<typeof NewsSignalStateSchema>;
export const NewsRuleOpinionSchema = z.strictObject({
  schemaVersion: z.literal('news-rule-opinion.v1'),
  eventId: IdSchema.nullable(),
  snapshotHash: HashSchema,
  decisionAt: UtcTimestampSchema,
  symbol: SignalCandidateSchema.shape.symbol,
  ruleId: IdSchema.nullable(),
  ruleHash: HashSchema.nullable(),
  conditionalSide: z.enum(['LONG', 'SHORT', 'HOLD']),
  supportGrade: z.enum(['INSUFFICIENT', 'ATTRIBUTED_SUPPORT', 'DISPUTED', 'WITHDRAWN', 'UNKNOWN']),
  independentOrigins: z.number().int().nonnegative(),
  representativeRootIds: z.array(IdSchema).max(1000),
  sourceIds: z.array(IdSchema).max(1000),
  evidenceIds: z.array(IdSchema).max(1000),
  firstKnownAt: UtcTimestampSchema.nullable(),
  availableAt: UtcTimestampSchema.nullable(),
  maxInputKnownAt: UtcTimestampSchema.nullable(),
  firstKnownAgeSeconds: z.number().nonnegative().nullable(),
  maximumObservedPublicationDelaySeconds: z.number().nonnegative().nullable(),
  severity: z.enum(['REPORTED_AMOUNT_THRESHOLD_MET', 'BELOW_THRESHOLD', 'UNKNOWN']),
  novelty: z.string(),
  surprise: z.string(),
  materialHash: HashSchema,
  reasons: z.array(z.string().min(1).max(100)).max(24),
  expiresAt: UtcTimestampSchema,
});
export type NewsRuleOpinion = z.infer<typeof NewsRuleOpinionSchema>;
export const NewsSignalDecisionSchema = z.strictObject({
  schemaVersion: z.literal('news-signal-decision.v1'),
  opinion: NewsRuleOpinionSchema,
  freshness: NewsFreshnessSchema,
  candidate: SignalCandidateSchema,
  abstentionReasons: z.array(z.string()).max(32),
  stateHash: HashSchema,
});
export type NewsSignalDecision = z.infer<typeof NewsSignalDecisionSchema>;
export const NewsSignalManifestSchema = z
  .strictObject({
    schemaVersion: z.literal('news-signal-manifest.v1'),
    generatedAt: UtcTimestampSchema,
    config: NewsSignalConfigSchema,
    cases: z
      .array(
        z.strictObject({
          id: IdSchema,
          fixtureTruth: z.enum([
            'SYNTHETIC_CONFIRMED',
            'SYNTHETIC_FAKE',
            'SYNTHETIC_RESCINDED',
            'SYNTHETIC_PARTIAL',
            'SYNTHETIC_UNKNOWN_TIME',
            'SYNTHETIC_STALE',
            'SYNTHETIC_SCHEDULED',
          ]),
          snapshot: NewsEventSnapshotSchema,
          sources: z.array(MarketStrategySourceSchema).min(1).max(4),
          bars: z.array(MarketBarSchema).max(256),
          decisionTimes: z.array(UtcTimestampSchema).min(1).max(32),
        }),
      )
      .min(1)
      .max(10),
  })
  .refine(
    (v) => new Set(v.cases.map((c) => c.id)).size === v.cases.length,
    'Duplicate news signal case',
  );
export type NewsSignalManifest = z.infer<typeof NewsSignalManifestSchema>;
export const NewsSignalLogSchema = z.strictObject({
  sequence: z.number().int().positive(),
  caseId: IdSchema,
  snapshotHash: HashSchema,
  decision: NewsSignalDecisionSchema,
  previousHash: HashSchema,
  hash: HashSchema,
});
export type NewsSignalLog = z.infer<typeof NewsSignalLogSchema>;
export const NewsSignalReportSchema = z.strictObject({
  schemaVersion: z.literal('news-signal-report.v1'),
  execution: z.literal('DISABLED'),
  mode: z.literal('POINT_IN_TIME_FIXTURE_REPLAY'),
  codeVersion: z.string().min(1).max(200),
  manifest: NewsSignalManifestSchema,
  manifestHash: HashSchema,
  providerHash: HashSchema,
  decisions: z.array(NewsSignalLogSchema).max(512),
  snapshotHashes: z.array(HashSchema).max(320),
  logHead: HashSchema,
  counts: z.strictObject({
    long: z.number().int().nonnegative(),
    short: z.number().int().nonnegative(),
    hold: z.number().int().nonnegative(),
  }),
  warnings: z.array(z.string()),
});
export type NewsSignalReport = z.infer<typeof NewsSignalReportSchema>;
export const NewsSignalBundleSchema = z.strictObject({
  schemaVersion: z.literal('news-signal-bundle.v1'),
  id: IdSchema,
  reportHash: HashSchema,
  files: z.record(
    z
      .string()
      .regex(
        /^(report\.json|report\.md|manifest\.json|decisions\.jsonl|snapshots\/[a-f0-9]{64}\.json)$/,
      ),
    HashSchema,
  ),
});
