import { it, expect, vi } from 'vitest';
import { canonicalHash } from '@crypto/core';
import { paperFixture, replayPaper } from '@crypto/paper';
import { LivePaperStore } from '@crypto/db';
import { LiveOverviewSchema } from '@crypto/contracts';
import type { LiveQuery } from '@crypto/contracts';
import { buildOperationsApp } from '@crypto/api';
import type { LivePaperService } from '../apps/api/src/live-paper.js';
import { liveTestRun, LIVE_TEST_TIME as T } from './helpers/live-paper.js';
it('keeps live-paper routes local, authenticated, bounded and protected by origin checks', async () => {
  const { run } = liveTestRun(),
    store = new LivePaperStore('postgresql://research@127.0.0.1:1/postgres');
  const startRun = vi.fn(() => Promise.resolve(run));
  const service: LivePaperService = {
    store,
    engineHash: 'test-engine',
    startWorker: vi.fn(),
    overview: () =>
      Promise.resolve(
        LiveOverviewSchema.parse({
          version: 'live-paper.v1',
          execution: 'SIMULATED',
          asOf: T,
          worker: 'RUNNING',
          error: null,
          run,
          runs: [],
          feeds: [],
          summaries: [],
        }),
      ),
    startRun,
    control: vi.fn(() => Promise.resolve(run)),
    positions: vi.fn((q: LiveQuery) =>
      Promise.resolve({
        asOf: T,
        total: 0,
        page: q.page,
        pageSize: q.pageSize,
        positions: [],
      }),
    ),
    close: async () => store.close(),
    tickOnce: vi.fn(() => Promise.resolve()),
  };
  const f = paperFixture(),
    data = {
      schemaVersion: 'ops-dataset.v1',
      paper: replayPaper(f.config, f.events),
      evaluation: null,
      newsSnapshots: [],
    },
    reader = 'fixture-read-0000000000000000000000',
    security = {
      schemaVersion: 'ops-security.v1',
      mode: 'LOCAL',
      readerTokenHash: canonicalHash(reader),
      adminTokenHash: canonicalHash('fixture-admin-000000000000000000000'),
      allowedOrigins: ['http://127.0.0.1:3100'],
    };
  const app = buildOperationsApp(data, security, { livePaper: service, demoAutoLogin: true });
  try {
    expect((await app.inject('/live-paper')).statusCode).toBe(401);
    const login = await app.inject({
        method: 'POST',
        url: '/session',
        payload: { token: reader },
        headers: { origin: 'http://127.0.0.1:3100' },
      }),
      cookie = String(login.headers['set-cookie']).split(';')[0]!,
      headers = { cookie, origin: 'http://127.0.0.1:3100' };
    expect((await app.inject({ url: '/live-paper', headers })).statusCode).toBe(200);
    expect(
      (
        await app.inject({
          url: '/live-paper/start',
          method: 'POST',
          headers: { cookie },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          url: '/live-paper/start',
          method: 'POST',
          headers: { ...headers, origin: 'https://evil.test' },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    for (const payload of [
      { durationHours: 999 },
      { url: 'https://evil.test' },
      { initialPerExchange: '1000000' },
    ])
      expect(
        (await app.inject({ url: '/live-paper/start', method: 'POST', headers, payload }))
          .statusCode,
      ).toBe(400);
    expect(
      (await app.inject({ url: '/live-paper/start', method: 'POST', headers, payload: {} }))
        .statusCode,
    ).toBe(200);
    expect(startRun).toHaveBeenCalledTimes(1);
    expect(
      (
        await app.inject({
          url: '/live-paper/control',
          method: 'POST',
          headers,
          payload: { action: 'PAUSE' },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          url: '/live-paper/control',
          method: 'POST',
          headers,
          payload: { action: 'REAL_BUY' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ url: '/live-paper/positions?sort=id%3BDROP', headers })).statusCode,
    ).toBe(400);
    for (const format of ['json', 'csv', 'tsv', 'md']) {
      const res = await app.inject({
        url: `/live-paper/export/${format}?exchange=BYBIT&side=SHORT&sort=netPnl`,
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-export-rows']).toBe('0');
    }
    expect(() =>
      buildOperationsApp(
        data,
        { ...security, mode: 'DEPLOYMENT', allowedOrigins: ['https://safe.test'] },
        { livePaper: service },
      ),
    ).toThrow('local workspace');
  } finally {
    await app.close();
  }
});
