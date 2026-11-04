import { randomUUID } from 'node:crypto';
import { buildOperationsApp } from './operations.js';
import { operationsFixture } from './operations-fixture.js';
import { canonicalHash } from '@crypto/core';
import { loadPaperStore, appendPaperEvent, enqueuePaperEvent } from '@crypto/paper';
import { verifyEvaluationBundle } from '@crypto/evaluation';
import type { PaperEvent } from '@crypto/contracts';
import { createBtcTestService } from './btc-test.js';

async function main() {
  const fixture = (process.env.OPS_MODE ?? 'fixture') === 'fixture';
  if (!fixture && process.env.OPS_MODE !== 'deployment') throw new Error('Invalid operations mode');
  const reader = fixture ? 'fixture-read-0000000000000000000000' : process.env.OPS_READ_TOKEN,
    admin = fixture ? 'fixture-admin-000000000000000000000' : process.env.OPS_ADMIN_TOKEN;
  if (
    !reader ||
    !admin ||
    reader.length < 32 ||
    admin.length < 32 ||
    (!fixture && (reader.startsWith('fixture-') || admin.startsWith('fixture-')))
  )
    throw new Error('Operations credentials required');
  const directory = process.env.OPS_PAPER_STORE;
  const data = fixture
    ? await operationsFixture()
    : directory
      ? {
          schemaVersion: 'ops-dataset.v1',
          paper: (await loadPaperStore(directory)).report(),
          evaluation: process.env.OPS_EVALUATION_BUNDLE
            ? (await verifyEvaluationBundle(process.env.OPS_EVALUATION_BUNDLE)).report
            : null,
          newsSnapshots: [],
        }
      : null;
  if (!data || (fixture && data.paper.config.origin !== 'SYNTHETIC'))
    throw new Error('Operations dataset mode mismatch');
  const app = buildOperationsApp(
    data,
    {
      schemaVersion: 'ops-security.v1',
      mode: fixture ? 'LOCAL' : 'DEPLOYMENT',
      readerTokenHash: canonicalHash(reader),
      adminTokenHash: canonicalHash(admin),
      allowedOrigins: fixture
        ? ['http://127.0.0.1:3100', 'http://localhost:3100']
        : (process.env.OPS_ALLOWED_ORIGINS ?? '').split(',').filter(Boolean),
    },
    directory && !fixture
      ? {
          refresh: async () => (await loadPaperStore(directory)).report(),
          control: async (event: PaperEvent) => {
            const current = (await loadPaperStore(directory)).report(),
              request = { ...event, id: `operator:${randomUUID()}`, at: current.now };
            try {
              return await appendPaperEvent(directory, request);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
              await enqueuePaperEvent(directory, request);
              return current;
            }
          },
        }
      : fixture
        ? { demoAutoLogin: true, btcTest: await createBtcTestService('data/btc-market-test') }
        : {},
  );
  const stop = () => {
    void app.close();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await app.listen({ host: '127.0.0.1', port: 3101 });
  process.stdout.write(
    `Research API ready at http://127.0.0.1:3101 — ${fixture ? 'synthetic local workspace' : 'authenticated deployment gateway'}\n`,
  );
}
main().catch(() => {
  process.stderr.write(
    'Research API startup failed: dataset, authentication, freeze or local bind.\n',
  );
  process.exitCode = 1;
});
