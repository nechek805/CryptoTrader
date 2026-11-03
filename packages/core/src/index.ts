import { z } from 'zod';

export * from './time.js';
export * from './money.js';
export * from './canonical.js';
export * from './random.js';
export * from './availability.js';

export const RuntimeConfigSchema = z.strictObject({
  dataMode: z.literal('fixture-only').default('fixture-only'),
  host: z.enum(['127.0.0.1', '::1', 'localhost']).default('127.0.0.1'),
  port: z.coerce.number().int().min(1).max(65535).default(3000),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;

/** Select configuration explicitly so unrelated environment secrets never enter reports. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  return RuntimeConfigSchema.parse({
    dataMode: env.DATA_MODE,
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
  });
}
