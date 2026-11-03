import { buildApp } from '@crypto/api';
import { DoctorReportSchema, HealthResponseSchema } from '@crypto/contracts';
import type { DoctorReport, HealthResponse } from '@crypto/contracts';
import { loadConfig } from '@crypto/core';
import { runFixtureWorker } from '@crypto/worker';

export async function doctor(env: NodeJS.ProcessEnv = process.env): Promise<DoctorReport> {
  const config = loadConfig(env);
  const [major, minor, patch] = process.versions.node.split('.').map(Number);
  if (
    major !== 24 ||
    minor === undefined ||
    patch === undefined ||
    minor < 22 ||
    (minor === 22 && patch < 2)
  ) {
    throw new Error('Use the Node 24 LTS version pinned in .node-version');
  }
  return DoctorReportSchema.parse({
    schemaVersion: 'doctor.v1',
    status: 'ok',
    mode: config.dataMode,
    execution: 'disabled',
    runtime: { node: process.versions.node, supported: true },
    fixtures: await runFixtureWorker(),
    dependencies: { postgres: 'not-required', redis: 'not-required' },
  });
}

/** Fastify injection exercises routing without opening a port or making external requests. */
export async function smoke(env: NodeJS.ProcessEnv = process.env): Promise<HealthResponse> {
  const report = await doctor(env);
  const app = buildApp({ ...loadConfig(env), logLevel: 'silent' }, report.fixtures);
  try {
    const response = await app.inject({ method: 'GET', url: '/health' });
    if (response.statusCode !== 200) throw new Error('Health smoke failed');
    const body: unknown = response.json();
    return HealthResponseSchema.parse(body);
  } finally {
    await app.close();
  }
}

export async function runCli(args: readonly string[], env: NodeJS.ProcessEnv = process.env) {
  if (args.length === 1 && args[0] === 'doctor') return doctor(env);
  if (args.length === 2 && args[0] === 'smoke' && args[1] === '--dry-run') return smoke(env);
  throw new Error('Usage: doctor | smoke --dry-run');
}
