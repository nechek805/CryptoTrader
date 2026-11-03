import { z } from 'zod';
import { MarketBarSchema, NewsDocumentSchema, SignalCandidateSchema } from './domain.js';
import { EventStudySeriesSchema } from './event-study.js';
import {
  HashSchema,
  IdSchema,
  SeedSchema,
  SymbolSchema,
  UtcTimestampSchema,
  PortfolioSchema,
} from './primitives.js';

export const ReplayStateSchema = z
  .record(z.string().max(100), z.json())
  .refine((v) => JSON.stringify(v).length <= 16384, 'Replay state limit');
export type ReplayState = z.infer<typeof ReplayStateSchema>;
export const ReplayInputSchema = z.strictObject({
  schemaVersion: z.literal('replay-input.v1'),
  bars: z.array(MarketBarSchema).max(5000),
  news: z.array(NewsDocumentSchema).max(1000),
});
export type ReplayInput = z.infer<typeof ReplayInputSchema>;
export const ReplayRequestSchema = z
  .strictObject({
    schemaVersion: z.literal('replay-request.v1'),
    startAt: UtcTimestampSchema,
    endAt: UtcTimestampSchema,
    generatedAt: UtcTimestampSchema,
    symbols: z.array(SymbolSchema).min(1).max(20),
    randomSeed: SeedSchema,
    snapshotEvery: z.number().int().min(1).max(1000),
    maxQueriesPerEvent: z.number().int().min(1).max(100),
  })
  .superRefine((v, c) => {
    if (v.startAt >= v.endAt || v.generatedAt < v.endAt)
      c.addIssue({ code: 'custom', message: 'Invalid replay period/generation' });
    if (new Set(v.symbols).size !== v.symbols.length)
      c.addIssue({ code: 'custom', message: 'Duplicate replay symbols' });
  });
export type ReplayRequest = z.infer<typeof ReplayRequestSchema>;
export const ReplayStrategyDescriptorSchema = z.strictObject({
  id: IdSchema,
  version: z.string().min(1).max(100),
  portfolio: PortfolioSchema,
  config: ReplayStateSchema,
});
export type ReplayStrategyDescriptor = z.infer<typeof ReplayStrategyDescriptorSchema>;
export const ReplayIntentSchema = z.strictObject({
  symbol: SignalCandidateSchema.shape.symbol,
  side: SignalCandidateSchema.shape.side,
  horizon: SignalCandidateSchema.shape.horizon,
  score: SignalCandidateSchema.shape.score,
  calibration: SignalCandidateSchema.shape.calibration,
  rationaleIds: SignalCandidateSchema.shape.rationaleIds,
});
export type ReplayIntent = z.infer<typeof ReplayIntentSchema>;
export const ReplayStepSchema = z.strictObject({
  state: ReplayStateSchema,
  candidates: z.array(ReplayIntentSchema).max(20),
});
export const ReplayEventMetaSchema = z.strictObject({
  id: IdSchema,
  kind: z.enum(['MARKET_BAR', 'NEWS_DOCUMENT']),
  recordId: IdSchema,
  availableAt: UtcTimestampSchema,
  eventAt: UtcTimestampSchema,
  payloadHash: HashSchema,
});
export type ReplayEventMeta = z.infer<typeof ReplayEventMetaSchema>;
export const ReplayEventSchema = z.discriminatedUnion('kind', [
  ReplayEventMetaSchema.extend({ kind: z.literal('MARKET_BAR'), record: MarketBarSchema }),
  ReplayEventMetaSchema.extend({ kind: z.literal('NEWS_DOCUMENT'), record: NewsDocumentSchema }),
]);
export type ReplayEvent = z.infer<typeof ReplayEventSchema>;
export const ReplayPointQuerySchema = z.strictObject({ id: IdSchema, asOf: UtcTimestampSchema });
export const ReplayBarsQuerySchema = z
  .strictObject({
    series: EventStudySeriesSchema,
    intervalSeconds: z.number().int().min(1).max(86400),
    fromCloseAt: UtcTimestampSchema,
    toCloseAt: UtcTimestampSchema,
    asOf: UtcTimestampSchema,
  })
  .refine((v) => v.fromCloseAt <= v.toCloseAt, 'Invalid bar query period');
