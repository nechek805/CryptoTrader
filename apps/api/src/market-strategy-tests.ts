import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, lstat, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  HashSchema,
  MarketAssetSchema,
  MarketStrategyKeySchema,
  MarketMatrixSchema,
  MarketReportSchema,
  MarketRowSchema,
  MarketStateSchema,
  MarketReportViewSchema,
  MarketFeesSchema,
  DEFAULT_MARKET_FEES,
} from '@crypto/contracts';
import type { MarketMatrix, MarketReport, MarketHistory } from '@crypto/contracts';
import { canonicalHash, canonicalJson } from '@crypto/core';
import { prepareMarketTestInputs, loadMarketHistory } from '@crypto/research';
import {
  MARKET_ENGINE_HASH,
  MARKET_STRATEGY_CATALOG,
  runMarketStrategy,
  verifyMarketReport,
  diagnoseMarketTrades,
  reconcileSpotJournal,
  runBtcTest,
  runBtcRevision,
  runBtcThirdRevision,
  selectMarketFees,
} from '@crypto/backtest';
import { D, amount } from '../../../packages/backtest/src/spot-math.js';

const Selection = z.strictObject({ asset: MarketAssetSchema, strategy: MarketStrategyKeySchema });
const Bundle = z.strictObject({
  report: MarketReportSchema,
  journal: z.array(z.unknown()).max(30000),
});
const yieldWork = () => new Promise<void>((resolve) => setImmediate(resolve));
const sources = (dataset: MarketHistory) =>
  [dataset.instrument.metadata, ...dataset.captures].map(({ url, receivedAt, hash }) => ({
    url,
    receivedAt,
    hash,
  }));
