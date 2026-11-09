import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createBtcTestService } from '../apps/api/src/btc-test.js';
import { buildOperationsApp } from '@crypto/api';
import { canonicalHash } from '@crypto/core';
import { paperFixture, replayPaper } from '@crypto/paper';
async function cleanTest(root: string) {
  const target = resolve(root);
  if (
    dirname(target) !== resolve(tmpdir()) ||
    !target.split(/[\\/]/).at(-1)!.startsWith('btc-api-')
  )
    throw new Error('Unsafe test cleanup');
  await rm(target, { recursive: true, force: true });
}

it('authenticates BTC research routes, enforces Origin and rejects arbitrary download/run inputs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'btc-api-')),
    f = paperFixture();
  const service = await createBtcTestService(root),
    reader = 'fixture-read-0000000000000000000000';
  const security = {
    schemaVersion: 'ops-security.v1',
    mode: 'LOCAL',
    readerTokenHash: canonicalHash(reader),
    adminTokenHash: canonicalHash('fixture-admin-000000000000000000000'),
    allowedOrigins: ['http://127.0.0.1:3100'],
  };
  const data = {
    schemaVersion: 'ops-dataset.v1',
    paper: replayPaper(f.config, f.events),
    evaluation: null,
    newsSnapshots: [],
  };
  const app = buildOperationsApp(data, security, { demoAutoLogin: true, btcTest: service });
  try {
    expect((await app.inject('/btc-test')).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/btc-test/select',
          payload: { strategy: 'THIRD' },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ method: 'POST', url: '/btc-test/compare', payload: {} })).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/btc-test/select',
          payload: { strategy: 'REVISED' },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ method: 'POST', url: '/btc-test/download', payload: {} })).statusCode,
    ).toBe(401);
    const login = await app.inject({
        method: 'POST',
        url: '/session',
        payload: { token: reader },
        headers: { origin: security.allowedOrigins[0] },
      }),
      cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const headers = { cookie, origin: security.allowedOrigins[0] };
    expect((await app.inject({ url: '/btc-test', headers })).json()).toEqual({
      datasetId: null,
      reportId: null,
      job: null,
      comparisonId: null,
    });
    expect((await app.inject({ url: '/btc-test/data', headers })).statusCode).toBe(404);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/btc-test/select',
          headers,
          payload: { strategy: 'THIRD' },
        })
      ).statusCode,
    ).toBe(400);
    expect((await app.inject({ url: '/btc-test/comparison', headers })).statusCode).toBe(404);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/btc-test/compare',
          headers,
          payload: { datasetId: '../../file', url: 'http://127.0.0.1/private' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/btc-test/select',
          headers,
          payload: { strategy: 'arbitrary' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/btc-test/select',
          headers,
          payload: { strategy: 'REVISED' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/btc-test/download',
          headers: { cookie },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/btc-test/download',
          headers: { ...headers, origin: 'https://evil.invalid' },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    const bad = await app.inject({
      method: 'POST',
      url: '/btc-test/download',
      headers,
      payload: { url: 'http://127.0.0.1/private' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).not.toContain('private');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/btc-test/run',
          headers,
          payload: { datasetId: '../../secret' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/btc-test/run',
          headers,
          payload: { datasetId: `sha256:${'a'.repeat(64)}` },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: 'POST', url: '/btc-test/verify', headers, payload: {} }))
        .statusCode,
    ).toBe(400);
    expect(service.state().job).toBeNull();
    expect(() =>
      buildOperationsApp(
        data,
        { ...security, mode: 'DEPLOYMENT', allowedOrigins: ['https://example.invalid'] },
        { btcTest: service },
      ),
    ).toThrow('local research only');
  } finally {
    await app.close();
    await cleanTest(root);
  }
});
