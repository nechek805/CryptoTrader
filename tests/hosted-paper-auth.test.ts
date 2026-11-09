import { it, expect } from 'vitest';
import { canonicalHash } from '@crypto/core';
import { paperFixture, replayPaper } from '@crypto/paper';
import { buildOperationsApp } from '@crypto/api';
it('authenticates a deployment proxy without exposing browser tokens and keeps role/origin checks', async () => {
  const f = paperFixture(),
    data = {
      schemaVersion: 'ops-dataset.v1',
      paper: replayPaper(f.config, f.events),
      evaluation: null,
      newsSnapshots: [],
    };
  const reader = 'hosted-reader-test-00000000000000000000',
    admin = 'hosted-admin-test-000000000000000000000',
    proxy = 'hosted-proxy-test-000000000000000000000';
  const security = {
    schemaVersion: 'ops-security.v1',
    mode: 'DEPLOYMENT',
    readerTokenHash: canonicalHash(reader),
    adminTokenHash: canonicalHash(admin),
    allowedOrigins: ['https://crypto-trader.nechek805.org'],
  };
  const app = buildOperationsApp(data, security, {
    trustedProxy: { tokenHash: canonicalHash(proxy) },
  });
  try {
    expect((await app.inject('/session')).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          url: '/session',
          headers: { 'x-crypto-proxy-auth': 'wrong-proxy-token-000000000000000000000' },
        })
      ).statusCode,
    ).toBe(401);
    const trusted = { 'x-crypto-proxy-auth': proxy, origin: security.allowedOrigins[0] };
    const session = await app.inject({ url: '/session', headers: trusted });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toEqual({ role: 'ADMIN' });
    expect(JSON.stringify(session.headers)).not.toContain(proxy);
    expect(
      (await app.inject({ url: '/overview', headers: { ...trusted, origin: 'https://evil.test' } }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          url: '/logout',
          method: 'POST',
          headers: { 'x-crypto-proxy-auth': proxy },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          url: '/logout',
          method: 'POST',
          headers: { authorization: 'Bearer ' + reader, origin: security.allowedOrigins[0] },
        })
      ).statusCode,
    ).toBe(403);
    const login = await app.inject({
      url: '/session',
      method: 'POST',
      payload: { token: reader },
      headers: { origin: security.allowedOrigins[0] },
    });
    expect(login.headers['set-cookie']).toContain('Secure');
    expect((await app.inject('/ready')).json()).toMatchObject({ demoAutoLogin: false });
    expect(() =>
      buildOperationsApp(
        data,
        { ...security, mode: 'LOCAL', allowedOrigins: ['http://127.0.0.1:3100'] },
        { trustedProxy: { tokenHash: canonicalHash(proxy) } },
      ),
    ).toThrow('proxy boundary');
    expect(() =>
      buildOperationsApp(data, security, { trustedProxy: { tokenHash: canonicalHash(reader) } }),
    ).toThrow('proxy boundary');
  } finally {
    await app.close();
  }
});
