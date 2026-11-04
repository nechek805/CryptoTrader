import { describe, expect, it } from 'vitest';
import { buildOperationsApp } from '@crypto/api';
import { canonicalHash } from '@crypto/core';
import { PaperBroker, paperFixture, replayPaper } from '@crypto/paper';
const reader = 'fixture-read-0000000000000000000000';
const security = {
  schemaVersion: 'ops-security.v1',
  mode: 'LOCAL',
  readerTokenHash: canonicalHash(reader),
  adminTokenHash: canonicalHash('fixture-admin-000000000000000000000'),
  allowedOrigins: ['http://127.0.0.1:3100'],
};
function data() {
  const f = paperFixture();
  return {
    schemaVersion: 'ops-dataset.v1',
    paper: replayPaper(f.config, f.events),
    evaluation: null,
    newsSnapshots: [],
  };
}
describe('automatic local demo access', () => {
  it('advertises explicit local synthetic auto-login and creates only a read session', async () => {
    const app = buildOperationsApp(data(), security, { demoAutoLogin: true });
    try {
      expect((await app.inject('/ready')).json<{ demoAutoLogin: boolean }>().demoAutoLogin).toBe(
        true,
      );
      expect((await app.inject('/overview')).statusCode).toBe(401);
      const login = await app.inject({
          method: 'POST',
          url: '/session',
          payload: { token: reader },
          headers: { origin: security.allowedOrigins[0] },
        }),
        cookie = String(login.headers['set-cookie']).split(';')[0]!;
      expect(login.json<{ role: string }>().role).toBe('READ');
      expect((await app.inject({ url: '/overview', headers: { cookie } })).statusCode).toBe(200);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/controls',
            headers: { cookie, origin: security.allowedOrigins[0] },
            payload: { action: 'PAUSE' },
          })
        ).statusCode,
      ).toBe(403);
    } finally {
      await app.close();
    }
  });
  it('cannot enable demo auto-login for deployments, public datasets or custom reader secrets', async () => {
    const d = data(),
      deployment = {
        ...security,
        mode: 'DEPLOYMENT',
        allowedOrigins: ['https://research.example.invalid'],
      };
    expect(() => buildOperationsApp(d, deployment, { demoAutoLogin: true })).toThrow();
    expect(() =>
      buildOperationsApp(
        d,
        { ...security, readerTokenHash: canonicalHash('private-reader-test-00000000000000') },
        { demoAutoLogin: true },
      ),
    ).toThrow();
    const publicPaper = new PaperBroker({ ...d.paper.config, origin: 'PUBLIC_READ_ONLY' }).report();
    expect(() =>
      buildOperationsApp({ ...d, paper: publicPaper }, security, { demoAutoLogin: true }),
    ).toThrow();
    const app = buildOperationsApp(d, deployment);
    try {
      expect((await app.inject('/ready')).json<{ demoAutoLogin: boolean }>().demoAutoLogin).toBe(
        false,
      );
      expect((await app.inject('/overview')).statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
