import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { LivePaperStore } from '@crypto/db';
import { LiveOverviewSchema, LiveRunSchema } from '@crypto/contracts';
import { liveEngineHash } from './live-paper.js';
import type { LivePaperService } from './live-paper.js';
export async function createRemoteLivePaperService(
  databaseUrl: string,
  workerUrl: string,
  token: string,
): Promise<LivePaperService & { queueStatus: () => Promise<unknown> }> {
  if (!['http://worker:3102', 'http://127.0.0.1:3102'].includes(workerUrl) || token.length < 32)
    throw new Error('Invalid private worker endpoint');
  const store = new LivePaperStore(databaseUrl),
    engineHash = await liveEngineHash();
  async function rpc(path: string, body?: unknown) {
    const r = await fetch(workerUrl + path, {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(50000),
      headers: {
        'x-crypto-worker-auth': token,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!r.ok) throw new Error('Private worker request unavailable');
    return r.json();
  }
  return {
    store,
    engineHash,
    startWorker() {
      /* BullMQ worker runs in its own container. */
    },
    async overview(id?: string) {
      return LiveOverviewSchema.parse(
        await rpc('/overview' + (id ? '?runId=' + z.string().uuid().parse(id) : '')),
      );
    },
    async startRun() {
      return LiveRunSchema.parse(await rpc('/command', { id: randomUUID(), action: 'START' }));
    },
    async control(action) {
      return LiveRunSchema.parse(await rpc('/command', { id: randomUUID(), action }));
    },
    async positions(query, exporting = false) {
      return store.positions(query, exporting);
    },
    async tickOnce() {
      await rpc('/refresh', {});
    },
    queueStatus: () => rpc('/queue-status'),
    async close() {
      await store.close();
    },
  };
}
