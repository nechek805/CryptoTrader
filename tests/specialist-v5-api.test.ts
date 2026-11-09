import { it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalHash } from '@crypto/core';
import { paperFixture, replayPaper } from '@crypto/paper';
import { buildOperationsApp } from '@crypto/api';
import { createSpecialistV5Service } from '../apps/api/src/specialist-v5.js';
async function cleanup(root: string) {
  if (
    dirname(resolve(root)) !== resolve(tmpdir()) ||
    !root.split(/[\\/]/).at(-1)!.startsWith('specialist-v5-api-')
  )
    throw new Error('Unsafe cleanup');
  await rm(root, { recursive: true, force: true });
}
it('protects SOL/XRP research, persists fee controls, rejects other coins and arbitrary configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'specialist-v5-api-')),
    service = await createSpecialistV5Service(root, join(root, 'missing-market'));
  const f = paperFixture(),
    reader = 'fixture-read-0000000000000000000000',
    security = {
      schemaVersion: 'ops-security.v1',
      mode: 'LOCAL',
      readerTokenHash: canonicalHash(reader),
      adminTokenHash: canonicalHash('fixture-admin-000000000000000000000'),
      allowedOrigins: ['http://127.0.0.1:3100'],
    },
    data = {
      schemaVersion: 'ops-dataset.v1',
      paper: replayPaper(f.config, f.events),
      evaluation: null,
      newsSnapshots: [],
    },
    app = buildOperationsApp(data, security, { specialistsV5: service });
  try {
    for (const url of [
      '/specialist-v5',
      '/specialist-v5/matrix',
      '/specialist-v5/report?asset=SOL&strategy=V5',
      '/specialist-v5/export',
    ])
      expect((await app.inject(url)).statusCode).toBe(401);
    const login = await app.inject({
        method: 'POST',
        url: '/session',
        payload: { token: reader },
        headers: { origin: security.allowedOrigins[0] },
      }),
      cookie = String(login.headers['set-cookie']).split(';')[0]!,
      headers = { cookie, origin: security.allowedOrigins[0] };
    expect((await app.inject({ url: '/specialist-v5', headers })).json()).toEqual({
      matrixId: null,
      job: null,
      fees: { V1: true, V2: true, V3: true, V4: true, V5: true },
    });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/specialist-v5/run',
          headers: { cookie },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    for (const payload of [
      { url: 'https://evil.test' },
      { asset: 'BTC' },
      { riskFraction: '1' },
      { candidate: { targetAtr: '100' } },
    ])
      expect(
        (await app.inject({ method: 'POST', url: '/specialist-v5/run', headers, payload }))
          .statusCode,
      ).toBe(400);
    for (const query of [
      'asset=BTC&strategy=V5',
      'asset=SOL&strategy=V6',
      'asset=../XRP&strategy=V5',
    ])
      expect(
        (await app.inject({ url: '/specialist-v5/report?' + query, headers })).statusCode,
      ).toBe(400);
    const fees = { V1: true, V2: false, V3: true, V4: false, V5: false };
    for (const invalid of [
      { V1: true, V2: true, V3: true, V4: true },
      { ...fees, V5: 'off' },
      { ...fees, V6: true },
    ])
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/specialist-v5/fees',
            headers,
            payload: { fees: invalid },
          })
        ).statusCode,
      ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/specialist-v5/fees',
          headers,
          payload: { fees },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await createSpecialistV5Service(root, join(root, 'missing-market'))).state().fees,
    ).toEqual(fees);
    const job = service.start();
    expect(service.start().id).toBe(job.id);
    await expect(service.setFees(fees)).rejects.toThrow('Wait');
    for (let i = 0; i < 100 && service.state().job?.status === 'RUNNING'; i++)
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(service.state().job?.status).toBe('FAILED');
    expect(service.matrix()).toBeNull();
    expect(() =>
      buildOperationsApp(
        data,
        { ...security, mode: 'DEPLOYMENT', allowedOrigins: ['https://research.example'] },
        { specialistsV5: service },
      ),
    ).toThrow('local only');
  } finally {
    await app.close();
    await cleanup(root);
  }
});
