import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { z } from 'zod';
import { canonicalHash } from '@crypto/core';
import { NewsV6Report } from '../../../packages/contracts/src/news-research-v6.js';
import {
  ForwardManifest,
  ForwardOverview,
  LIVE_EXCHANGES,
} from '../../../packages/contracts/src/news-forward.js';
import type {
  Manifest,
  LiveRun,
  LiveAsset,
  LiveExchange,
} from '../../../packages/contracts/src/news-forward.js';
import { MARKET_ASSETS } from '../../../packages/contracts/src/market-tests.js';
import {
  LiveNewsSourceView,
  LiveNewsVersionSchema,
} from '../../../packages/contracts/src/live-news.js';
import { NewsForwardStore } from '../../../packages/db/src/news-forward-store.js';
import { fetchLivePublic } from '../../../packages/connectors/src/news-forward-exchanges.js';
import {
  createNewsForwardRun,
  stageForwardNews,
  stepNewsForward,
  liveSummaries,
  fenceForwardPermissions,
} from '../../../packages/paper/src/news-forward-engine.js';
import type { LiveMarket } from '../../../packages/paper/src/news-forward-engine.js';

export const FORWARD_ENGINE_HASH = canonicalHash(
  [
    './news-forward-service.ts',
    '../../../packages/contracts/src/news-forward.ts',
    '../../../packages/paper/src/news-forward-engine.ts',
    '../../../packages/connectors/src/news-forward-exchanges.ts',
    '../../../packages/research/src/news-history-study.ts',
    '../../../packages/research/src/news-events-v4.ts',
  ].map((p) => readFileSync(new URL(p, import.meta.url), 'utf8')),
);
export class NewsForwardService {
  readonly store: NewsForwardStore;
  readonly news: Pool;
  manifest: Manifest | null = null;
  error: string | null = null;
  lastTick = 0;
  private markets = new Map<string, LiveMarket>();
  private feedErrors = new Map<string, string>();
  constructor(
    url: string,
    readonly reportId: string,
    readonly reportHash: string,
    schema = 'crypto_news_forward_v1',
  ) {
    this.store = new NewsForwardStore(url, schema);
    this.news = new Pool({
      connectionString: url,
      max: 1,
      connectionTimeoutMillis: 5000,
      statement_timeout: 15000,
    });
    this.news.on('error', () => {
      this.error = 'NEWS_READ_UNAVAILABLE';
    });
  }
  async initialize() {
    await this.store.migrate();
    if (!(await this.store.acquireWorker())) throw Error('NEWS_FORWARD_WORKER_ALREADY_RUNNING');
    const row = (
      await this.news.query<{ hash: string; data: unknown }>(
        'SELECT hash,data FROM crypto_news_live_v1.research_v6_reports WHERE run_id=$1',
        [z.string().uuid().parse(this.reportId)],
      )
    ).rows[0];
    if (!row || row.hash !== this.reportHash) throw Error('NEWS_FORWARD_FROZEN_REPORT_MISSING');
    const report = NewsV6Report.parse(row.data);
    if (canonicalHash(report) !== row.hash) throw Error('NEWS_FORWARD_FROZEN_REPORT_MISMATCH');
    const profiles = Object.fromEntries(
      report.rows
        .filter((r) => r.asset !== 'USDT')
        .map((row) => {
          const model = row.models.find((m) => m.version === 'LEARNED_V6');
          if (!model || model.version !== 'LEARNED_V6') throw Error('NEWS_FORWARD_PROFILE_MISSING');
          return [
            row.asset,
            {
              config: model.config,
              rules: model.rules,
              modelHash: model.modelHash,
              selectedCase: model.selectedCase,
            },
          ];
        }),
    );
    this.manifest = ForwardManifest.parse({
      reportRunId: this.reportId,
      reportHash: row.hash,
      engineHash: report.engineHash,
      profiles,
      interpretation: 'EXPLORATORY_FORWARD_PAPER_ONLY',
      historicalQualification: false,
    });
    const current = await this.store.read();
    if (
      current &&
      current.status !== 'ENDED' &&
      (current.engineHash !== FORWARD_ENGINE_HASH ||
        current.profileHash !== canonicalHash(this.manifest))
    )
      throw Error('NEWS_FORWARD_ACTIVE_PROTOCOL_MISMATCH');
    // Read-only instrument checks expose unavailable pairs before any news can request entry.
    const pairs = LIVE_EXCHANGES.flatMap((exchange) =>
      MARKET_ASSETS.map((asset) => ({ exchange, asset })),
    );
    for (let i = 0; i < pairs.length; i += 5)
      await Promise.all(
        pairs.slice(i, i + 5).map(async ({ exchange, asset }) => {
          const key = `${exchange}:${asset}`;
          try {
            const instrument = await fetchLivePublic(exchange, asset, 'instrument');
            if (!('tick' in instrument)) throw Error('INSTRUMENT_INVALID');
            this.markets.set(key, { book: null, bars: null, instrument });
          } catch {
            this.feedErrors.set(key, 'PUBLIC_INSTRUMENT_UNAVAILABLE');
          }
        }),
      );
  }
  async control(action: 'START' | 'PAUSE' | 'RESUME' | 'STOP', id: string) {
    z.string().uuid().parse(id);
    return this.store.change((current) => {
      if (current?.commands[id]) return null;
      const now = Math.max(Date.now(), current?.heartbeatAt ?? 0);
      if (action === 'START') {
        if (current && current.status !== 'ENDED') throw Error('NEWS_FORWARD_ALREADY_ACTIVE');
        if (!this.manifest) throw Error('NEWS_FORWARD_NOT_READY');
        const run = createNewsForwardRun(now, this.manifest, FORWARD_ENGINE_HASH);
        run.commands = { ...current?.commands, [id]: true };
        return {
          state: run,
          positions: [],
          sources: [],
          event: { kind: 'START', commandId: id, manifest: run.manifest },
        };
      }
      if (!current || current.status === 'ENDED') throw Error('NEWS_FORWARD_NO_ACTIVE_RUN');
      if (action === 'RESUME' && (current.status === 'STOPPING' || now >= current.deadlineAt))
        throw Error('NEWS_FORWARD_CANNOT_RESUME');
      const state = structuredClone(current);
      state.commands[id] = true;
      state.heartbeatAt = now;
      state.status = action === 'STOP' ? 'STOPPING' : action === 'PAUSE' ? 'PAUSED' : 'RUNNING';
      state.pending = {};
      return {
        state,
        positions: [],
        sources: [],
        event: { kind: 'CONTROL', action, commandId: id },
      };
    }, true);
  }
  async tick() {
    try {
      await this.store.assertLease();
      const run = await this.store.read();
      if (!run || run.status === 'ENDED') {
        this.lastTick = Date.now();
        this.error = null;
        return;
      }
      const sources = (
        await this.news.query<{ config: unknown; health: unknown }>(
          'SELECT config,health FROM crypto_news_live_v1.sources',
        )
      ).rows.map((r) => LiveNewsSourceView.parse(r));
      const versions = (
        await this.news.query<{ data: unknown }>(
          `SELECT data FROM crypto_news_live_v1.article_versions WHERE available_at >= $1 AND available_at <= $2 AND NOT(id=ANY($3::text[])) ORDER BY available_at,id LIMIT 100`,
          [run.startedAt, Date.now(), run.processed],
        )
      ).rows.map((r) => LiveNewsVersionSchema.parse(r.data));
      const observations = versions.flatMap((v) => {
        const source = sources.find((s) => s.config.id === v.sourceId);
        return source ? [{ version: v, source }] : [];
      });
      const staged = stageForwardNews(run, observations, Date.now());
      const needed = new Map<string, { exchange: LiveExchange; asset: LiveAsset }>();
      for (const p of run.positions) needed.set(`${p.exchange}:${p.asset}`, p);
      if (staged.run.status === 'RUNNING')
        for (const [key, p] of Object.entries(staged.run.pending))
          if (Date.now() >= p.notBefore && Date.now() < p.expiresAt) {
            const [e, a] = key.split(':');
            const exchange = z.enum(LIVE_EXCHANGES).parse(e),
              asset = z.enum(MARKET_ASSETS).parse(a);
            needed.set(key, { exchange, asset });
          }
      const entries = [...needed.entries()];
      for (let i = 0; i < entries.length; i += 5)
        await Promise.all(
          entries.slice(i, i + 5).map(async ([key, { exchange, asset }]) => {
            let market = this.markets.get(key) ?? { book: null, bars: null, instrument: null };
            try {
              if (
                !market.instrument ||
                Date.now() - market.instrument.source.receivedAt > 3600000
              ) {
                const instrument = await fetchLivePublic(exchange, asset, 'instrument');
                if (!('tick' in instrument)) throw Error('NEWS_INSTRUMENT_INVALID');
                market = { ...market, instrument };
              }
              const book = await fetchLivePublic(exchange, asset, 'book');
              if (!('bids' in book)) throw Error('NEWS_BOOK_INVALID');
              this.markets.set(key, { ...market, book });
              this.feedErrors.delete(key);
            } catch {
              this.markets.set(key, market);
              this.feedErrors.set(key, 'PUBLIC_QUOTE_OR_INSTRUMENT_UNAVAILABLE');
            }
          }),
        );
      const markets = entries.flatMap(([key]) => {
        const m = this.markets.get(key);
        return m ? [m] : [];
      });
      await this.store.change(async (current) => {
        if (!current || current.id !== run.id || current.revision !== run.revision)
          throw Error('NEWS_FORWARD_STATE_CHANGED');
        const latestSources = (
          await this.news.query<{ config: unknown; health: unknown }>(
            'SELECT config,health FROM crypto_news_live_v1.sources',
          )
        ).rows.map((r) => LiveNewsSourceView.parse(r));
        const next = stepNewsForward(
          fenceForwardPermissions(staged.run, latestSources, Date.now()),
          markets,
          Date.now(),
        );
        return {
          ...next,
          event: {
            ...next.event,
            newsDecisions: staged.decisions,
            processedVersions: observations.map((o) => o.version.id),
          },
        };
      }, true);
      this.lastTick = Date.now();
      this.error = null;
    } catch (e) {
      this.error = 'NEWS_FORWARD_TICK_FAILED';
      throw e;
    }
  }
  async overview(id?: string) {
    const run = await this.store.read(id),
      now = Date.now();
    return ForwardOverview.parse({
      version: 'news-forward.v1',
      execution: 'SIMULATED',
      asOf: now,
      worker: this.error
        ? 'ERROR'
        : this.lastTick && now - this.lastTick < 120000
          ? 'RUNNING'
          : 'STOPPED',
      error: this.error,
      run,
      runs: await this.store.listRuns(),
      feeds: LIVE_EXCHANGES.flatMap((exchange) =>
        MARKET_ASSETS.map((asset) => {
          const key = `${exchange}:${asset}`,
            m = this.markets.get(key);
          return {
            exchange,
            asset,
            book: m?.book ? { ...m.book, source: { ...m.book.source, raw: '' } } : null,
            instrument: m?.instrument
              ? { ...m.instrument, source: { ...m.instrument.source, raw: '' } }
              : null,
            bars: 0,
            lastBarAt: null,
            error: this.feedErrors.get(key) ?? null,
            updatedAt: m?.book?.source.receivedAt ?? 0,
          };
        }),
      ),
      summaries: run ? liveSummaries(run, now, [...this.markets.values()]) : [],
    });
  }
  async close() {
    await this.news.end();
    await this.store.close();
  }
}
export type ForwardState = LiveRun;
