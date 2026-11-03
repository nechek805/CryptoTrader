import { z } from 'zod';
import {
  HashSchema,
  NonNegativeDecimalSchema,
  PositiveDecimalSchema,
  UtcTimestampSchema,
} from './primitives.js';

export const StreamConfigSchema = z.strictObject({
  schemaVersion: z.literal('market-stream-config.v1'),
  provider: z.enum(['synthetic', 'binance-public']),
  symbol: z.enum(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']),
  staleAfterMs: z.number().int().min(100).max(10000).default(2000),
  clockTtlMs: z.number().int().min(1000).max(60000).default(30000),
  heartbeatAfterMs: z.number().int().min(1000).max(30000).default(5000),
});
export type StreamConfig = z.output<typeof StreamConfigSchema>;
export const StreamSequenceSchema = z.string().regex(/^(0|[1-9]\d{0,29})$/);
export const StreamLevelSchema = z.tuple([PositiveDecimalSchema, NonNegativeDecimalSchema]);
const levels = z.array(StreamLevelSchema).max(1000);
const common = { connection: z.number().int().nonnegative(), observedAt: UtcTimestampSchema };
export const StreamInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...common, kind: z.literal('CONNECTED') }),
  z.strictObject({ ...common, kind: z.literal('DISCONNECTED') }),
  z.strictObject({ ...common, kind: z.literal('TICK') }),
  z.strictObject({ ...common, kind: z.literal('STOPPED') }),
  z.strictObject({
    ...common,
    kind: z.literal('RETRY'),
    attempt: z.number().int().min(1).max(3),
    delayMs: z.number().int().min(250).max(4000),
  }),
  z.strictObject({
    ...common,
    kind: z.literal('FAULT'),
    reason: z.enum([
      'HEARTBEAT_TIMEOUT',
      'RATE_LIMIT',
      'ACCESS_DENIED',
      'NETWORK',
      'MALFORMED',
      'OVERFLOW',
      'EXHAUSTED',
    ]),
    retryAfterMs: z.number().int().nonnegative().max(86400000).nullable(),
  }),
  z.strictObject({
    ...common,
    kind: z.literal('CLOCK'),
    sentAt: UtcTimestampSchema,
    providerAt: UtcTimestampSchema,
    raw: z.string().max(262144),
  }),
  z.strictObject({
    ...common,
    kind: z.literal('SNAPSHOT'),
    sequence: StreamSequenceSchema,
    bids: levels,
    asks: levels,
    raw: z.string().max(262144),
  }),
  z
    .strictObject({
      ...common,
      kind: z.literal('DELTA'),
      first: StreamSequenceSchema,
      last: StreamSequenceSchema,
      occurredAt: UtcTimestampSchema,
      bids: levels,
      asks: levels,
      raw: z.string().max(262144),
    })
    .refine((v) => BigInt(v.first) <= BigInt(v.last)),
]);
export type StreamInput = z.infer<typeof StreamInputSchema>;
export const StreamStepSchema = z.strictObject({
  schemaVersion: z.literal('market-stream-step.v1'),
  input: StreamInputSchema,
  processedAt: UtcTimestampSchema,
});
export type StreamStep = z.infer<typeof StreamStepSchema>;
export const StreamViewSchema = z.strictObject({
  schemaVersion: z.literal('market-stream-view.v1'),
  provider: StreamConfigSchema.shape.provider,
  symbol: StreamConfigSchema.shape.symbol,
  origin: z.enum(['SYNTHETIC', 'PUBLIC_READ_ONLY']),
  sourceVersion: z.literal('depth-stream.v1/ms'),
  quality: z.enum(['ORDER_BOOK', 'CANDLE_ONLY']),
  depthLimited: z.literal(true),
  execution: z.literal('DISABLED'),
  connection: z.number().int().nonnegative(),
  status: z.enum([
    'SYNCING',
    'READY',
    'GAP',
    'STALE',
    'DISCONNECTED',
    'STOPPED',
    'CLOCK_UNRELIABLE',
    'INVALID_BOOK',
    'FAULT',
  ]),
  usable: z.boolean(),
  sequence: StreamSequenceSchema.nullable(),
  observedAt: UtcTimestampSchema.nullable(),
  occurredAt: UtcTimestampSchema.nullable(),
  availableAt: UtcTimestampSchema,
  validUntil: UtcTimestampSchema.nullable(),
  clockOffsetNs: z
    .string()
    .regex(/^-?\d+$/)
    .nullable(),
  clockUncertaintyNs: StreamSequenceSchema.nullable(),
  bids: levels,
  asks: levels,
});
export type StreamView = z.infer<typeof StreamViewSchema>;
export const StreamRecordSchema = z.strictObject({
  schemaVersion: z.literal('market-stream-record.v1'),
  index: z.number().int().nonnegative(),
  previousHash: HashSchema,
  step: StreamStepSchema,
  rawHash: HashSchema.nullable(),
  view: StreamViewSchema,
  hash: HashSchema,
});
export const StreamManifestSchema = z.strictObject({
  schemaVersion: z.literal('market-stream-recording.v1'),
  config: StreamConfigSchema,
  configHash: HashSchema,
  codeVersion: z.string().min(1).max(200),
  clockSemantics: z.literal('utc-nanoseconds.v1'),
  reducerVersion: z.literal('depth-reducer.v1'),
  source: z.strictObject({
    profile: z.enum(['synthetic-depth.v1', 'binance-spot-depth-ms.v1']),
    restBaseUrl: z.literal('https://data-api.binance.vision').nullable(),
    websocketBaseUrl: z.literal('wss://data-stream.binance.vision').nullable(),
    termsUrl: z.literal('https://www.binance.com/en/terms').nullable(),
    license: z.enum(['SYNTHETIC', 'UNDETERMINED']),
  }),
  recordsHash: HashSchema,
  finalHash: HashSchema,
  count: z.number().int().positive().max(5000),
});
