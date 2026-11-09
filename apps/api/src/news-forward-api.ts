import Fastify from 'fastify';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { ForwardQuery } from '../../../packages/contracts/src/news-forward.js';
import type { NewsForwardService } from './news-forward-service.js';
export function buildNewsForwardApi(
  service: NewsForwardService,
  command: (action: 'START' | 'PAUSE' | 'RESUME' | 'STOP', id: string) => Promise<unknown>,
  security: { proxySecret: string; readerToken: string; adminToken: string; origins: string[] },
) {
  if (
    [security.proxySecret, security.readerToken, security.adminToken].some((s) => s.length < 32) ||
    new Set([security.proxySecret, security.readerToken, security.adminToken]).size !== 3
  )
    throw Error('PRIVATE_NEWS_FORWARD_AUTH_REQUIRED');
  const app = Fastify({
    logger: false,
    bodyLimit: 16384,
    trustProxy: false,
    requestIdHeader: false,
  });
  const digest = (v: string) => createHash('sha256').update(v).digest();
  const equal = (v: unknown, key: string) =>
    typeof v === 'string' && v.length <= 200 && timingSafeEqual(digest(v), digest(key));
  const rates = new Map<string, { at: number; count: number }>();
  app.addHook('onRequest', (req, reply, done) => {
    reply.header('cache-control', 'no-store').header('x-content-type-options', 'nosniff');
    if (req.method === 'GET' && req.url === '/health') {
      done();
      return;
    }
    const now = Date.now();
    for (const [k, v] of rates) if (now - v.at > 60000) rates.delete(k);
    const rate = rates.get(req.ip) ?? { at: now, count: 0 };
    rate.count++;
    rates.set(req.ip, rate);
    if (rate.count > 180 || rates.size > 1024) {
      void reply.code(429).send({ error: 'RATE_LIMITED' });
      return;
    }
    const token = req.headers.authorization?.startsWith('Bearer ')
      ? req.headers.authorization.slice(7)
      : null;
    const admin =
      equal(req.headers['x-crypto-proxy-auth'], security.proxySecret) ||
      equal(token, security.adminToken);
    if (!admin && !equal(token, security.readerToken)) {
      void reply.code(401).send({ error: 'AUTHENTICATION_REQUIRED' });
      return;
    }
    if (req.headers.origin && !security.origins.includes(req.headers.origin)) {
      void reply.code(403).send({ error: 'FORBIDDEN_ORIGIN' });
      return;
    }
    if (
      !['GET', 'HEAD'].includes(req.method) &&
      (!admin || !req.headers.origin || !security.origins.includes(req.headers.origin))
    ) {
      void reply.code(403).send({ error: 'OPERATOR_AND_ORIGIN_REQUIRED' });
      return;
    }
    done();
  });
  app.setErrorHandler((error, _req, reply) => {
    void reply
      .code(error instanceof z.ZodError ? 400 : 409)
      .send({ error: 'NEWS_FORWARD_REQUEST_UNAVAILABLE' });
  });
  app.get('/health', async (_req, reply) => {
    if (service.error || Date.now() - service.lastTick > 120000)
      return reply.code(503).send({ healthy: false });
    await service.store.assertLease();
    return { healthy: true };
  });
  app.get('/news-paper', (req) =>
    service.overview(z.object({ runId: z.string().uuid().optional() }).parse(req.query).runId),
  );
  app.get('/news-paper/positions', (req) => service.store.positions(ForwardQuery.parse(req.query)));
  app.post('/news-paper/start', (req) => {
    z.strictObject({}).parse(req.body);
    return command('START', randomUUID());
  });
  app.post('/news-paper/control', (req) =>
    command(
      z.strictObject({ action: z.enum(['PAUSE', 'RESUME', 'STOP']) }).parse(req.body).action,
      randomUUID(),
    ),
  );
  app.get('/news-paper/evidence/:run/:quote', async (req, reply) => {
    const p = z.object({ run: z.string().uuid(), quote: z.string().uuid() }).parse(req.params);
    const value = await service.store.evidence(p.run, p.quote);
    return value ?? reply.code(404).send({ error: 'EVIDENCE_NOT_FOUND' });
  });
  app.get('/news-paper/export/:format', async (req, reply) => {
    const { format } = z.object({ format: z.enum(['json', 'csv', 'tsv', 'md']) }).parse(req.params);
    const page = await service.store.positions(ForwardQuery.parse(req.query), true);
    reply
      .header('content-disposition', `attachment; filename="news-paper-positions.${format}"`)
      .header('x-export-rows', String(page.total));
    if (format === 'json') return page;
    const keys = [
      'id',
      'runId',
      'openedAt',
      'closedAt',
      'exchange',
      'asset',
      'side',
      'status',
      'lifecycle',
      'notional',
      'entry',
      'mark',
      'netPnl',
      'fees',
      'financing',
      'exitReason',
    ] as const;
    const separator = format === 'tsv' ? '\t' : format === 'md' ? ' | ' : ',';
    const cell = (value: string | number | null | undefined) => {
      const s = String(value ?? '').replace(/[\r\n\t]/g, ' ');
      return format === 'md'
        ? s.replaceAll('|', '\\|')
        : '"' + s.replace(/^[=+@-]/, "'$&").replaceAll('"', '""') + '"';
    };
    reply.type(
      format === 'md'
        ? 'text/markdown; charset=utf-8'
        : format === 'csv'
          ? 'text/csv; charset=utf-8'
          : 'text/tab-separated-values; charset=utf-8',
    );
    return [
      keys.join(separator),
      ...(format === 'md' ? [keys.map(() => '---').join(separator)] : []),
      ...page.positions.map((p) => keys.map((k) => cell(p[k])).join(separator)),
    ].join('\n');
  });
  return app;
}
