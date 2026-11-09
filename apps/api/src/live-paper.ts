import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import {
  LIVE_ASSETS,
  LIVE_EXCHANGES,
  LiveOverviewSchema,
  LiveQuerySchema,
  LiveControlSchema,
  ShortV6MatrixSchema,
} from '@crypto/contracts';
import type { LiveFeed, LiveAsset, LiveQuery, LiveExchange } from '@crypto/contracts';
import { canonicalHash } from '@crypto/core';
import { LivePaperStore } from '@crypto/db';
import { fetchLivePublic, freshLiveBook } from '@crypto/connectors';
import { createLiveRun, stepLiveRun, liveSummaries } from '@crypto/paper';
import type { LiveMarket } from '@crypto/paper';
const MATRIX_ID = 'sha256:b314104b31d776fc8774ecad98d3062c70c31f3d703d0ed3fbb373b4aba23bad';
export async function liveEngineHash() {
  const paths = [
    '../../../packages/paper/src/live-paper-engine.ts',
    '../../../packages/connectors/src/live-paper-exchanges.ts',
    '../../../packages/contracts/src/live-paper.ts',
    '../../../packages/db/src/live-paper-store.ts',
    './live-paper.ts',
  ];
  return canonicalHash(
    await Promise.all(
      paths.map(async (path) => ({
        path,
        source: await readFile(new URL(path, import.meta.url), 'utf8'),
      })),
    ),
  );
}
export async function createLivePaperService(url: string, schema = 'crypto_live_paper_v1') {
  const matrix = ShortV6MatrixSchema.parse(
    JSON.parse(await readFile(`data/short-v6/matrices/${MATRIX_ID.slice(7)}.json`, 'utf8')),
  );
  if (canonicalHash(matrix) !== MATRIX_ID)
    throw new Error('Frozen strategy evidence integrity mismatch');
  const profiles = Object.fromEntries(
    LIVE_ASSETS.map((asset) => [
      asset,
      matrix.profiles.find((p) => p.asset === asset && p.strategy === 'V6'),
    ]),
  ) as Record<LiveAsset, unknown>;
  const engineHash = await liveEngineHash(),
    store = new LivePaperStore(url, schema);
  await store.migrate();
  if (!(await store.acquireWorker())) {
    await store.close();
    throw new Error('Another live-paper worker owns this database');
  }
  const slots: {
    exchange: LiveExchange;
    asset: LiveAsset;
    market: LiveMarket;
    error: string | null;
    nextBook: number;
    nextBars: number;
    nextInstrument: number;
    failures: number;
  }[] = LIVE_EXCHANGES.flatMap((exchange) =>
    LIVE_ASSETS.map((asset) => ({
      exchange,
      asset,
      market: { book: null, bars: null, instrument: null },
      error: null as string | null,
      nextBook: 0,
      nextBars: 0,
      nextInstrument: 0,
      failures: 0,
    })),
  );
  let timer: ReturnType<typeof setTimeout> | null = null,
    busy: Promise<void> | null = null,
    closing = false,
    workerError: string | null = null,
    lastHeartbeat = 0;
  const markets = () => slots.map((s) => ({ ...s.market, book: s.error ? null : s.market.book }));
  const feeds = (): LiveFeed[] =>
    slots.map((s) => ({
      exchange: s.exchange,
      asset: s.asset,
      book: s.market.book,
      instrument: s.market.instrument,
      bars: s.market.bars?.bars.length ?? 0,
      lastBarAt: s.market.bars?.bars.at(-1)?.at ?? null,
      error: s.error,
      updatedAt: s.market.book?.source.receivedAt ?? 0,
    }));
  async function poll() {
    try {
      await store.assertLease();
      await Promise.all(
        slots.map(async (slot) => {
          const now = Date.now();
          if (now < slot.nextBook) return;
          try {
            // At most three GETs per symbol on cold start; thereafter one book every five seconds.
            const book = await fetchLivePublic(slot.exchange, slot.asset, 'book');
            if (!('bids' in book)) throw new Error('Unexpected public quote response');
            slot.market.book = book;
            if (!freshLiveBook(book, Date.now()))
              throw new Error('Quote stale, delayed or exchange clock skewed');
            if (now >= slot.nextInstrument) {
              const metadata = await fetchLivePublic(slot.exchange, slot.asset, 'instrument');
              if (!('tick' in metadata)) throw new Error('Missing instrument metadata');
              slot.market.instrument = metadata;
              slot.nextInstrument = now + 3600000;
            }
            if (now >= slot.nextBars) {
              const bars = await fetchLivePublic(slot.exchange, slot.asset, 'bars');
              if (!('bars' in bars) || bars.bars.length < 224)
                throw new Error('Insufficient contiguous hourly warmup');
              slot.market.bars = bars;
              const last = bars.bars.at(-1)!;
              slot.nextBars = Math.max(Date.now() + 10000, last.at + 7200000 + 4000);
            }
            slot.error = null;
            slot.failures = 0;
            slot.nextBook = Date.now() + 4500;
          } catch {
            slot.failures++;
            slot.error =
              'Public feed unavailable, stale, delayed or invalid; entries and fills wait for fresh data.';
            slot.nextBook =
              Date.now() + Math.min(60000, 5000 * 2 ** Math.min(slot.failures - 1, 4));
          }
        }),
      );
      await store.assertLease();
      await store.change((current) => {
        if (!current || current.status === 'ENDED') return null;
        if (current.engineHash !== engineHash)
          throw new Error(
            'Active run requires its frozen engine version; restore that version before resuming',
          );
        return stepLiveRun(current, markets(), Date.now());
      }, true);
      workerError = null;
      lastHeartbeat = Date.now();
    } catch {
      workerError =
        'Worker or database unavailable, clock moved backwards, or active engine version changed. No new simulated fills are being committed.';
    }
  }
  async function cycle() {
    if (closing) return;
    busy = poll();
    await busy;
    busy = null;
    if (!closing)
      timer = setTimeout(() => {
        void cycle();
      }, 5000);
  }
  return {
    store,
    engineHash,
    startWorker() {
      if (!timer && !busy && !closing) void cycle();
    },
    async overview(id?: string) {
      const now = Date.now(),
        run = await store.read(id);
      const publicFeeds = feeds().map((f) => ({
        ...f,
        book: f.book ? { ...f.book, source: { ...f.book.source, raw: '' } } : null,
        instrument: f.instrument
          ? { ...f.instrument, source: { ...f.instrument.source, raw: '' } }
          : null,
      }));
      return LiveOverviewSchema.parse({
        version: 'live-paper.v1',
        execution: 'SIMULATED',
        asOf: now,
        worker: closing ? 'STOPPED' : workerError ? 'ERROR' : 'RUNNING',
        error:
          workerError ??
          (lastHeartbeat && now - lastHeartbeat > 30000 ? 'Worker heartbeat delayed' : null),
        run,
        runs: await store.listRuns(),
        feeds: publicFeeds,
        summaries: run ? liveSummaries(run, now, markets()) : [],
      });
    },
    async startRun() {
      await store.assertLease();
      if (
        workerError ||
        slots.some(
          (s) =>
            s.error ||
            !s.market.book ||
            !freshLiveBook(s.market.book, Date.now()) ||
            !s.market.instrument ||
            !s.market.bars ||
            s.market.bars.bars.length < 224 ||
            Date.now() - (s.market.bars.bars.at(-1)!.at + 3600000) > 3700000,
        )
      )
        throw new Error('All ten public feeds must be fresh and warmed up before starting');
      return store.change((current) => {
        if (current && current.status !== 'ENDED') throw new Error('A run is already active');
        const state = createLiveRun(Date.now(), profiles, engineHash, MATRIX_ID, markets());
        return {
          state,
          positions: [],
          sources: markets().flatMap((m) => [m.bars!.source, m.instrument!.source, m.book!.source]),
          event: { kind: 'START', state, origin: 'PUBLIC_LIVE', execution: 'SIMULATED' },
        };
      });
    },
    async control(action: 'PAUSE' | 'RESUME' | 'STOP') {
      return store.change((current) => {
        if (
          !current ||
          current.status === 'ENDED' ||
          current.status === 'STOPPING' ||
          current.engineHash !== engineHash
        )
          throw new Error('Run control unavailable');
        const state = structuredClone(current);
        state.heartbeatAt = Date.now();
        state.status = action === 'PAUSE' ? 'PAUSED' : action === 'RESUME' ? 'RUNNING' : 'STOPPING';
        state.pending = {};
        return {
          state,
          positions: [],
          sources: [],
          event: { kind: 'CONTROL', action, requestedAt: state.heartbeatAt },
        };
      });
    },
    async positions(q: LiveQuery, exporting = false) {
      return store.positions(q, exporting);
    },
    async close() {
      closing = true;
      if (timer) clearTimeout(timer);
      if (busy) await busy;
      await store.close();
    },
    async tickOnce() {
      await poll();
    },
  };
}
export type LivePaperService = Awaited<ReturnType<typeof createLivePaperService>>;
const columns = [
  'id',
  'runId',
  'exchange',
  'asset',
  'side',
  'strategy',
  'status',
  'lifecycle',
  'openedAt',
  'closedAt',
  'quantity',
  'remaining',
  'entry',
  'mark',
  'markAt',
  'notional',
  'stop',
  'target',
  'fees',
  'financing',
  'netPnl',
  'exitReason',
] as const;
export function liveExport(
  page: Awaited<ReturnType<LivePaperStore['positions']>>,
  q: LiveQuery,
  format: 'json' | 'csv' | 'tsv' | 'md',
) {
  if (format === 'json')
    return JSON.stringify(
      {
        version: 'live-paper-export.v1',
        execution: 'SIMULATED',
        snapshotUtc: new Date(page.asOf).toISOString(),
        filters: q,
        ...page,
      },
      null,
      2,
    );
  const cells = page.positions.map((p) =>
    columns.map((k) => {
      const value = p[k];
      return value === null
        ? ''
        : k === 'openedAt' || k === 'closedAt' || k === 'markAt'
          ? new Date(Number(value)).toISOString()
          : String(value);
    }),
  );
  const safe = (s: string) =>
    /^[\s]*[=+@-]/.test(s) && !/^-[0-9]+(\.[0-9]+)?$/.test(s) ? "'" + s : s;
  if (format === 'md')
    return `# Live paper positions\n\nSimulated execution. Snapshot: ${new Date(page.asOf).toISOString()}. Rows: ${page.total}.\n\nFilters: ${JSON.stringify(q)}\n\n| ${columns.join(' | ')} |\n| ${columns.map(() => '---').join(' | ')} |\n${cells.map((r) => '| ' + r.map((s) => s.replaceAll('|', '\\|').replaceAll('\n', ' ')).join(' | ') + ' |').join('\n')}\n`;
  const sep = format === 'csv' ? ',' : '\t',
    quote = (s: string) => '"' + safe(s).replaceAll('"', '""') + '"';
  return '\uFEFF' + [columns, ...cells].map((r) => r.map(quote).join(sep)).join('\r\n') + '\r\n';
}
export function registerLivePaperRoutes(app: FastifyInstance, service: LivePaperService) {
  app.get('/live-paper', async (req) =>
    service.overview(
      z.strictObject({ runId: z.string().uuid().optional() }).parse(req.query).runId,
    ),
  );
  app.post('/live-paper/start', async (req, reply) => {
    z.strictObject({}).parse(req.body);
    try {
      return await service.startRun();
    } catch {
      return reply.code(409).send({
        error: 'Start unavailable: wait for all ten feeds and warmup, or stop the active run.',
      });
    }
  });
  app.post('/live-paper/control', async (req, reply) => {
    const { action } = LiveControlSchema.parse(req.body);
    try {
      return await service.control(action);
    } catch {
      return reply.code(409).send({ error: 'Run control unavailable' });
    }
  });
  app.get('/live-paper/positions', async (req) =>
    service.positions(LiveQuerySchema.parse(req.query)),
  );
  app.get('/live-paper/evidence/:runId/:quoteId', async (req) => {
    const p = z
      .strictObject({ runId: z.string().uuid(), quoteId: z.string().uuid() })
      .parse(req.params);
    return service.store.evidence(p.runId, p.quoteId);
  });
  app.get('/live-paper/export/:format', async (req, reply) => {
    const { format } = z
        .strictObject({ format: z.enum(['json', 'csv', 'tsv', 'md']) })
        .parse(req.params),
      q = LiveQuerySchema.parse(req.query),
      page = await service.positions(q, true);
    reply.header('content-disposition', `attachment; filename="live-paper-${page.asOf}.${format}"`);
    reply.header('x-export-as-of', new Date(page.asOf).toISOString());
    reply.header('x-export-rows', String(page.total));
    return reply
      .type(
        {
          json: 'application/json',
          csv: 'text/csv; charset=utf-8',
          tsv: 'text/tab-separated-values; charset=utf-8',
          md: 'text/markdown; charset=utf-8',
        }[format],
      )
      .send(liveExport(page, q, format));
  });
}
