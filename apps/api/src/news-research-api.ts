import { NEWS_V3_ENGINE_HASH } from '../../../packages/backtest/src/news-history-v3.js';
import { NEWS_V4_ENGINE_HASH } from '../../../packages/backtest/src/news-history-v4.js';
import { newsV4Plan } from '../../../packages/research/src/news-long-history.js';
import { NewsV3Report } from '../../../packages/contracts/src/news-research-v3.js';
import { NewsResearchReport } from '../../../packages/contracts/src/news-research.js';
import { NewsV4Report } from '../../../packages/contracts/src/news-research-v4.js';
import { NEWS_V5_ENGINE_HASH } from '../../../packages/backtest/src/news-history-v5.js';
import { NEWS_V6_ENGINE_HASH } from '../../../packages/backtest/src/news-history-v6.js';
import { NewsV5Report } from '../../../packages/contracts/src/news-research-v5.js';
import { NewsResearchStore } from '../../../packages/db/src/news-research-store.js';
import type { FastifyInstance } from 'fastify';
import type { Queue } from 'bullmq';
import { z } from 'zod';
import { newsResearchPlan, NEWS_HOUR } from '../../../packages/research/src/news-history-study.js';
import { NEWS_RESEARCH_ENGINE_HASH } from '../../../packages/backtest/src/news-history-replay.js';
import { reconcileNewsResearch } from './news-research-jobs.js';