export async function createMarketStrategyService(
  root: string,
  btcRoot = join('data', 'btc-market-test', 'datasets'),
) {
  await Promise.all(
    ['reports', 'matrices'].map((dir) => mkdir(join(root, dir), { recursive: true })),
  );
  let current: { id: string; matrix: MarketMatrix } | null = null;
  let job: z.infer<typeof MarketStateSchema>['job'] = null;
  let fees = { ...DEFAULT_MARKET_FEES },
    feeChangeBusy = false;
  async function bounded(path: string) {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size > 32000000) throw new Error('Invalid market research artifact');
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  }
  async function immutable(dir: string, id: string, value: unknown) {
    const path = join(root, dir, HashSchema.parse(id).slice(7) + '.json');
    try {
      await writeFile(path, canonicalJson(value), { flag: 'wx' });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      if (canonicalHash(await bounded(path)) !== canonicalHash(value))
        throw new Error('Existing research artifact differs', { cause: e });
    }
  }
  async function atomic(path: string, value: unknown) {
    const temporary = path + '.' + randomUUID() + '.tmp';
    await writeFile(temporary, canonicalJson(value), { flag: 'wx' });
    await rename(temporary, path);
  }
  async function publish(matrix: MarketMatrix) {
    const id = canonicalHash(matrix);
    await immutable('matrices', id, matrix);
    await atomic(join(root, 'latest.json'), { id });
    return { id, matrix };
  }
  try {
    fees = MarketFeesSchema.parse(await bounded(join(root, 'fees.json')));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  async function readReport(id: string) {
    const result = Bundle.parse(
      await bounded(join(root, 'reports', HashSchema.parse(id).slice(7) + '.json')),
    );
    reconcileSpotJournal(result.journal);
    if (
      canonicalHash(result.report) !== id ||
      canonicalHash(result.journal) !== result.report.journalHash ||
      result.report.engineHash !== MARKET_ENGINE_HASH
    )
      throw new Error('Market report integrity mismatch');
    return result;
  }
  function validateCell(
    report: MarketReport,
    cell: MarketMatrix['rows'][number]['cells'][number],
    row: MarketMatrix['rows'][number],
    mode: 'STANDARD' | 'ZERO',
  ) {
    if (
      report.asset !== row.asset ||
      report.datasetId !== row.datasetId ||
      report.plan.strategy !== cell.strategy ||
      (report.plan.feeMode ?? 'STANDARD') !== mode ||
      canonicalHash(report.summary) !== canonicalHash(cell.summary) ||
      canonicalHash(diagnoseMarketTrades(report)) !== canonicalHash(cell.attribution)
    )
      throw new Error('Market matrix/report mismatch');
  }
  try {
    const pointer = z
        .strictObject({ id: HashSchema })
        .parse(await bounded(join(root, 'latest.json'))),
      matrix = MarketMatrixSchema.parse(
        await bounded(join(root, 'matrices', pointer.id.slice(7) + '.json')),
      );
    if (canonicalHash(matrix) !== pointer.id) throw new Error('Market matrix integrity mismatch');
    if (matrix.engineHash === MARKET_ENGINE_HASH) {
      if (matrix.origin !== 'PUBLIC_HISTORICAL')
        throw new Error('The real market workspace cannot load a synthetic matrix');
      for (const row of matrix.rows.filter((r) => r.status === 'COMPLETE')) {
        const data = await loadMarketHistory(join(root, 'datasets'), row.datasetId);
        if (
          data.dataset.instrument.asset !== row.asset ||
          data.dataset.from !== matrix.from ||
          data.dataset.to !== matrix.to ||
          data.dataset.origin !== 'PUBLIC_HISTORICAL' ||
          canonicalHash(sources(data.dataset)) !== canonicalHash(row.sources) ||
          canonicalHash(data.dataset.instrument.filters) !== canonicalHash(row.filters)
        )
          throw new Error('Market matrix source mismatch');
        const candidates = matrix.feeVariants
          ? (['STANDARD', 'ZERO'] as const).flatMap((mode) => {
              const variant = matrix.feeVariants![mode].find((r) => r.asset === row.asset);
              return variant?.status === 'COMPLETE'
                ? variant.cells.map((cell) => ({ cell, mode }))
                : [];
            })
          : row.cells.map((cell) => ({
              cell,
              mode:
                matrix.fees?.[cell.strategy] === false || matrix.feeMode === 'ZERO'
                  ? ('ZERO' as const)
                  : ('STANDARD' as const),
            }));
        for (const { cell, mode } of candidates)
          validateCell((await readReport(cell.reportId)).report, cell, row, mode);
      }
      current = { id: pointer.id, matrix };
      if (matrix.feeVariants) current = await publish(selectMarketFees(matrix, fees));
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const state = () => MarketStateSchema.parse({ matrixId: current?.id ?? null, job, fees });
  async function setFees(input: unknown) {
    const next = MarketFeesSchema.parse(input);
    if (job?.status === 'RUNNING' || feeChangeBusy)
      throw new Error('Wait for the current market research change');
    feeChangeBusy = true;
    try {
      const selected = current ? await publish(selectMarketFees(current.matrix, next)) : null;
      await atomic(join(root, 'fees.json'), next);
      fees = next;
      if (selected) current = selected;
      return state();
    } finally {
      feeChangeBusy = false;
    }
  }
  function start() {
    if (feeChangeBusy) throw new Error('Wait for the fee selection to finish');
    if (job?.status === 'RUNNING') return { ...job };
    const next: NonNullable<typeof job> = {
      id: randomUUID(),
      status: 'RUNNING',
      message: 'Checking the frozen BTC window and public market snapshots…',
      completedAssets: 0,
      totalAssets: 10,
    };
    job = next;
    const runFees = { ...fees };
    setImmediate(() => {
      void (async () => {
        try {
          const input = await prepareMarketTestInputs(root, btcRoot, (message) => {
              next.message = message;
            }),
            variants: NonNullable<MarketMatrix['feeVariants']> = { STANDARD: [], ZERO: [] };
          for (const source of input.rows) {
            const { asset, dataset, datasetId } = source;
            for (const feeMode of ['STANDARD', 'ZERO'] as const) {
              try {
                if (!dataset || !datasetId)
                  throw new Error(source.error ?? 'Missing verified candles');
                const cells: MarketMatrix['rows'][number]['cells'] = [];
                for (const strategy of ['V1', 'V2', 'V3'] as const) {
                  next.message = `${asset} / ${strategy} / fees ${feeMode === 'STANDARD' ? 'on' : 'off'}: replaying ${dataset.bars.length} completed hourly candles`;
                  await yieldWork();
                  const result = runMarketStrategy(dataset, strategy, feeMode);
                  if (asset === 'BTC' && feeMode === 'STANDARD') {
                    const original =
                      strategy === 'V1'
                        ? runBtcTest(input.anchor.dataset)
                        : strategy === 'V2'
                          ? runBtcRevision(input.anchor.dataset)
                          : runBtcThirdRevision(input.anchor.dataset);
                    // Preserve the original paid-fee engine compatibility check separately.
                    const compatibility = result;
                    const { openBase, ...summary } = compatibility.report.summary;
                    const semantic = {
                      decisions: compatibility.report.decisions.map(({ position, ...d }) => ({
                        ...d,
                        btc: position,
                      })),
                      trades: compatibility.report.trades,
                      summary: { ...summary, openBtc: openBase },
                      journalHash: compatibility.report.journalHash,
                    };
                    if (
                      canonicalHash(semantic) !==
                      canonicalHash({
                        decisions: original.report.decisions,
                        trades: original.report.trades,
                        summary: original.report.summary,
                        journalHash: original.report.journalHash,
                      })
                    )
                      throw new Error('BTC reference reproduction failed');
                  }
                  await immutable('reports', result.id, {
                    report: result.report,
                    journal: result.journal,
                  });
                  const gateCounts: Record<string, number> = {};
                  for (const d of result.report.decisions) {
                    if (d.entryGate) gateCounts[d.entryGate] = (gateCounts[d.entryGate] ?? 0) + 1;
                  }
                  cells.push({
                    strategy,
                    reportId: result.id,
                    summary: result.report.summary,
                    attribution: diagnoseMarketTrades(result.report),
                    exposureFraction: amount(
                      new D(result.report.decisions.filter((d) => new D(d.position).gt(0)).length)
                        .div(dataset.bars.length)
                        .toDecimalPlaces(12),
                    ),
                    gateCounts,
                  });
                }
                variants[feeMode].push(
                  MarketRowSchema.parse({
                    asset,
                    datasetId,
                    status: 'COMPLETE',
                    error: null,
                    candles: dataset.bars.length,
                    filters: dataset.instrument.filters,
                    sources: sources(dataset),
                    cells,
                    btcReferenceReproduced: asset === 'BTC' ? true : null,
                  }),
                );
              } catch (e) {
                variants[feeMode].push(
                  MarketRowSchema.parse({
                    asset,
                    datasetId,
                    status: 'FAILED',
                    error: e instanceof Error ? e.message : 'Market replay failed',
                    candles: dataset?.bars.length ?? 0,
                    filters: dataset?.instrument.filters ?? null,
                    sources: dataset ? sources(dataset) : [],
                    cells: [],
                    btcReferenceReproduced: null,
                  }),
                );
              }
            }
            next.completedAssets++;
            await yieldWork();
          }
          const matrix = selectMarketFees(
            MarketMatrixSchema.parse({
              version: 'market-matrix.v1',
              feeMode: 'STANDARD',
              feeVariants: variants,
              engineHash: MARKET_ENGINE_HASH,
              from: input.anchor.dataset.from,
              to: input.anchor.dataset.to,
              referenceBtcDatasetId: input.anchor.id,
              initialUsdt: '10000',
              interval: '1h',
              origin: 'PUBLIC_HISTORICAL',
              rows: variants.STANDARD,
              cash: {
                asset: 'USDT',
                equity: '10000',
                netPnl: '0',
                trades: 0,
                interpretation: 'QUOTE_CURRENCY_UNITS_NOT_USD_PEG_TEST',
              },
              strategyCount: 3,
              revisions: 2,
              selection: 'FIXED_CURRENT_UNIVERSE_NOT_HISTORICAL_RANKING',
            }),
            runFees,
          );
          current = await publish(matrix);
          next.status = 'DONE';
          next.message = `Completed ${matrix.rows.filter((r) => r.status === 'COMPLETE').length}/10 markets with fees on/off ready to switch. ${matrix.rows.filter((r) => r.status === 'FAILED').length} failed markets remain visible.`;
        } catch {
          next.status = 'FAILED';
          next.message =
            'Research job failed. Existing results are retained; check BTC history and retry.';
        }
      })();
    });
    return { ...next };
  }
  async function selected(input: unknown) {
    const { asset, strategy } = Selection.parse(input),
      selectedMatrix = current?.matrix,
      row = selectedMatrix?.rows.find((r) => r.asset === asset),
      cell = row?.cells.find((c) => c.strategy === strategy);
    if (!row || !cell || row.status !== 'COMPLETE')
      throw new Error('No completed report for this market and strategy');
    const result = await readReport(cell.reportId),
      data = await loadMarketHistory(join(root, 'datasets'), row.datasetId);
    validateCell(
      result.report,
      cell,
      row,
      selectedMatrix!.fees?.[strategy] === false ? 'ZERO' : 'STANDARD',
    );
    if (
      result.report.datasetId !== data.id ||
      result.report.asset !== data.dataset.instrument.asset
    )
      throw new Error('Selected report source mismatch');
    return { result, data, cell };
  }
  return {
    state,
    start,
    setFees,
    matrix: () => current,
    catalog: () => MARKET_STRATEGY_CATALOG,
    async report(input: unknown) {
      const { result, data, cell } = await selected(input),
        { captures, bars, ...dataset } = data.dataset;
      void captures;
      return MarketReportViewSchema.parse({
        id: cell.reportId,
        report: result.report,
        attribution: cell.attribution,
        dataset,
        bars,
        sources: sources(data.dataset),
      });
    },
    async verify(input: unknown) {
      const { result, data, cell } = await selected(input),
        rebuilt = verifyMarketReport(result.report, data.dataset);
      if (
        canonicalHash(result.journal) !== canonicalHash(rebuilt.journal) ||
        cell.reportId !== rebuilt.id
      )
        throw new Error('Market journal replay mismatch');
      return { verified: true as const, reportId: rebuilt.id };
    },
  };
}
export type MarketStrategyService = Awaited<ReturnType<typeof createMarketStrategyService>>;
export function registerMarketStrategyRoutes(app: FastifyInstance, service: MarketStrategyService) {
  app.get('/market-strategies', () => service.state());
  app.get('/market-strategies/catalog', () => service.catalog());
  app.get(
    '/market-strategies/matrix',
    (_, reply) => service.matrix() ?? reply.code(404).send({ error: 'NO_MATRIX' }),
  );
  app.post('/market-strategies/run', (req) => {
    z.strictObject({}).parse(req.body);
    return service.start();
  });
  app.post('/market-strategies/fees', async (req, reply) => {
    const { fees } = z.strictObject({ fees: MarketFeesSchema }).parse(req.body);
    if (service.state().job?.status === 'RUNNING')
      return reply.code(409).send({ error: 'RESEARCH_BUSY' });
    return service.setFees(fees);
  });
  app.get('/market-strategies/report', (req) => service.report(Selection.parse(req.query)));
  app.post('/market-strategies/verify', (req) => service.verify(Selection.parse(req.body)));
  app.get('/market-strategies/export', (_, reply) => {
    const value = service.matrix();
    if (!value) return reply.code(404).send({ error: 'NO_MATRIX' });
    reply.header('content-disposition', 'attachment; filename="market-strategy-matrix.json"');
    return value;
  });
  app.get('/market-strategies/report-export', async (req, reply) => {
    const value = await service.report(Selection.parse(req.query));
    reply.header(
      'content-disposition',
      `attachment; filename="${value.report.asset}-${value.report.plan.strategy}-market-test.json"`,
    );
    return value;
  });
}
