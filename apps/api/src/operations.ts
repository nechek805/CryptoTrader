import { randomBytes, timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  OpsDatasetSchema,
  OpsOverviewSchema,
  OpsCurveSchema,
  OpsQuerySchema,
  OpsSecuritySchema,
  OpsSignalSchema,
  OpsTraceSchema,
  IdSchema,
  compareDecimal,
  opsPageSchema,
  PaperEventSchema,
} from '@crypto/contracts';
import type { OpsOverview, PaperEvent, PaperReport } from '@crypto/contracts';
import { canonicalHash, decimal, subtractDecimal, addDecimal } from '@crypto/core';
import { verifyPaperReport, PaperBroker } from '@crypto/paper';
import { validateEventStudyArtifact } from '@crypto/research';
import { evaluationEvidence, evaluationMarkdown, verifyEvaluationReport } from '@crypto/evaluation';
import { validateNewsEventSnapshot } from '@crypto/news';
import { registerBtcTestRoutes } from './btc-test.js';
import type { BtcTestService } from './btc-test.js';

export interface OpsPorts {
  btcTest?: BtcTestService;
  demoAutoLogin?: boolean;
  control?: (event: PaperEvent) => Promise<PaperReport>;
  refresh?: () => Promise<PaperReport>;
}
export function buildOperationsApp(input: unknown, securityInput: unknown, ports: OpsPorts = {}) {
  const data = OpsDatasetSchema.parse(input),
    security = OpsSecuritySchema.parse(securityInput);
  let paper = verifyPaperReport(data.paper);
  let runHash = canonicalHash(paper);
  const healthOf = () => {
    const broker = new PaperBroker(paper.config);
    for (const l of paper.log) broker.consume(l.event);
    return broker.sourceHealth();
  };
  let health = healthOf();
  let refreshing: Promise<void> | null = null,
    lastRefresh = 0,
    controlBusy = false;
  const studies = data.studies.map(validateEventStudyArtifact);
  const evaluation = data.evaluation ? verifyEvaluationReport(data.evaluation, paper) : null,
    snapshots = data.newsSnapshots.map(validateNewsEventSnapshot),
    roles = new WeakMap<FastifyRequest, 'READ' | 'ADMIN'>(),
    sessions = new Map<string, { role: 'READ' | 'ADMIN'; expires: number }>(),
    limits = new Map<string, { start: number; count: number }>(),
    app = Fastify({ logger: false, requestIdHeader: false, bodyLimit: 16384, trustProxy: false });
  if (
    (ports.demoAutoLogin &&
      (security.mode !== 'LOCAL' ||
        paper.config.origin !== 'SYNTHETIC' ||
        security.readerTokenHash !== canonicalHash('fixture-read-0000000000000000000000'))) ||
    security.readerTokenHash === security.adminTokenHash ||
    security.allowedOrigins.some((value) => {
      const u = new URL(value);
      return (
        u.origin !== value ||
        (security.mode === 'DEPLOYMENT'
          ? u.protocol !== 'https:'
          : !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))
      );
    })
  )
    throw new Error('Invalid operations authentication boundary');
  const match = (token: string, hash: string) =>
    timingSafeEqual(
      Buffer.from(canonicalHash(token).slice(7), 'hex'),
      Buffer.from(hash.slice(7), 'hex'),
    );
  const roleForToken = (token: string): 'READ' | 'ADMIN' | null => {
    if (token.length > 200) return null;
    const admin = match(token, security.adminTokenHash),
      reader = match(token, security.readerTokenHash);
    return admin ? 'ADMIN' : reader ? 'READ' : null;
  };
  app.addHook('onRequest', (req, reply, done) => {
    reply
      .header('cache-control', 'no-store')
      .header('x-request-id', req.id)
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; frame-ancestors 'none'")
      .header('referrer-policy', 'no-referrer');
    const now = Date.now();
    for (const [id, session] of sessions) if (session.expires <= now) sessions.delete(id);
    for (const [id, limit] of limits) if (now - limit.start > 60000) limits.delete(id);
    const key = `${req.ip}/${req.method === 'POST' && req.url.split('?')[0] === '/session' ? 'LOGIN' : 'API'}`,
      limit = limits.get(key) ?? { start: now, count: 0 };
    limit.count++;
    limits.set(key, limit);
    if (
      limits.size > 4096 ||
      limit.count > (key.endsWith('/LOGIN') ? 10 : security.requestsPerMinute)
    ) {
      void reply.code(429).send({ error: 'RATE_LIMITED' });
      return;
    }
    if (req.method === 'GET' && req.url === '/ready') {
      done();
      return;
    }
    if (req.headers.origin && !security.allowedOrigins.includes(req.headers.origin)) {
      void reply.code(403).send({ error: 'FORBIDDEN_ORIGIN' });
      return;
    }
    if (req.method === 'POST' && req.url === '/session') {
      done();
      return;
    }
    const bearer = req.headers.authorization?.startsWith('Bearer ')
        ? req.headers.authorization.slice(7)
        : null,
      cookie = req.headers.cookie
        ?.split(';')
        .map((p) => p.trim())
        .find((p) => p.startsWith('research_session='))
        ?.slice('research_session='.length),
      role = bearer ? roleForToken(bearer) : cookie ? (sessions.get(cookie)?.role ?? null) : null;
    if (!role) {
      void reply.code(401).send({ error: 'AUTHENTICATION_REQUIRED' });
      return;
    }
    if (req.method !== 'GET' && !bearer && !req.headers.origin) {
      void reply.code(403).send({ error: 'ORIGIN_REQUIRED' });
      return;
    }
    roles.set(req, role);
    done();
  });
  app.get('/ready', () => ({
    schemaVersion: 'ops-ready.v1',
    ready: true,
    execution: 'SIMULATED',
    demoAutoLogin: ports.demoAutoLogin === true,
  }));
  if (ports.btcTest) {
    if (security.mode !== 'LOCAL')
      throw new Error('BTC retrospective jobs are local research only');
    registerBtcTestRoutes(app, ports.btcTest);
  }
  app.post('/session', (req, reply) => {
    const body = z.strictObject({ token: z.string().min(32).max(200) }).parse(req.body),
      role = roleForToken(body.token);
    if (!role) return reply.code(401).send({ error: 'AUTHENTICATION_REQUIRED' });
    if (sessions.size >= 1024) return reply.code(503).send({ error: 'SESSION_CAPACITY' });
    const id = randomBytes(32).toString('hex');
    sessions.set(id, { role, expires: Date.now() + security.sessionTtlSeconds * 1000 });
    reply.header(
      'set-cookie',
      `research_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${security.sessionTtlSeconds}${security.mode === 'DEPLOYMENT' ? '; Secure' : ''}`,
    );
    return { role, expiresInSeconds: security.sessionTtlSeconds };
  });
  app.get('/session', (req) => ({ role: roles.get(req) }));
  app.addHook('preHandler', async (req) => {
    if (!roles.has(req) || !ports.refresh || controlBusy) return;
    if (!refreshing && Date.now() - lastRefresh >= 5000) {
      const refresh = ports.refresh;
      refreshing = (async () => {
        const next = verifyPaperReport(await refresh());
        if (
          next.configHash !== paper.configHash ||
          canonicalHash(next.log.slice(0, paper.log.length)) !== canonicalHash(paper.log)
        )
          throw new Error('Immutable refresh prefix mismatch');
        paper = next;
        runHash = canonicalHash(paper);
        health = healthOf();
        lastRefresh = Date.now();
      })().finally(() => {
        refreshing = null;
      });
    }
    if (refreshing) await refreshing;
  });
  app.post('/logout', (req, reply) => {
    const id = req.headers.cookie
      ?.split(';')
      .map((p) => p.trim())
      .find((p) => p.startsWith('research_session='))
      ?.slice(17);
    if (id) sessions.delete(id);
    reply.header(
      'set-cookie',
      `research_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${security.mode === 'DEPLOYMENT' ? '; Secure' : ''}`,
    );
    return { loggedOut: true };
  });
  const page = (req: FastifyRequest, rows: unknown[], schema: z.ZodType = z.json()) => {
    const q = OpsQuerySchema.parse(req.query);
    const selected = rows.filter((row) => {
      const r = row as { portfolio?: string; symbol?: string };
      return (!q.portfolio || r.portfolio === q.portfolio) && (!q.symbol || r.symbol === q.symbol);
    });
    return opsPageSchema(schema).parse({
      schemaVersion: 'ops-page.v1',
      runHash,
      total: selected.length,
      nextOffset: q.offset + q.limit < selected.length ? q.offset + q.limit : null,
      items: selected.slice(q.offset, q.offset + q.limit),
    });
  };
  const sourceStatuses = (): OpsOverview['sources'] => {
    const quotes = paper.log.filter((l) => l.event.kind === 'QUOTE'),
      lastQuote = quotes.at(-1)?.event,
      fatal = paper.alerts.filter((a) => /LICENSE|VALIDATION|METADATA/.test(a.code)),
      marketFlags = paper.alerts.filter((a) => /MARKET|CLOCK|QUARANTINED/.test(a.code));
    return [
      {
        id: paper.config.source.id,
        kind: 'MARKET',
        status: health.fatal
          ? 'REVIEW_REQUIRED'
          : !health.marketConnected
            ? 'DISCONNECTED'
            : !health.marketFresh
              ? 'STALE'
              : 'READY_IN_REPLAY',
        lastObservedAt: lastQuote?.at ?? null,
        flags: [...new Set([...fatal, ...marketFlags].map((a) => a.code))],
      },
      ...paper.config.newsSources.map((s) => ({
        id: s.id,
        kind: 'NEWS' as const,
        status:
          s.validUntil <= paper.now ||
          paper.alerts.some((a) => a.sourceId === s.id && /VALIDATION|LICENSE/.test(a.code))
            ? ('REVIEW_REQUIRED' as const)
            : !health.news.find((h) => h.id === s.id)?.connected
              ? ('DISCONNECTED' as const)
              : !health.news.find((h) => h.id === s.id)?.fresh
                ? ('STALE' as const)
                : ('READY_IN_REPLAY' as const),
        lastObservedAt:
          paper.log.filter((l) => l.event.kind === 'HEARTBEAT' && l.event.sourceId === s.id).at(-1)
            ?.event.at ?? null,
        flags: paper.alerts.filter((a) => a.sourceId === s.id).map((a) => a.code),
      })),
    ];
  };
  const overview = () =>
    OpsOverviewSchema.parse({
      schemaVersion: 'ops-overview.v1',
      execution: 'SIMULATED',
      origin: paper.config.origin,
      runHash,
      manifestHash: paper.config.runManifestHash,
      status: paper.status,
      asOf: paper.now,
      quoteCurrency: paper.config.quoteCurrency,
      initialCapitalPerArm: paper.config.initialCash,
      portfolios: (['BASELINE', 'NEWS_ONLY', 'MARKET_ONLY', 'FUSION'] as const).map((portfolio) => {
        const e = paper.equity.filter((e) => e.portfolio === portfolio).at(-1)!,
          fees = paper.fills
            .filter((f) => f.fill.portfolio === portfolio)
            .reduce((sum, f) => addDecimal(sum, f.fill.fee), decimal('0'));
        return {
          portfolio,
          cash: e.cash,
          equity: e.equity,
          netPnl: e.equity === null ? null : subtractDecimal(e.equity, paper.config.initialCash),
          exposure: e.exposureFraction,
          fees,
        };
      }),
      counts: {
        candidates: paper.decisions.length,
        holds: paper.decisions.filter((d) => d.request.risk.candidate.side === 'HOLD').length,
        riskVetoes: paper.decisions.filter(
          (d) => !d.risk.decision.allowed && d.request.risk.candidate.side !== 'HOLD',
        ).length,
        fills: paper.fills.length,
        alerts: paper.alerts.length,
      },
      sources: sourceStatuses(),
      report: evaluation
        ? {
            hash: evaluation.hash,
            recommendation: evaluation.memo.recommendation,
            warnings: evaluation.warnings,
          }
        : null,
    });
  app.get('/overview', overview);
  app.get('/sources', (req) => page(req, sourceStatuses()));
  app.get('/portfolios', (req) => page(req, overview().portfolios));
  app.get('/runs', (req) =>
    page(req, [
      {
        id: paper.config.runManifestHash,
        status: paper.status,
        origin: paper.config.origin,
        startAt: paper.config.startAt,
        endAt: paper.config.endAt,
        execution: 'SIMULATED',
        logHead: paper.logHead,
      },
    ]),
  );
  app.get('/manifests', (req) => page(req, [paper.config]));
  app.get('/market', (req) =>
    page(
      req,
      paper.config.instruments.map((i) => ({ ...i, status: sourceStatuses()[0]!.status })),
    ),
  );
  const signals = () =>
    paper.decisions.map((d) => {
      const c = d.request.risk.candidate,
        ids = paper.orders.filter((o) => o.decisionId === d.id).map((o) => o.order.id);
      return OpsSignalSchema.parse({
        id: c.id,
        portfolio: c.portfolio,
        symbol: c.symbol,
        at: c.decisionAt,
        side: c.side,
        allowed:
          d.risk.decision.allowed &&
          paper.orders.some(
            (o) =>
              o.decisionId === d.id && o.parentOrderId === null && o.order.status !== 'REJECTED',
          ),
        reasons: [
          ...new Set([
            ...d.finalReasons,
            ...paper.orders
              .filter((o) => o.decisionId === d.id && o.rejectionReason)
              .map((o) => o.rejectionReason!),
          ]),
        ],
        featureCutoff: d.featureCutoff,
        calibration: d.calibration,
        fills: paper.fills.filter((f) => ids.includes(f.fill.orderId)).length,
      });
    });
  app.get('/signals', (req) => page(req, signals(), OpsSignalSchema));
  app.get('/features', (req) =>
    page(
      req,
      paper.decisions.map((d) => ({
        candidateId: d.request.risk.candidate.id,
        portfolio: d.request.risk.candidate.portfolio,
        symbol: d.request.risk.candidate.symbol,
        featureCutoff: d.featureCutoff,
        regime: d.request.regime,
        producerSnapshotHash: d.request.sourceSnapshotHash,
        predictiveFeatureVector: null,
        missingReason: 'Resolve the exact producer snapshot; no feature values are invented',
        riskMeasurement: d.request.risk.market,
      })),
    ),
  );
  app.get('/signals/:id', (req) => {
    const id = z.strictObject({ id: IdSchema }).parse(req.params).id,
      d = paper.decisions.find((d) => d.request.risk.candidate.id === id);
    if (!d) throw new Error('Missing signal');
    const orderIds = paper.orders.filter((o) => o.decisionId === d.id).map((o) => o.order.id),
      fills = paper.fills.filter((f) => orderIds.includes(f.fill.orderId)),
      realized = fills.filter((f) => f.realizedNetPnl !== null);
    return OpsTraceSchema.parse({
      schemaVersion: 'ops-trace.v1',
      execution: 'SIMULATED',
      candidate: d.request.risk.candidate,
      decision: d,
      fills,
      sourceContentStatus: 'REFERENCED_SOURCE_ARTIFACTS_MUST_BE_RESOLVED',
      predictiveFeatureStatus: 'SEE_PRODUCER_SOURCE_SNAPSHOT_NO_INVENTED_VECTOR',
      realizedNetPnl: realized.length
        ? realized.reduce((s, f) => addDecimal(s, f.realizedNetPnl!), decimal('0'))
        : null,
      manifestHash: paper.config.runManifestHash,
    });
  });
  app.get('/trades', (req) =>
    page(
      req,
      paper.fills.map((f) => ({ ...f, portfolio: f.fill.portfolio, symbol: f.fill.symbol })),
    ),
  );
  app.get('/equity', (req) => page(req, paper.equity));
  app.get('/curve', () =>
    OpsCurveSchema.parse({
      schemaVersion: 'ops-curve.v1',
      execution: 'SIMULATED',
      runHash,
      aggregation: 'BUCKET_CLOSE_ANY_MISSING_CREATES_GAP',
      series: (['BASELINE', 'NEWS_ONLY', 'MARKET_ONLY', 'FUSION'] as const).map((portfolio) => {
        const rows = [
            ...new Map(
              paper.equity.filter((e) => e.portfolio === portfolio).map((e) => [e.at, e]),
            ).values(),
          ],
          size = Math.max(1, Math.ceil(rows.length / 512)),
          points = [];
        for (let i = 0; i < rows.length; i += size) {
          const group = rows.slice(i, i + size),
            hasMissing = group.some((e) => e.equity === null),
            values = group
              .flatMap((e) => (e.equity === null ? [] : [e.equity]))
              .sort((a, b) => compareDecimal(a, b));
          points.push({
            at: group.at(-1)!.at,
            value: hasMissing ? null : group.at(-1)!.equity,
            minimum: values[0] ?? null,
            maximum: values.at(-1) ?? null,
            hasMissing,
          });
        }
        return { portfolio, sourcePoints: rows.length, points };
      }),
    }),
  );
  app.get('/events', (req) =>
    page(
      req,
      snapshots.flatMap((s) =>
        s.view.events.map((e) => ({
          ...e,
          snapshotHash: canonicalHash(s),
          snapshotAt: s.request.decisionAt,
        })),
      ),
    ),
  );
  app.get('/provenance', (req) => {
    const q = z.strictObject({ snapshot: z.string().optional() }).parse(req.query),
      s = snapshots.find((s) => canonicalHash(s) === q.snapshot) ?? snapshots.at(-1);
    if (!s)
      return {
        snapshots: [],
        nodes: [],
        edges: [],
        events: [],
        limitation: 'Source snapshots not attached',
      };
    return z.json().parse({
      snapshots: snapshots.map((s) => ({ hash: canonicalHash(s), at: s.request.decisionAt })),
      selectedHash: canonicalHash(s),
      nodes: s.view.graph.nodes.map((n) => ({
        id: n.id,
        articleId: n.articleId,
        articleVersionId: n.articleVersionId,
        sourceId: n.sourceId,
        independenceGroup: n.independenceGroup,
        polarity: n.polarity,
        canonicalUrl: n.canonicalUrl,
        textStatus: 'ORIGINAL_CONTENT_NOT_REPUBLISHED',
      })),
      edges: s.view.graph.edges,
      contradictions: s.view.graph.clusters.flatMap((c) => c.contradictions),
      events: s.view.events,
      timeline: s.view.graph.timeline,
      limitation:
        'Archive context is separate from the accounting run unless exact evidence IDs bind it; factual corroboration is not a return probability',
    });
  });
  const evidence = data.evaluation ? evaluationEvidence(data.paper, data.evaluation.plan) : [];
  app.get('/evidence', (req) =>
    page(
      req,
      evidence.map(({ value: _, ...e }) => {
        void _;
        return e;
      }),
    ),
  );
  app.get('/evidence/:id', (req) => {
    const id = z.strictObject({ id: IdSchema }).parse(req.params).id,
      matches = evidence.filter((e) => e.id === id || e.hash === id);
    if (!matches.length) throw new Error('Missing evidence');
    return z.json().parse({ versions: matches });
  });
  app.get('/reports', () =>
    evaluation ? z.json().parse(evaluation) : { error: 'REPORT_NOT_ATTACHED' },
  );
  app.get('/studies', (req) =>
    page(
      req,
      studies.map((s) => ({ hash: canonicalHash(s), ...s.result })),
    ),
  );
  app.get('/parameters', () =>
    z.json().parse({
      runHash,
      config: paper.config,
      policies: [...new Map(paper.decisions.map((d) => [d.configHash, d.policy])).entries()].map(
        ([hash, policy]) => ({ hash, policy }),
      ),
      producerParameters: null,
      missingReason: 'Resolve hashed producer bundles; no tuning values are inferred',
    }),
  );
  app.get('/correlations', () =>
    z.json().parse({
      runHash,
      interpretation: 'COMPLETE_DAILY_ARM_RETURN_PEARSON_NOT_CAUSAL',
      assetCorrelations: null,
      missingReason: 'Cross-asset aligned price panel not attached',
      pairs: (['BASELINE', 'NEWS_ONLY', 'MARKET_ONLY', 'FUSION'] as const).flatMap((a, i, arms) =>
        arms.slice(i + 1).map((b) => {
          const x = evaluation?.metrics.find((m) => m.portfolio === a)?.daily ?? [],
            y = evaluation?.metrics.find((m) => m.portfolio === b)?.daily ?? [],
            pairs = x.flatMap((d) => {
              const other = y.find((v) => v.day === d.day);
              return d.completeCalendarDay &&
                d.sourceCoverage === 'COMPLETE' &&
                d.netReturn !== null &&
                other?.completeCalendarDay &&
                other.sourceCoverage === 'COMPLETE' &&
                other.netReturn !== null
                ? [[Number(d.netReturn), Number(other.netReturn)]]
                : [];
            }),
            n = pairs.length,
            mx = pairs.reduce((s, p) => s + p[0]!, 0) / n,
            my = pairs.reduce((s, p) => s + p[1]!, 0) / n,
            xx = pairs.reduce((s, p) => s + (p[0]! - mx) ** 2, 0),
            yy = pairs.reduce((s, p) => s + (p[1]! - my) ** 2, 0);
          return {
            left: a,
            right: b,
            pairedDays: n,
            value:
              n >= 3 && xx > 0 && yy > 0
                ? Math.max(
                    -1,
                    Math.min(
                      1,
                      pairs.reduce((s, p) => s + (p[0]! - mx) * (p[1]! - my), 0) /
                        Math.sqrt(xx * yy),
                    ),
                  )
                : null,
          };
        }),
      ),
    }),
  );
  app.get('/alerts', (req) => page(req, paper.alerts));
  app.get('/telemetry', () => ({
    schemaVersion: 'ops-telemetry.v1',
    execution: 'SIMULATED',
    events: paper.log.length,
    ledgerReconciled: paper.ledgerReconciled,
    immutableLogHead: paper.logHead,
    alerts: paper.alerts.length,
    sessions: sessions.size,
  }));
  app.get('/exports/:format', (req, reply) => {
    const format = z
      .strictObject({ format: z.enum(['json', 'csv', 'md']) })
      .parse(req.params).format;
    if (!evaluation) throw new Error('Report not attached');
    reply.header(
      'content-disposition',
      `attachment; filename="research-${evaluation.hash.slice(7, 19)}.${format}"`,
    );
    if (format === 'md') return reply.type('text/markdown').send(evaluationMarkdown(evaluation));
    if (format === 'csv')
      return reply
        .type('text/csv')
        .send(
          `portfolio,net_pnl,closed_trades\n${evaluation.metrics.map((m) => `${m.portfolio},${m.netPnl ?? 'N/A'},${m.closedTrades}`).join('\n')}\n`,
        );
    return evaluation;
  });
  app.post('/controls', async (req, reply) => {
    if (roles.get(req) !== 'ADMIN') return reply.code(403).send({ error: 'ADMIN_REQUIRED' });
    const body = z
      .strictObject({
        action: z.enum(['PAUSE', 'RESUME', 'STOP', 'KILL']),
        reason: z.string().min(1).max(500),
        manifestHash: z.string(),
      })
      .parse(req.body);
    if (
      body.manifestHash !== paper.config.runManifestHash ||
      !ports.control ||
      controlBusy ||
      paper.status === 'STOPPED'
    )
      return reply.code(409).send({ error: 'RUN_CONTROL_UNAVAILABLE' });
    const event = PaperEventSchema.parse({
      kind: 'CONTROL',
      id: `dashboard:${randomBytes(16).toString('hex')}`,
      at: paper.now,
      requestedAt: new Date().toISOString(),
      action: body.action,
      reason: body.reason,
      actor: 'dashboard:admin',
    });
    controlBusy = true;
    try {
      const next = verifyPaperReport(await ports.control(event));
      if (
        next.configHash !== paper.configHash ||
        canonicalHash(next.log.slice(0, paper.log.length)) !== canonicalHash(paper.log)
      )
        throw new Error('Immutable control prefix mismatch');
      const queued = next.log.length === paper.log.length;
      paper = next;
      runHash = canonicalHash(paper);
      health = healthOf();
      return { execution: 'SIMULATED', status: paper.status, logHead: paper.logHead, queued };
    } finally {
      controlBusy = false;
    }
  });
  app.setNotFoundHandler((_req, reply) =>
    reply.code(404).send({ schemaVersion: 'ops-error.v1', error: 'NOT_FOUND' }),
  );
  app.setErrorHandler((_error, _req, reply) => {
    void reply
      .code(400)
      .send({ schemaVersion: 'ops-error.v1', error: 'INVALID_OR_INCOMPATIBLE_REQUEST' });
  });
  return app;
}