export const ReplayNewsQuerySchema = z.strictObject({
  asOf: UtcTimestampSchema,
  sourceId: IdSchema.optional(),
});
export const ReplayQueryTraceSchema = z.strictObject({
  kind: z.enum(['BAR', 'BARS', 'NEWS', 'NEWS_BY_ID', 'FEATURES']),
  requestHash: HashSchema,
  recordIds: z.array(IdSchema).max(6000),
  maxInputAvailableAt: UtcTimestampSchema.nullable(),
  maxInputEventAt: UtcTimestampSchema.nullable(),
});
export type ReplayQueryTrace = z.infer<typeof ReplayQueryTraceSchema>;
export const ReplayLogSchema = z.strictObject({
  sequence: z.number().int().positive(),
  phase: z.enum(['WARMUP', 'DECISION']),
  event: ReplayEventMetaSchema,
  queries: z.array(ReplayQueryTraceSchema).max(100),
  candidateIds: z.array(IdSchema).max(20),
  stateHash: HashSchema,
  randomDraws: z.number().int().nonnegative(),
  previousHash: HashSchema,
  hash: HashSchema,
});
export const ReplaySnapshotSchema = z.strictObject({
  sequence: z.number().int().nonnegative(),
  clock: UtcTimestampSchema,
  state: ReplayStateSchema,
  stateHash: HashSchema,
  visibleBarIds: z.array(IdSchema).max(5000),
  visibleNewsIds: z.array(IdSchema).max(1000),
  candidatesHash: HashSchema,
  randomDraws: z.number().int().nonnegative(),
  logHead: HashSchema,
});
export const ReplayManifestSchema = z.strictObject({
  schemaVersion: z.literal('replay-manifest.v1'),
  runId: IdSchema,
  execution: z.literal('DISABLED'),
  kernelVersion: z.literal('replay-kernel.v1'),
  clockSemantics: z.literal('utc-nanoseconds.v1'),
  ordering: z.literal('AVAILABLE_AT_KIND_RECORD_ID_V1_PREFIX_VISIBILITY'),
  inputHash: HashSchema,
  configHash: HashSchema,
  strategyHash: HashSchema,
  codeVersion: z.string().min(1).max(200),
  randomSeed: SeedSchema,
  randomAlgorithm: z.literal('mulberry32.v1'),
  feeAssumptionsHash: HashSchema,
  executionAssumptions: z.literal('NO_EXECUTION_NO_COST_MODEL'),
  generatedAt: UtcTimestampSchema,
  eventOrderHash: HashSchema,
  logHash: HashSchema,
  candidatesHash: HashSchema,
  finalStateHash: HashSchema,
  snapshotsHash: HashSchema,
  eventCount: z.number().int().min(0).max(6000),
  decisionCount: z.number().int().nonnegative(),
  candidateCount: z.number().int().nonnegative(),
  exclusions: z
    .array(
      z.strictObject({
        kind: z.enum(['MARKET_BAR', 'NEWS_DOCUMENT']),
        recordId: IdSchema,
        reason: z.enum([
          'DESCRIPTIVE_ONLY',
          'UNKNOWN_AVAILABILITY',
          'OUTSIDE_PERIOD',
          'OUTSIDE_COHORT',
        ]),
      }),
    )
    .max(6000),
});
export const ReplayArtifactSchema = z.strictObject({
  schemaVersion: z.literal('replay-artifact.v1'),
  input: ReplayInputSchema,
  request: ReplayRequestSchema,
  strategy: ReplayStrategyDescriptorSchema,
  manifest: ReplayManifestSchema,
  log: z.array(ReplayLogSchema).max(6000),
  snapshots: z.array(ReplaySnapshotSchema).max(6002),
  candidates: z.array(SignalCandidateSchema).max(120000),
  finalState: ReplayStateSchema,
});
export type ReplayArtifact = z.infer<typeof ReplayArtifactSchema>;
