import Fastify from 'fastify';
import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { z } from 'zod';
import type { LiveNewsStore } from '../../../packages/db/src/live-news-store.js';
import {
  LiveNewsSourceInput,
  LiveNewsSourceSchema,
  NewsSourceId,
  LiveNewsQuery,
  LiveNewsAiProfile,
} from '../../../packages/contracts/src/live-news.js';
import { newsHttpsUrl, NewsIngestError } from '../../../packages/connectors/src/news-policy.js';
import type { LiveNewsQueues } from './live-news-queue.js';
import { requestNewsReconcile } from './live-news-queue.js';
import { registerNewsResearchApi } from './news-research-api.js';
import type { NewsResearchStore } from '../../../packages/db/src/news-research-store.js';
import type { Queue } from 'bullmq';

const digest = (v: string) => createHash('sha256').update(v).digest();
function validateSource(input: unknown) {
  const source = LiveNewsSourceInput.parse(input);
  newsHttpsUrl(source.homepage);
  if (source.feedUrl) {
    const u = newsHttpsUrl(source.feedUrl);
    if ([...u.searchParams.keys()].some((k) => /key|token|secret|password|auth/i.test(k)))
      throw new Error('CREDENTIALS_BELONG_IN_PRIVATE_ENV');
  }
  for (const origin of source.articleOrigins)
    if (newsHttpsUrl(origin).origin !== origin) throw new Error('ARTICLE_ORIGIN_REQUIRED');
  return source;
}
export function buildLiveNewsApi(
  store: LiveNewsStore,
  queues: LiveNewsQueues,
  security: { proxySecret: string; readerToken: string; adminToken: string; origins: string[] },
  research?: {
    store: NewsResearchStore;
    queue: Queue;
    v3Store?: NewsResearchStore;
    v4Store?: NewsResearchStore;
    v5Store?: NewsResearchStore;
    v6Store?: NewsResearchStore;
  },
) {
  if (
    [security.proxySecret, security.readerToken, security.adminToken].some((t) => t.length < 32) ||
    new Set([security.proxySecret, security.readerToken, security.adminToken]).size !== 3
  )
    throw new Error('Private news authentication required');
  const app = Fastify({
    logger: false,
    bodyLimit: 16384,
    requestIdHeader: false,
    trustProxy: false,
  });
  const roles = new WeakMap<object, 'READ' | 'ADMIN'>(),
    rates = new Map<string, { at: number; count: number }>();
  const equal = (value: unknown, expected: string) =>
    typeof value === 'string' &&
    value.length <= 200 &&
    timingSafeEqual(digest(value), digest(expected));
  app.addHook('onRequest', (req, reply, done) => {
    reply
      .header('cache-control', 'no-store')
      .header('x-content-type-options', 'nosniff')
      .header('x-request-id', req.id);
    if (req.url === '/health' && req.method === 'GET') {
      done();
      return;
    }
    const now = Date.now();
    for (const [key, v] of rates) if (now - v.at > 60000) rates.delete(key);
    const rate = rates.get(req.ip) ?? { at: now, count: 0 };
    rate.count++;
    rates.set(req.ip, rate);
    if (rate.count > 180 || rates.size > 1024) {
      void reply.code(429).send({ error: 'RATE_LIMITED' });
      return;
    }
    const bearer = req.headers.authorization?.startsWith('Bearer ')
      ? req.headers.authorization.slice(7)
      : null;
    const role =
      equal(req.headers['x-crypto-proxy-auth'], security.proxySecret) ||
      equal(bearer, security.adminToken)
        ? 'ADMIN'
        : equal(bearer, security.readerToken)
          ? 'READ'
          : null;
    if (!role) {
      void reply.code(401).send({ error: 'AUTHENTICATION_REQUIRED' });
      return;
    }
    if (req.headers.origin && !security.origins.includes(req.headers.origin)) {
      void reply.code(403).send({ error: 'FORBIDDEN_ORIGIN' });
      return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) {
      if (role !== 'ADMIN') {
        void reply.code(403).send({ error: 'ADMIN_REQUIRED' });
        return;
      }
      if (!req.headers.origin) {
        void reply.code(403).send({ error: 'ORIGIN_REQUIRED' });
        return;
      }
    }
    roles.set(req, role);
    done();
  });
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof NewsIngestError) {
      void reply.code(400).send({ error: 'INVALID_SOURCE_URL' });
      return;
    }
    const message = error instanceof Error ? error.message : '';
    const known = [
      'SOURCE_CHANGED_RELOAD',
      'SOURCE_NOT_FOUND',
      'NEWS_VERSION_NOT_FOUND',
      'AI_NOT_PERMITTED',
      'AI_NOT_CONFIGURED',
      'RESEARCH_DAILY_LIMIT',
      'V5_FROZEN_PARENT_CONFLICT',
      'V6_FROZEN_PARENT_CONFLICT',
      'RESEARCH_BASELINE_NOT_READY',
      'NEWS_RESEARCH_CORPUS_LIMIT',
      'CREDENTIALS_BELONG_IN_PRIVATE_ENV',
    ];
    void reply
      .code(error instanceof z.ZodError ? 400 : known.includes(message) ? 409 : 503)
      .send({ error: known.includes(message) ? message : 'NEWS_REQUEST_UNAVAILABLE' });
  });
  app.get('/health', async (_req, reply) => {
    try {
      await store.pool.query('SELECT 1');
      await queues.collect.getJobCounts('waiting');
      return { healthy: true };
    } catch {
      return reply.code(503).send({ healthy: false });
    }
  });
  app.get('/news/status', async (req) => {
    const sources = await store.sources(),
      collector = await store.runtime('collector'),
      analyzer = await store.runtime('analyzer');
    const ai = analyzer ? LiveNewsAiProfile.parse(analyzer.data) : null;
    let queueStatus: unknown;
    try {
      queueStatus = {
        connected: true,
        collection: await queues.collect.getJobCounts(
          'waiting',
          'active',
          'delayed',
          'failed',
          'completed',
          'prioritized',
        ),
        analysis: await queues.analyze.getJobCounts(
          'waiting',
          'active',
          'delayed',
          'failed',
          'completed',
          'prioritized',
        ),
      };
    } catch {
      queueStatus = { connected: false };
    }
    return {
      asOf: Date.now(),
      origin: 'PUBLIC_READ_ONLY',
      execution: 'NEWS_RESEARCH_ONLY',
      role: roles.get(req),
      sources: sources.length,
      enabled: sources.filter((s) => s.config.enabled).length,
      healthy: sources.filter((s) => s.health.state === 'HEALTHY').length,
      articleCount: sources.reduce((n, s) => n + s.health.totalArticles, 0),
      collector: collector
        ? { heartbeatAt: Number(collector.at), healthy: Date.now() - Number(collector.at) < 120000 }
        : null,
      analyzer: analyzer
        ? { heartbeatAt: Number(analyzer.at), healthy: Date.now() - Number(analyzer.at) < 120000 }
        : null,
      ai: ai ? { ...ai, requestsToday: await store.aiBudget() } : null,
      queues: queueStatus,
    };
  });
  app.get('/news/session', (req) => ({ role: roles.get(req) }));
  app.get('/news/sources', async () => ({ sources: await store.sources() }));
  app.post('/news/sources', async (req, reply) => {
    const config = validateSource(req.body),
      id = 'custom-' + randomUUID();
    const result = await store.saveSource(id, config, null);
    await requestNewsReconcile(queues).catch(() => {
      /* Durable source config will be reconciled on the next scheduled pass. */
    });
    return reply.code(201).send(result);
  });
  app.patch('/news/sources/:id', async (req) => {
    const { id } = z.object({ id: NewsSourceId }).parse(req.params);
    const body = z
      .strictObject({ expectedRevision: z.number().int().positive(), config: LiveNewsSourceInput })
      .parse(req.body);
    const result = await store.saveSource(id, validateSource(body.config), body.expectedRevision);
    await requestNewsReconcile(queues).catch(() => {});
    return LiveNewsSourceSchema.parse(result);
  });
  app.get('/news/sources/:id/history', async (req) => ({
    history: await store.sourceHistory(z.object({ id: NewsSourceId }).parse(req.params).id),
  }));
  app.post('/news/sources/:id/collect', async (req) => {
    const { id } = z.object({ id: NewsSourceId }).parse(req.params),
      source = await store.source(id);
    if (!source) throw new Error('SOURCE_NOT_FOUND');
    if (!source.enabled || !source.collectionApproved || source.adapter === 'SETUP_REQUIRED')
      throw new Error('AI_NOT_PERMITTED');
    const job = await queues.collect.add(
      'collect',
      { sourceId: id, revision: source.revision },
      { jobId: randomUUID(), priority: 5 },
    );
    return { queued: true, jobId: job.id };
  });
  app.post('/news/collect', async () => {
    let count = 0;
    for (const { config: s } of await store.sources())
      if (s.enabled && s.collectionApproved && s.adapter !== 'SETUP_REQUIRED') {
        await queues.collect.add(
          'collect',
          { sourceId: s.id, revision: s.revision },
          { jobId: randomUUID(), priority: 5 },
        );
        count++;
      }
    return { queued: true, sources: count };
  });
  app.get('/news/articles', (req) => store.articles(req.query));
  app.get('/news/articles/:id', async (req) => {
    const { id } = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/) }).parse(req.params);
    const version = await store.version(id);
    if (!version) throw new Error('NEWS_VERSION_NOT_FOUND');
    return { versions: await store.versions(version.articleId) };
  });
  app.post('/news/articles/:id/analyze', async (req) => {
    const { id } = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/) }).parse(req.params),
      version = await store.version(id);
    if (!version) throw new Error('NEWS_VERSION_NOT_FOUND');
    if (!version.aiAllowed || !(await store.source(version.sourceId))?.aiAllowed)
      throw new Error('AI_NOT_PERMITTED');
    const runtime = await store.runtime('analyzer');
    if (!runtime || !LiveNewsAiProfile.parse(runtime.data).enabled)
      throw new Error('AI_NOT_CONFIGURED');
    const job = await queues.analyze.add(
      'analyze',
      { versionId: id },
      { jobId: randomUUID(), priority: 5 },
    );
    return { queued: true, jobId: job.id };
  });
  app.get('/news/polls', async () => ({ polls: await store.recentPolls() }));
  app.get('/news/export/:format', async (req, reply) => {
    const { format } = z.object({ format: z.enum(['json', 'csv']) }).parse(req.params),
      page = await store.articles(LiveNewsQuery.parse(req.query), true);
    reply
      .header('content-disposition', `attachment; filename="collected-news.${format}"`)
      .header('x-export-rows', String(page.items.length));
    if (format === 'json') return page;
    const cell = (v: string | number | null | undefined) =>
      '"' +
      String(v ?? '')
        .replace(/^[=+@-]/, "'$&")
        .replace(/"/g, '""') +
      '"';
    reply.type('text/csv; charset=utf-8');
    return [
      'publisher,title,url,publishedAt,firstSeenAt,availableAt,revision,analysis,eventType,assets,direction,summary',
      ...page.items.map(({ version: v, analysis: a, analysisState }) =>
        [
          v.publisher,
          v.title,
          v.url,
          v.publishedAt === null ? '' : new Date(v.publishedAt).toISOString(),
          new Date(v.firstSeenAt).toISOString(),
          new Date(v.availableAt).toISOString(),
          v.revision,
          analysisState,
          a?.result?.eventType,
          a?.result?.assets.join(';'),
          a?.result?.direction,
          a?.result?.summary,
        ]
          .map(cell)
          .join(','),
      ),
    ].join('\r\n');
  });
  if (research) {
    registerNewsResearchApi(app, research.store, research.queue);
    if (research.v3Store)
      registerNewsResearchApi(app, research.v3Store, research.queue, research.store);
    if (research.v6Store && research.v5Store)
      registerNewsResearchApi(app, research.v6Store, research.queue, research.v5Store);
    if (research.v5Store && research.v4Store)
      registerNewsResearchApi(app, research.v5Store, research.queue, research.v4Store);
    if (research.v4Store && research.v3Store)
      registerNewsResearchApi(app, research.v4Store, research.queue, research.v3Store);
  }
  return app;
}
