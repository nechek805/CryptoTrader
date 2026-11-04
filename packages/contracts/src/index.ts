import { z } from 'zod';

export * from './primitives.js';
export * from './domain.js';
export * from './persistence.js';
export * from './market-import.js';

// Existing operational v1 interfaces remain compatible with the runnable skeleton.
export const BootstrapFixtureSchema = z.strictObject({
  schemaVersion: z.literal('bootstrap.v1'),
  mode: z.literal('fixture-only'),
  fixtureAsOf: z.iso.datetime(),
  description: z.string().min(1),
  instruments: z
    .array(z.string().regex(/^[A-Z0-9]+\/[A-Z0-9]+$/))
    .min(3)
    .refine((symbols) => new Set(symbols).size === symbols.length, 'Duplicate instrument'),
});

export const FixtureReportSchema = z.strictObject({
  schemaVersion: z.literal('bootstrap.v1'),
  mode: z.literal('fixture-only'),
  status: z.literal('ok'),
  fixtureAsOf: z.iso.datetime(),
  instruments: z.array(z.string()).min(3),
  instrumentCount: z.number().int().min(3),
  ordersCreated: z.literal(0),
});
export type FixtureReport = z.infer<typeof FixtureReportSchema>;

export const HealthResponseSchema = z.strictObject({
  schemaVersion: z.literal('health.v1'),
  status: z.literal('ok'),
  service: z.literal('crypto-research-api'),
  mode: z.literal('fixture-only'),
  execution: z.literal('disabled'),
  checkedAt: z.iso.datetime(),
  fixtures: FixtureReportSchema,
  dependencies: z.strictObject({
    postgres: z.literal('not-required'),
    redis: z.literal('not-required'),
  }),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const DoctorReportSchema = z.strictObject({
  schemaVersion: z.literal('doctor.v1'),
  status: z.literal('ok'),
  mode: z.literal('fixture-only'),
  execution: z.literal('disabled'),
  runtime: z.strictObject({ node: z.string(), supported: z.literal(true) }),
  fixtures: FixtureReportSchema,
  dependencies: z.strictObject({
    postgres: z.literal('not-required'),
    redis: z.literal('not-required'),
  }),
});
export type DoctorReport = z.infer<typeof DoctorReportSchema>;
export * from './market-stream.js';
export * from './market-data.js';
export * from './news-ingest.js';
export * from './news-poll.js';
export * from './news-review.js';
export * from './news-extraction.js';
export * from './news-graph.js';
export * from './news-events.js';
export * from './event-study.js';
export * from './event-controls.js';
export * from './hypotheses.js';
export * from './technical-features.js';
export * from './cross-features.js';
export * from './dataset-panel.js';
export * from './replay.js';
export * from './spot-simulation.js';
export * from './backtest.js';
export * from './market-strategies.js';
export * from './market-ml.js';
export * from './market-robustness.js';
export * from './news-signals.js';
export * from './news-edge.js';
export * from './news-audit.js';
export * from './fusion.js';
export * from './risk-engine.js';
export * from './decision-audit.js';
export * from './paper-broker.js';
export * from './evaluation.js';
export * from './operations.js';
export * from './experiment.js';
export * from './btc-test.js';