export function registerNewsResearchApi(
  app: FastifyInstance,
  store: NewsResearchStore,
  queue: Queue,
  legacyStore?: NewsResearchStore,
) {
  const prefix =
    store.kind === 'v6'
      ? '/news/research/v6'
      : store.kind === 'v5'
        ? '/news/research/v5'
        : store.kind === 'v4'
          ? '/news/research/v4'
          : store.kind === 'v3'
            ? '/news/research/v3'
            : '/news/research';
  app.get(`${prefix}/status`, async () => {
    const worker = await store.news.runtime('research');
    return {
      runs: await store.runs(),
      workerHealthy: !!worker && Date.now() - Number(worker.at) < 120000,
    };
  });
  app.post(`${prefix}/run`, async (req) => {
    if (store.kind === 'v6') {
      if (!legacyStore || legacyStore.kind !== 'v5') throw new Error('RESEARCH_BASELINE_NOT_READY');
      const body = z
        .strictObject({ baselineRunId: z.string().uuid().optional() })
        .parse(req.body ?? {});
      const base = body.baselineRunId
        ? await legacyStore.run(body.baselineRunId)
        : (await legacyStore.runs()).find((r) => r.state === 'COMPLETE');
      if (!base || base.state !== 'COMPLETE') throw new Error('RESEARCH_BASELINE_NOT_READY');
      const parent = NewsV5Report.parse(await legacyStore.report(base.id));
      const corpus = await new NewsResearchStore(store.news, 'v4').corpus(parent.referenceV4RunId);
      if (!corpus) throw new Error('RESEARCH_BASELINE_NOT_READY');
      const run = await store.request(parent.plan, NEWS_V6_ENGINE_HASH, corpus.snapshot, base.id);
      await reconcileNewsResearch(store, queue);
      return run;
    }
    if (store.kind === 'v5') {
      if (!legacyStore || legacyStore.kind !== 'v4') throw new Error('RESEARCH_BASELINE_NOT_READY');
      const body = z
        .strictObject({ baselineRunId: z.string().uuid().optional() })
        .parse(req.body ?? {});
      const base = body.baselineRunId
        ? await legacyStore.run(body.baselineRunId)
        : (await legacyStore.runs()).find((r) => r.state === 'COMPLETE');
      if (!base || base.state !== 'COMPLETE') throw new Error('RESEARCH_BASELINE_NOT_READY');
      const parent = NewsV4Report.parse(await legacyStore.report(base.id)),
        corpus = await legacyStore.corpus(base.id);
      if (!corpus) throw new Error('RESEARCH_BASELINE_NOT_READY');
      const run = await store.request(parent.plan, NEWS_V5_ENGINE_HASH, corpus.snapshot, base.id);
      await reconcileNewsResearch(store, queue);
      return run;
    }
    if (store.kind === 'v4') {
      if (!legacyStore || legacyStore.kind !== 'v3') throw new Error('RESEARCH_BASELINE_NOT_READY');
      const body = z
        .strictObject({ baselineRunId: z.string().uuid().optional() })
        .parse(req.body ?? {});
      const base = body.baselineRunId
        ? await legacyStore.run(body.baselineRunId)
        : (await legacyStore.runs()).find((r) => r.state === 'COMPLETE');
      if (!base || base.state !== 'COMPLETE') throw new Error('RESEARCH_BASELINE_NOT_READY');
      const parent = NewsV3Report.parse(await legacyStore.report(base.id));
      const run = await store.request(
        newsV4Plan(parent.plan.to),
        NEWS_V4_ENGINE_HASH,
        await store.capture(),
        base.id,
      );
      await reconcileNewsResearch(store, queue);
      return run;
    }
    if (store.kind === 'v3') {
      if (!legacyStore) throw new Error('RESEARCH_BASELINE_NOT_READY');
      const body = z
        .strictObject({ baselineRunId: z.string().uuid().optional() })
        .parse(req.body ?? {});
      const base = body.baselineRunId
        ? await legacyStore.run(body.baselineRunId)
        : (await legacyStore.runs()).find((r) => r.state === 'COMPLETE');
      if (!base || base.state !== 'COMPLETE') throw new Error('RESEARCH_BASELINE_NOT_READY');
      const report = NewsResearchReport.parse(await legacyStore.report(base.id));
      const snapshot = await legacyStore.snapshot(base.id);
      const run = await store.request(report.plan, NEWS_V3_ENGINE_HASH, snapshot, base.id);
      await reconcileNewsResearch(store, queue);
      return run;
    }
    const { to } = z
      .strictObject({ to: z.number().int().positive().optional() })
      .parse(req.body ?? {});
    const latest = (await store.runs())[0];
    const end = to ?? latest?.plan.to ?? Math.floor(Date.now() / NEWS_HOUR) * NEWS_HOUR;
    // This historical price window was already inspected in market research and the development smoke run.
    const plan = newsResearchPlan(end, true),
      snapshot = await store.capture();
    const run = await store.request(plan, NEWS_RESEARCH_ENGINE_HASH, snapshot);
    await reconcileNewsResearch(store, queue);
    return run;
  });
  app.get(`${prefix}/reports/:id`, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params),
      report = await store.report(id);
    return report ?? reply.code(404).send({ error: 'RESEARCH_REPORT_NOT_READY' });
  });
  app.get(`${prefix}/export/:id/:format`, async (req, reply) => {
    const { id, format } = z
      .object({ id: z.string().uuid(), format: z.enum(['json', 'csv', 'md']) })
      .parse(req.params);
    const report = await store.report(id);
    if (!report) return reply.code(404).send({ error: 'RESEARCH_REPORT_NOT_READY' });
    reply.header('content-disposition', `attachment; filename="news-history-${id}.${format}"`);
    if (format === 'json') return report;
    const eventMap = new Map(
      [
        ...('legacyEvents' in report ? report.legacyEvents : []),
        ...('replayEventsV5' in report ? report.replayEventsV5 : []),
        ...('replayEventsV6' in report ? report.replayEventsV6 : []),
        ...report.events,
      ].map((e) => [e.id, e]),
    );
    const accounts = report.rows.flatMap((r) =>
      r.models.flatMap((m) => [
        { asset: r.asset, label: m.version, model: m },
        ...('ablations' in m
          ? m.ablations.map((a) => ({
              asset: r.asset,
              label: 'LEARNED_V6/' + a.id,
              model: a.model,
            }))
          : []),
      ]),
    );
    if (format === 'csv') {
      const cell = (v: string | number | null | undefined) =>
        '"' +
        String(v ?? '')
          .replace(/^[=+@-]/, "'$&")
          .replaceAll('"', '""') +
        '"';
      const rows = accounts.flatMap(({ asset, label, model: m }) =>
        m.evaluations.flatMap((e) =>
          e.trades.map((t) => {
            const n = eventMap.get(t.eventId);
            return [
              asset,
              label,
              e.phase,
              t.side,
              t.status,
              t.entryAt,
              t.exitAt,
              t.entryPrice,
              t.exitPrice,
              t.quantity,
              t.netPnl,
              t.fees,
              t.financing,
              t.reason,
              n?.publisher,
              n?.title,
              n?.url,
              n?.publishedAt,
              n?.availableAt,
              report.interpretation,
            ]
              .map(cell)
              .join(',');
          }),
        ),
      );
      reply.type('text/csv; charset=utf-8');
      return [
        'asset,model,split,side,status,entryAt,exitAt,entryPrice,exitPrice,quantity,netPnl,fees,financing,exitReason,publisher,title,url,publishedAt,actualAvailableAt,interpretation',
        ...rows,
      ].join('\r\n');
    }
    reply.type('text/markdown; charset=utf-8');
    return [
      '# Historical news research',
      '',
      report.interpretation,
      '',
      `Window: ${new Date(report.plan.from).toISOString()} to ${new Date(report.plan.to).toISOString()}`,
      'Each token/split starts with 10,000 virtual USDT. Fees are on. Results are exploratory, not live-qualified.',
      '',
      '| Token | Model | Final descriptive P&L | Trades | Double-cost P&L | +1h delay P&L |',
      '| --- | --- | ---: | ---: | ---: | ---: |',
      ...accounts.map(
        ({ asset, label, model: m }) =>
          `| ${asset} | ${label} | ${m.evaluations[2]!.netPnl} | ${m.evaluations[2]!.trades.length} | ${m.doubleCostTestPnl} | ${m.delayedTestPnl} |`,
      ),
      '',
      ...report.limitations.map((s) => '- ' + s),
      ...('limitationsV6' in report ? report.limitationsV6.map((s) => '- ' + s) : []),
    ].join('\n');
  });
}
