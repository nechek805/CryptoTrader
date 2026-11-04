import { describe, expect, it } from 'vitest';
import { buildOperationsApp } from '@crypto/api';
import { canonicalHash } from '@crypto/core';
import { misleadingProfitableFixture, evaluatePaperExperiment } from '@crypto/evaluation';
import { PaperBroker, paperFixture, replayPaper } from '@crypto/paper';

const reader = 'synthetic-reader-token-0000000000000000',
  admin = 'synthetic-admin-token-00000000000000000',
  security = {
    schemaVersion: 'ops-security.v1',
    mode: 'LOCAL',
    readerTokenHash: canonicalHash(reader),
    adminTokenHash: canonicalHash(admin),
    allowedOrigins: ['http://127.0.0.1:3000'],
    requestsPerMinute: 240,
    sessionTtlSeconds: 900,
  };
function fixture() {
  const f = misleadingProfitableFixture();
  return {
    schemaVersion: 'ops-dataset.v1',
    paper: f.paper,
    evaluation: evaluatePaperExperiment(f.paper, f.plan),
    newsSnapshots: [],
  };
}
const headers = { authorization: `Bearer ${reader}` };
describe('Module 14 Iteration 1 read-only research API', () => {
  it('requires authentication and validates paginated/filterable research responses', async () => {
    const app = buildOperationsApp(fixture(), security);
    try {
      expect((await app.inject('/overview')).statusCode).toBe(401);
      expect((await app.inject('/ready')).statusCode).toBe(200);
      const overview = await app.inject({ url: '/overview', headers });
      expect(overview.statusCode).toBe(200);
      expect(overview.body).toContain('SIMULATED');
      const page = (
        await app.inject({ url: '/signals?portfolio=NEWS_ONLY&limit=1', headers })
      ).json<{ items: { portfolio: string }[]; total: number }>();
      expect(page.items).toHaveLength(1);
      expect(page.items[0]!.portfolio).toBe('NEWS_ONLY');
      expect((await app.inject({ url: '/signals?limit=1000000', headers })).statusCode).toBe(400);
      expect(
        (await app.inject({ url: '/sources?url=http://169.254.169.254', headers })).statusCode,
      ).toBe(400);
    } finally {
      await app.close();
    }
  }, 60000);
  it('traces a signal through feature cutoff, source references, risk, virtual fills and return', async () => {
    const d = fixture(),
      app = buildOperationsApp(d, security),
      id = d.paper.decisions.find((d) => d.request.risk.candidate.portfolio === 'NEWS_ONLY')!
        .request.risk.candidate.id;
    try {
      const res = await app.inject({ url: `/signals/${id}`, headers });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ fills: unknown[]; realizedNetPnl: string; manifestHash: string }>();
      expect(body.fills).toHaveLength(3);
      expect(Number(body.realizedNetPnl)).toBeGreaterThan(0);
      expect(body.manifestHash).toBe(d.paper.config.runManifestHash);
      for (const path of [
        '/features',
        '/market',
        '/events',
        '/portfolios',
        '/equity',
        '/manifests',
        '/evidence',
        '/reports',
      ])
        expect((await app.inject({ url: path, headers })).statusCode).toBe(200);
      const evidence = await app.inject({ url: '/evidence/synthetic:claim', headers });
      expect(evidence.body).toContain('REFERENCE_ONLY');
    } finally {
      await app.close();
    }
  }, 60000);
  it('preserves gaps in bounded chart data and provides reproducible report exports', async () => {
    const app = buildOperationsApp(fixture(), security);
    try {
      const r = (await app.inject({ url: '/curve', headers })).json<{
        series: { points: unknown[] }[];
        aggregation: string;
      }>();
      expect(r.aggregation).toBe('BUCKET_CLOSE_ANY_MISSING_CREATES_GAP');
      expect(r.series).toHaveLength(4);
      expect(r.series.every((s) => s.points.length <= 512)).toBe(true);
      for (const format of ['json', 'csv', 'md']) {
        const e = await app.inject({ url: `/exports/${format}`, headers });
        expect(e.statusCode).toBe(200);
        expect(e.headers['content-disposition']).toContain('attachment');
      }
    } finally {
      await app.close();
    }
  }, 60000);
  it('uses HttpOnly strict sessions and blocks unauthorized/cross-origin virtual controls', async () => {
    const f = paperFixture(),
      broker = new PaperBroker(f.config);
    for (const e of f.events) broker.consume(e);
    const app = buildOperationsApp(
      {
        schemaVersion: 'ops-dataset.v1',
        paper: replayPaper(f.config, f.events),
        evaluation: null,
        newsSnapshots: [],
      },
      security,
      {
        control: (e) => {
          broker.consume(e);
          return Promise.resolve(broker.report());
        },
      },
    );
    try {
      const login = await app.inject({
        method: 'POST',
        url: '/session',
        payload: { token: reader },
        headers: { origin: 'http://127.0.0.1:3000' },
      });
      expect(login.headers['set-cookie']).toContain('HttpOnly');
      expect(login.headers['set-cookie']).toContain('SameSite=Strict');
      const payload = {
        action: 'PAUSE',
        manifestHash: f.config.runManifestHash,
        reason: 'test operator review',
      };
      expect(
        (await app.inject({ method: 'POST', url: '/controls', headers, payload })).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/controls',
            headers: { authorization: `Bearer ${admin}`, origin: 'https://attacker.invalid' },
            payload,
          })
        ).statusCode,
      ).toBe(403);
      const r = await app.inject({
        method: 'POST',
        url: '/controls',
        headers: { authorization: `Bearer ${admin}` },
        payload,
      });
      expect(r.statusCode).toBe(200);
      expect(r.body).toContain('PAUSED');
      expect(broker.report().log.at(-1)!.event.kind).toBe('CONTROL');
      expect(
        (
          await app.inject({
            method: 'DELETE',
            url: '/evidence',
            headers: { authorization: `Bearer ${admin}` },
          })
        ).statusCode,
      ).toBe(404);
    } finally {
      await app.close();
    }
  }, 60000);
});
