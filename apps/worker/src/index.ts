import { readFile } from 'node:fs/promises';
import { BootstrapFixtureSchema, FixtureReportSchema } from '@crypto/contracts';
import type { FixtureReport } from '@crypto/contracts';

export const defaultFixtureUrl = new URL('../../../tests/fixtures/bootstrap.json', import.meta.url);

/** A finite, read-only bootstrap task. No collectors, queues, signals or orders yet. */
export async function runFixtureWorker(
  fixtureUrl: URL = defaultFixtureUrl,
): Promise<FixtureReport> {
  const input: unknown = JSON.parse(await readFile(fixtureUrl, 'utf8'));
  const fixture = BootstrapFixtureSchema.parse(input);
  return FixtureReportSchema.parse({
    schemaVersion: 'bootstrap.v1',
    mode: fixture.mode,
    status: 'ok',
    fixtureAsOf: fixture.fixtureAsOf,
    instruments: fixture.instruments,
    instrumentCount: fixture.instruments.length,
    ordersCreated: 0,
  });
}
