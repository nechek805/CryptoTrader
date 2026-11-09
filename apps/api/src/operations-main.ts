import { randomUUID } from 'node:crypto';
import { buildOperationsApp } from './operations.js';
import { operationsFixture } from './operations-fixture.js';
import { canonicalHash } from '@crypto/core';
import { loadPaperStore, appendPaperEvent, enqueuePaperEvent } from '@crypto/paper';
import { verifyEvaluationBundle } from '@crypto/evaluation';
import type { PaperEvent } from '@crypto/contracts';
import { createBtcTestService } from './btc-test.js';
import { createMarketStrategyService } from './market-strategy-tests.js';
import { createSpecialistService } from './specialist-tests.js';
import { createSpecialistV5Service } from './specialist-v5.js';
import { createDirectionalService } from './directional-tests.js';
import { createShortV6Service } from './short-v6.js';
import { createLivePaperService } from './live-paper.js';
import { createRemoteLivePaperService } from './remote-live-paper.js';

async function main() {
  const fixture = (process.env.OPS_MODE ?? 'fixture') === 'fixture';
  const hostedPaper = process.env.OPS_MODE === 'hosted-paper',
    fixtureData = fixture || hostedPaper;
  if (!fixtureData && process.env.OPS_MODE !== 'deployment')
    throw new Error('Invalid operations mode');
  if (hostedPaper && (!process.env.OPS_PROXY_SECRET || process.env.OPS_PROXY_SECRET.length < 32))
    throw new Error('Hosted paper requires an authenticated reverse proxy');
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
  const data = fixtureData
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
  if (!data || (fixtureData && data.paper.config.origin !== 'SYNTHETIC'))
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
    directory && !fixtureData
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
      : fixtureData
        ? {
            ...(hostedPaper
              ? { trustedProxy: { tokenHash: canonicalHash(process.env.OPS_PROXY_SECRET!) } }
              : {}),
            ...(process.env.LIVE_PAPER_ENABLED === '1'
              ? {
                  livePaper:
                    process.env.LIVE_PAPER_SCHEDULER === 'bullmq'
                      ? await createRemoteLivePaperService(
                          process.env.LIVE_PAPER_DATABASE_URL ?? '',
                          process.env.WORKER_RPC_URL ?? '',
                          process.env.WORKER_RPC_TOKEN ?? '',
                        )
                      : await createLivePaperService(process.env.LIVE_PAPER_DATABASE_URL ?? ''),
                }
              : {}),
            demoAutoLogin: fixture,
            btcTest: await createBtcTestService('data/btc-market-test'),
            marketTests: await createMarketStrategyService('data/market-strategy-tests'),
            specialists: await createSpecialistService('data/sol-xrp-lab'),
            specialistsV5: await createSpecialistV5Service('data/sol-xrp-v5'),
            directionalTests: await createDirectionalService('data/directional-tests'),
            shortV6: await createShortV6Service('data/short-v6'),
          }
        : {},
  );
  app.get('/queue-status', async () =>
    process.env.LIVE_PAPER_SCHEDULER === 'bullmq'
      ? fetch((process.env.WORKER_RPC_URL ?? '') + '/queue-status', {
          headers: { 'x-crypto-worker-auth': process.env.WORKER_RPC_TOKEN ?? '' },
          signal: AbortSignal.timeout(5000),
        }).then(async (response) => {
          if (!response.ok) throw new Error('Queue unavailable');
          return response.json();
        })
      : { enabled: false, backend: 'LOCAL_TIMER' },
  );
  const stop = () => {
    void app.close();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const bindHost = process.env.OPS_BIND_HOST ?? '127.0.0.1';
  if (!['127.0.0.1', '0.0.0.0'].includes(bindHost) || (!hostedPaper && bindHost !== '127.0.0.1'))
    throw new Error('Invalid operations bind address');
  await app.listen({ host: bindHost, port: 3101 });
  process.stdout.write(
    `Research API ready at http://127.0.0.1:3101 — ${hostedPaper ? 'authenticated hosted paper trading' : fixture ? 'synthetic local workspace' : 'authenticated deployment gateway'}\n`,
  );
}
main().catch(() => {
  process.stderr.write(
    'Research API startup failed: dataset, authentication, freeze or local bind.\n',
  );
  process.exitCode = 1;
});
