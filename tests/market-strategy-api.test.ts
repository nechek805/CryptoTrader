import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createMarketStrategyService } from '../apps/api/src/market-strategy-tests.js';
import { buildOperationsApp } from '@crypto/api';
import { canonicalHash } from '@crypto/core';
import { paperFixture, replayPaper } from '@crypto/paper';
async function cleanup(root: string) {
  if (
    dirname(resolve(root)) !== resolve(tmpdir()) ||
    !root.split(/[\\/]/).at(-1)!.startsWith('market-api-')
  )
    throw new Error('Unsafe cleanup');
  await rm(root, { recursive: true, force: true });
}

it('authenticates the market matrix, checks cookie Origin, rejects arbitrary inputs, and bounds jobs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'market-api-')),
    service = await createMarketStrategyService(root, join(root, 'missing-btc'));
  const f = paperFixture(),
    reader = 'fixture-read-0000000000000000000000',
    security = {
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
  const app = buildOperationsApp(data, security, { marketTests: service, demoAutoLogin: true });
  try {
    for (const url of [
      '/market-strategies',
      '/market-strategies/matrix',
      '/market-strategies/catalog',
      '/market-strategies/export',
      '/market-strategies/report?asset=BTC&strategy=V1',
    ])
      expect((await app.inject(url)).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'POST', url: '/market-strategies/run', payload: {} })).statusCode,
    ).toBe(401);
    const login = await app.inject({
        method: 'POST',
        url: '/session',
        payload: { token: reader },
        headers: { origin: security.allowedOrigins[0] },
      }),
      cookie = String(login.headers['set-cookie']).split(';')[0]!,
      headers = { cookie, origin: security.allowedOrigins[0] };
    expect((await app.inject({ url: '/market-strategies/catalog', headers })).json()).toHaveLength(
      3,
    );
    expect((await app.inject({ url: '/market-strategies', headers })).json()).toEqual({
      matrixId: null,
      job: null,
      fees: { V1: true, V2: true, V3: true },
    });
    expect((await app.inject({ url: '/market-strategies/matrix', headers })).statusCode).toBe(404);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/market-strategies/fees',
          headers: { cookie },
          payload: { fees: { V1: false, V2: false, V3: false } },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/market-strategies/fees',
          headers: { cookie, origin: 'https://evil.test' },
          payload: { fees: { V1: false, V2: false, V3: false } },
        })
      ).statusCode,
    ).toBe(403);
    for (const payload of [
      { fees: { V1: 'false', V2: true, V3: true } },
      { fees: { V1: false, V2: true } },
      { fees: { V1: true, V2: true, V3: true, V4: false } },
      { fees: { V1: false, V2: false, V3: false }, url: 'https://evil.test' },
    ])
      expect(
        (await app.inject({ method: 'POST', url: '/market-strategies/fees', headers, payload }))
          .statusCode,
      ).toBe(400);
    const changed = await app.inject({
      method: 'POST',
      url: '/market-strategies/fees',
      headers,
      payload: { fees: { V1: false, V2: true, V3: false } },
    });
    expect(changed.statusCode).toBe(200);
    expect(service.state().fees).toEqual({ V1: false, V2: true, V3: false });
    const restored = await createMarketStrategyService(root, join(root, 'missing-btc'));
    expect(restored.state().fees).toEqual({ V1: false, V2: true, V3: false });
    await service.setFees({ V1: true, V2: true, V3: true });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/market-strategies/run',
          payload: {},
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/market-strategies/run',
          payload: {},
          headers: { cookie, origin: 'https://evil.test' },
        })
      ).statusCode,
    ).toBe(403);
    for (const payload of [
      { url: 'https://evil.test' },
      { asset: 'BTC', strategy: 'V1' },
      { initialUsdt: '1000000' },
      { token: 'live' },
    ])
      expect(
        (await app.inject({ method: 'POST', url: '/market-strategies/run', payload, headers }))
          .statusCode,
      ).toBe(400);
    for (const query of [
      'asset=USDT&strategy=V1',
      'asset=../../BTC&strategy=V1',
      'asset=BTC&strategy=V99',
      'asset=ETH&strategy=V2&url=https://evil.test',
    ])
      expect(
        (await app.inject({ url: '/market-strategies/report?' + query, headers })).statusCode,
      ).toBe(400);
    const first = service.start(),
      second = service.start();
    expect(second.id).toBe(first.id);
    expect(first.status).toBe('RUNNING');
    await expect(service.setFees({ V1: false, V2: false, V3: false })).rejects.toThrow('Wait');
    for (let i = 0; i < 100 && service.state().job?.status === 'RUNNING'; i++)
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(service.state().job?.status).toBe('FAILED');
    expect(service.matrix()).toBeNull();
    expect(() =>
      buildOperationsApp(
        data,
        { ...security, mode: 'DEPLOYMENT', allowedOrigins: ['https://research.example'] },
        { marketTests: service },
      ),
    ).toThrow('local research only');
  } finally {
    await app.close();
    await cleanup(root);
  }
});
