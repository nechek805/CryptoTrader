import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { LivePaperStore } from '@crypto/db';
import { LiveOverviewSchema } from '@crypto/contracts';
import { createLiveRun, stepLiveRun, liveSummaries, verifyLiveRecording } from '@crypto/paper';
import type { LivePaperService } from '../apps/api/src/live-paper.js';
import { createPaperQueueWorker } from '../apps/api/src/live-paper-queue.js';
import { liveTestRun, testProfiles } from './helpers/live-paper.js';
describe.skipIf(!process.env.TEST_REDIS_URL)(
  'BullMQ paper worker with real Redis/PostgreSQL',
  () => {
    let service: Awaited<ReturnType<typeof createPaperQueueWorker>> | null = null,
      store: LivePaperStore,
      queueName: string;
    const token = 'synthetic-worker-authentication-00000000000000',
      headers = { 'x-crypto-worker-auth': token };
    let tickDelayMs = 0,
      ticks = 0,
      fatals = 0;
    async function factory(): Promise<LivePaperService> {
      store = new LivePaperStore(process.env.TEST_DATABASE_URL!, store.schema);
      await store.migrate();
      if (!(await store.acquireWorker())) throw new Error('Fixture worker already owns lease');
      return {
        store,
        engineHash: 'fixture-engine',
        startWorker() {
          throw new Error('Legacy timer must never start');
        },
        async overview() {
          const run = await store.read();
          return LiveOverviewSchema.parse({
            version: 'live-paper.v1',
            execution: 'SIMULATED',
            asOf: Date.now(),
            worker: 'RUNNING',
            error: null,
            run,
            runs: await store.listRuns(),
            feeds: [],
            summaries: run ? liveSummaries(run, Date.now(), []) : [],
          });
        },
        async startRun() {
          return store.change((current) => {
            if (current && current.status !== 'ENDED') throw new Error('Run active');
            const now = Date.now(),
              state = createLiveRun(
                now,
                testProfiles,
                'fixture-engine',
                'fixture-profile',
                liveTestRun(now).markets,
              );
            return {
              state,
              positions: [],
              sources: [],
              event: { kind: 'START', state, origin: 'SYNTHETIC' },
            };
          });
        },
        async control(action) {
          return store.change((current) => {
            if (!current || current.status === 'ENDED') throw new Error('Run unavailable');
            const state = {
              ...current,
              heartbeatAt: Date.now(),
              status:
                action === 'PAUSE'
                  ? ('PAUSED' as const)
                  : action === 'RESUME'
                    ? ('RUNNING' as const)
                    : ('STOPPING' as const),
              pending: {},
            };
            return {
              state,
              positions: [],
              sources: [],
              event: { kind: 'CONTROL', action, requestedAt: state.heartbeatAt },
            };
          });
        },
        async positions(q, exporting = false) {
          return store.positions(q, exporting);
        },
        async tickOnce() {
          ticks++;
          if (tickDelayMs) await new Promise((r) => setTimeout(r, tickDelayMs));
          await store.change(
            (current) => (current ? stepLiveRun(current, [], Date.now()) : null),
            true,
          );
        },
        async close() {
          await store.close();
        },
      };
    }
    async function start() {
      service = await createPaperQueueWorker({
        databaseUrl: process.env.TEST_DATABASE_URL!,
        redisUrl: process.env.TEST_REDIS_URL!,
        rpcToken: token,
        schema: store.schema,
        queueName,
        listenHost: '127.0.0.1',
        port: 0,
        runtimeFactory: factory,
        intervalMs: 500,
        onFatal: () => {
          fatals++;
        },
      });
      return service;
    }
    beforeEach(async () => {
      if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL required');
      store = new LivePaperStore(
        process.env.TEST_DATABASE_URL,
        'crypto_live_test_' + randomUUID().replaceAll('-', ''),
      );
      queueName = 'fixture-paper-' + randomUUID();
      ticks = 0;
      tickDelayMs = 0;
      fatals = 0;
      await start();
    }, 60000);
    afterEach(async () => {
      if (service) {
        await service.queue.removeJobScheduler('public-quotes-5s');
        await service.worker.pause();
        await service.queue.obliterate({ force: true });
        await service.close();
        service = null;
      }
      const cleanup = new LivePaperStore(process.env.TEST_DATABASE_URL!, store.schema);
      await cleanup.pool.query(
        `DROP SCHEMA ${store.schema}_queue CASCADE; DROP SCHEMA ${store.schema} CASCADE`,
      );
      await cleanup.close();
    }, 60000);
    it('executes scheduled ticks without starting the legacy timer and protects private RPC', async () => {
      await new Promise((r) => setTimeout(r, 1500));
      expect(ticks).toBeGreaterThan(0);
      expect((await service!.app.inject('/overview')).statusCode).toBe(401);
      expect((await service!.app.inject({ url: '/overview', headers })).statusCode).toBe(200);
      const status = await service!.status();
      expect(status.connected).toBe(true);
      expect(status.healthy).toBe(true);
      const schedulers = await service!.queue.getJobSchedulers();
      expect(schedulers).toHaveLength(1);
    }, 60000);
    it('retries a committed START exactly once even after Redis job removal', async () => {
      const id = randomUUID(),
        request = {
          method: 'POST' as const,
          url: '/command',
          headers,
          payload: { id, action: 'START' },
        };
      const first = await service!.app.inject(request);
      expect(first.statusCode).toBe(200);
      const initial = first.json<{ id: string; deadlineAt: number }>();
      const again = await service!.app.inject(request);
      expect(again.statusCode).toBe(200);
      expect(again.json()).toEqual(first.json());
      await (await service!.queue.getJob(id))!.remove();
      const afterRemoval = await service!.app.inject(request);
      expect(afterRemoval.statusCode).toBe(200);
      expect(afterRemoval.json()).toEqual(first.json());
      expect(await store.listRuns()).toHaveLength(1);
      expect((await store.read())!.deadlineAt).toBe(initial.deadlineAt);
      expect((await verifyLiveRecording(store)).verified).toBe(true);
    }, 60000);
    it('serializes controls, rejects reused IDs for different actions and retains failed jobs', async () => {
      expect(
        (
          await service!.app.inject({
            method: 'POST',
            url: '/command',
            headers,
            payload: { id: randomUUID(), action: 'START' },
          })
        ).statusCode,
      ).toBe(200);
      const id = randomUUID();
      expect(
        (
          await service!.app.inject({
            method: 'POST',
            url: '/command',
            headers,
            payload: { id, action: 'PAUSE' },
          })
        ).statusCode,
      ).toBe(200);
      expect((await store.read())!.status).toBe('PAUSED');
      expect(
        (
          await service!.app.inject({
            method: 'POST',
            url: '/command',
            headers,
            payload: { id, action: 'STOP' },
          })
        ).statusCode,
      ).toBe(409);
      const run = await store.read();
      const bad = await service!.queue.add('command', {
        id: randomUUID(),
        action: 'STOP',
        expectedRunId: randomUUID(),
        requestedAt: Date.now(),
      });
      await expect(bad.waitUntilFinished(service!.events, 15000)).rejects.toThrow('different run');
      expect((await store.read())!.id).toBe(run!.id);
      expect(await service!.queue.getFailedCount()).toBeGreaterThan(0);
    }, 60000);
    it('processes controls ahead of an overloaded periodic tick schedule', async () => {
      tickDelayMs = 800;
      await new Promise((r) => setTimeout(r, 1800));
      const job = await service!.queue.add(
        'command',
        {
          id: randomUUID(),
          action: 'START',
          expectedRunId: null,
          requestedAt: Date.now(),
        },
        { priority: 1 },
      );
      await job.waitUntilFinished(service!.events, 8000);
      expect((await store.read())?.status).toBe('RUNNING');
    }, 60000);
    it('marks lost database leases unhealthy and requests a process restart', async () => {
      await new Promise((r) => setTimeout(r, 800));
      store.pool.emit('error', new Error('Synthetic connection failure'));
      await new Promise((r) => setTimeout(r, 1200));
      expect(fatals).toBeGreaterThan(0);
      expect((await service!.app.inject({ url: '/health', headers })).statusCode).toBe(503);
    }, 60000);
    it('resumes the same run and deadline after worker restart with no duplicated account', async () => {
      const res = await service!.app.inject({
        method: 'POST',
        url: '/command',
        headers,
        payload: { id: randomUUID(), action: 'START' },
      });
      expect(res.statusCode).toBe(200);
      const before = await store.read();
      await service!.close();
      service = null;
      await start();
      await new Promise((r) => setTimeout(r, 1200));
      const after = await store.read();
      expect(after!.id).toBe(before!.id);
      expect(after!.deadlineAt).toBe(before!.deadlineAt);
      expect(after!.accounts).toEqual(before!.accounts);
      expect(await store.listRuns()).toHaveLength(1);
    }, 60000);
  },
);
