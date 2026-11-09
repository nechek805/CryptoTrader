import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import {
  HashSchema,
  SpecialistMatrixSchema,
  MarketReportSchema,
  SpecialistReportSchema,
  SpecialistV5ReportSchema,
  SpecialistV5MatrixSchema,
  SpecialistV5StateSchema,
  SpecialistV5FeesSchema,
  DEFAULT_SPECIALIST_V5_FEES,
  SpecialistAssetSchema,
  SpecialistV5KeySchema,
  SpecialistV5ViewSchema,
} from '@crypto/contracts';
import type { SpecialistV5Matrix, SpecialistReport } from '@crypto/contracts';
import { canonicalHash, canonicalJson } from '@crypto/core';
import { loadMarketHistory } from '@crypto/research';
import {
  SPECIALIST_V5_ENGINE_HASH,
  runSpecialistStrategy,
  verifySpecialistReport,
  runSpecialistV5,
  verifySpecialistV5Report,
  diagnoseSpecialistV5Trades,
  compareSpecialistV5Trades,
  specialistV5Baseline,
  searchSpecialistV5,
  verifyMarketReport,
  reconcileSpotJournal,
} from '@crypto/backtest';
import { D, amount } from '../../../packages/backtest/src/spot-math.js';

const Selection = z.strictObject({ asset: SpecialistAssetSchema, strategy: SpecialistV5KeySchema });
const Report = z.union([MarketReportSchema, SpecialistReportSchema, SpecialistV5ReportSchema]);
async function bounded(path: string) {
  const s = await lstat(path);
  if (!s.isFile() || s.size > 32000000) throw new Error('Specialist artifact rejected');
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}
async function atomic(path: string, value: unknown) {
  const tmp = path + '.' + randomUUID() + '.tmp';
  await writeFile(tmp, canonicalJson(value), { flag: 'wx' });
  await rename(tmp, path);
}
function diagnosis(asset: 'SOL' | 'XRP', v4: SpecialistReport) {
  return [
    `${asset} v4: ${v4.summary.netPnl} USDT net, ${v4.summary.closedTrades} closed trades and ${v4.summary.wins} wins, with fees on.`,
    asset === 'XRP'
      ? 'V4 had four winners. Its second trade exited at its 3.5 ATR target while the same exit candle had a much higher high. OHLC cannot establish the sequence after that exit. V5 tests a longer target only for a bounded range of completed signal-candle range/ATR, retaining the original target otherwise.'
      : 'V4 gave back large favorable moves: entry 2831 ultimately lost 14.84 USDT after trading above entry, and entry 1344 closed for only 8.47 USDT. V5 tests next-candle trailing protection and smaller targets for low-volatility entries in separate candidates.',
    'Excursions diagnosed from hourly OHLC do not establish tick order, and an exit candle high may follow the exit. Future excursions are never an entry feature. Targets use the completed signal candle; a trailing stop can change only after a completed close and applies to the following candle.',
    'Risk remains 0.25% per entry, allocation 10%, prior-volume participation 1%, with no leverage and the same daily loss limit. Fees are 0.1% per side; 0.05% adverse slippage per side plus tick rounding remains. Selection uses development net P&L under the same 2% drawdown ceiling, never later or full-period profits.',
  ];
}
export async function createSpecialistV5Service(
  root: string,
  marketRoot = join('data', 'market-strategy-tests'),
  v4Root = join('data', 'sol-xrp-lab'),
) {
  await mkdir(join(root, 'reports'), { recursive: true });
  await mkdir(join(root, 'matrices'), { recursive: true });
  let current: { id: string; matrix: SpecialistV5Matrix } | null = null,
    job: z.infer<typeof SpecialistV5StateSchema>['job'] = null,
    fees = { ...DEFAULT_SPECIALIST_V5_FEES },
    changing = false;
  try {
    fees = SpecialistV5FeesSchema.parse(await bounded(join(root, 'fees.json')));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  async function readReport(idInput: unknown) {
    const id = HashSchema.parse(idInput);
    let raw: unknown;
    try {
      raw = await bounded(join(root, 'reports', id.slice(7) + '.json'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      try {
        raw = await bounded(join(v4Root, 'reports', id.slice(7) + '.json'));
      } catch (parentError) {
        if ((parentError as NodeJS.ErrnoException).code !== 'ENOENT') throw parentError;
        raw = await bounded(join(marketRoot, 'reports', id.slice(7) + '.json'));
      }
    }
    const bundle = z
      .strictObject({ report: Report, journal: z.array(z.unknown()).max(30000) })
      .parse(raw);
    reconcileSpotJournal(bundle.journal);
    if (
      canonicalHash(bundle.report) !== id ||
      canonicalHash(bundle.journal) !== bundle.report.journalHash
    )
      throw new Error('Specialist report integrity mismatch');
    return bundle;
  }
  async function save(
    result: ReturnType<typeof runSpecialistStrategy> | ReturnType<typeof runSpecialistV5>,
  ) {
    const value = { report: result.report, journal: result.journal },
      path = join(root, 'reports', result.id.slice(7) + '.json');
    try {
      await writeFile(path, canonicalJson(value), { flag: 'wx' });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      if (canonicalHash(await bounded(path)) !== canonicalHash(value))
        throw new Error('Immutable specialist report differs', { cause: e });
    }
    return { reportId: result.id, summary: result.report.summary };
  }
  try {
    const p = z.strictObject({ id: HashSchema }).parse(await bounded(join(root, 'latest.json'))),
      matrix = SpecialistV5MatrixSchema.parse(
        await bounded(join(root, 'matrices', p.id.slice(7) + '.json')),
      );
    if (canonicalHash(matrix) !== p.id) throw new Error('Specialist matrix hash mismatch');
    if (matrix.engineHash === SPECIALIST_V5_ENGINE_HASH) {
      for (const row of matrix.rows) {
        const d = await loadMarketHistory(join(marketRoot, 'datasets'), row.datasetId);
        if (
          d.dataset.instrument.asset !== row.asset ||
          d.dataset.from !== matrix.from ||
          d.dataset.to !== matrix.to ||
          d.dataset.origin !== 'PUBLIC_HISTORICAL'
        )
          throw new Error('Specialist source mismatch');
        for (const mode of ['STANDARD', 'ZERO'] as const)
          for (const c of row.variants[mode]) {
            const r = (await readReport(c.reportId)).report;
            if (
              r.datasetId !== row.datasetId ||
              r.asset !== row.asset ||
              r.plan.strategy !== c.strategy ||
              r.plan.feeMode !== mode ||
              canonicalHash(r.summary) !== canonicalHash(c.summary)
            )
              throw new Error('Specialist matrix/report mismatch');
          }
      }
      current = { id: p.id, matrix };
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const state = () => SpecialistV5StateSchema.parse({ matrixId: current?.id ?? null, job, fees });
  function start() {
    if (changing) throw new Error('Wait for fee settings');
    if (job?.status === 'RUNNING') return { ...job };
    const next: NonNullable<typeof job> = {
      id: randomUUID(),
      status: 'RUNNING',
      message: 'Opening the frozen SOL and XRP history…',
      completed: 0,
      total: 2,
    };
    job = next;
    setImmediate(() => {
      void (async () => {
        try {
          const pointer = z
              .strictObject({ id: HashSchema })
              .parse(await bounded(join(v4Root, 'latest.json'))),
            source = SpecialistMatrixSchema.parse(
              await bounded(join(v4Root, 'matrices', pointer.id.slice(7) + '.json')),
            );
          if (canonicalHash(source) !== pointer.id || source.origin !== 'PUBLIC_HISTORICAL')
            throw new Error('Run the preserved v4 SOL/XRP comparison first');
          const rows: SpecialistV5Matrix['rows'] = [],
            splitIndex = source.splitIndex;
          for (const asset of ['SOL', 'XRP'] as const) {
            const original = source.rows.find((r) => r.asset === asset);
            if (!original?.datasetId) throw new Error('Selected coin has no verified history');
            const data = (await loadMarketHistory(join(marketRoot, 'datasets'), original.datasetId))
              .dataset;
            if (
              data.instrument.asset !== asset ||
              data.from !== source.from ||
              data.to !== source.to ||
              data.origin !== 'PUBLIC_HISTORICAL'
            )
              throw new Error('Coin dataset mismatch');
            const baseline = original.selected,
              baseResult = runSpecialistV5(data, specialistV5Baseline(asset)),
              reference = runSpecialistStrategy(data, baseline);
            for (const key of ['decisions', 'trades', 'summary', 'journalHash'] as const)
              if (
                canonicalHash(
                  key === 'decisions'
                    ? baseResult.report.decisions.map((decision) =>
                        Object.fromEntries(
                          Object.entries(decision).filter(([name]) => name !== 'targetAtrUsed'),
                        ),
                      )
                    : baseResult.report[key],
                ) !== canonicalHash(reference.report[key])
              )
                throw new Error('Specialist baseline compatibility mismatch');
            const search = await searchSpecialistV5(data, asset, splitIndex, (text) => {
                next.message = text;
              }),
              selected = search.selected.candidate;
            const searchRows: SpecialistV5Matrix['rows'][number]['search'] = [];
            for (const trial of search.trials) {
              const development = await save(trial.result);
              searchRows.push({
                candidate: trial.candidate,
                development,
                eligible: new D(trial.result.report.summary.maxDrawdown).lte('0.02'),
                selected: canonicalHash(trial.candidate) === canonicalHash(selected),
              });
            }
            const developmentBaseline = await save(
                runSpecialistStrategy(data, baseline, 'STANDARD', {
                  fromIndex: 0,
                  toIndex: splitIndex,
                }),
              ),
              checkBaseline = await save(
                runSpecialistStrategy(data, baseline, 'STANDARD', {
                  fromIndex: splitIndex,
                  toIndex: data.bars.length,
                }),
              ),
              checkSelected = await save(
                runSpecialistV5(data, selected, 'STANDARD', {
                  fromIndex: splitIndex,
                  toIndex: data.bars.length,
                }),
              );
            const variants: SpecialistV5Matrix['rows'][number]['variants'] = {
              STANDARD: [],
              ZERO: [],
            };
            for (const mode of ['STANDARD', 'ZERO'] as const) {
              for (const strategy of ['V1', 'V2', 'V3', 'V4'] as const) {
                const c = original.variants[mode].find((c) => c.strategy === strategy);
                if (!c) throw new Error('Original strategy report unavailable');
                const r = (await readReport(c.reportId)).report;
                if (
                  r.asset !== asset ||
                  r.datasetId !== original.datasetId ||
                  r.plan.strategy !== strategy ||
                  r.plan.feeMode !== mode
                )
                  throw new Error('Original coin report mismatch');
                variants[mode].push({
                  strategy,
                  reportId: c.reportId,
                  summary: c.summary,
                  attribution: c.attribution,
                  exposureFraction: c.exposureFraction,
                });
              }
              next.message = `${asset}: full-period v5 replay, fees ${mode === 'STANDARD' ? 'on' : 'off'}`;
              await new Promise<void>((resolve) => setImmediate(resolve));
              const result = runSpecialistV5(data, selected, mode);
              await save(result);
              variants[mode].push({
                strategy: 'V5',
                reportId: result.id,
                summary: result.report.summary,
                attribution: diagnoseSpecialistV5Trades(result.report),
                exposureFraction: amount(
                  new D(result.report.decisions.filter((d) => new D(d.position).gt(0)).length)
                    .div(data.bars.length)
                    .toDecimalPlaces(12),
                ),
              });
            }
            const v4 = SpecialistReportSchema.parse(
              (await readReport(variants.STANDARD.find((c) => c.strategy === 'V4')!.reportId))
                .report,
            );
            const v5 = SpecialistV5ReportSchema.parse(
              (await readReport(variants.STANDARD.find((c) => c.strategy === 'V5')!.reportId))
                .report,
            );
            rows.push({
              asset,
              datasetId: original.datasetId,
              baseline: 'V4',
              selected,
              diagnosis: diagnosis(asset, v4),
              tradeChanges: compareSpecialistV5Trades(v4, v5),
              search: searchRows,
              development: {
                fromIndex: 0,
                toIndex: splitIndex,
                baseline: developmentBaseline,
                selected: {
                  reportId: search.selected.result.id,
                  summary: search.selected.result.report.summary,
                },
              },
              check: {
                fromIndex: splitIndex,
                toIndex: data.bars.length,
                baseline: checkBaseline,
                selected: checkSelected,
              },
              variants,
            });
            next.completed++;
          }
          const matrix = SpecialistV5MatrixSchema.parse({
              version: 'sol-xrp-v5.v1',
              origin: 'PUBLIC_HISTORICAL',
              engineHash: SPECIALIST_V5_ENGINE_HASH,
              generatedAt: new Date().toISOString(),
              sourceMatrixId: source.sourceMatrixId,
              sourceV4MatrixId: pointer.id,
              from: source.from,
              to: source.to,
              splitIndex,
              initialUsdt: '10000',
              interval: '1h',
              selection: 'DEVELOPMENT_NET_PNL_FIXED_RISK_NOT_GLOBAL_OPTIMUM',
              historyUse: 'PREVIOUSLY_SEEN_HISTORY_EXPLORATORY_CHECK',
              candidatesPerCoin: 12,
              candidateCounts: { SOL: 18, XRP: 13 },
              searchNotes: [
                'V5 registered grid: 18 SOL candidates (12 target/trailing profiles and 6 separate low-volatility target profiles) and 13 XRP candidates (baseline plus 12 conditional target profiles). All 31 development trials are retained.',
                'Earlier v4 research already tried 12 SOL and 24 XRP candidates. This round adds 31 trials, for 67 disclosed specialist trials, plus prior v1-v3 research and asset selection. This count is not the total historical research effort.',
                'Selection uses development fees-on net P&L only, with fixed risk and a 2% development drawdown ceiling. Ties prefer fewer trades, then no extra exit rule, then a narrower XRP extension window, then a deterministic candidate hash.',
                'Both the history and later check were previously seen. Full-period improvement is descriptive and is not independent forward validation or evidence of maximum possible profit.',
              ],
              rows,
            }),
            id = canonicalHash(matrix),
            path = join(root, 'matrices', id.slice(7) + '.json');
          try {
            await writeFile(path, canonicalJson(matrix), { flag: 'wx' });
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
            if (canonicalHash(await bounded(path)) !== id)
              throw new Error('Specialist matrix already differs', { cause: e });
          }
          await atomic(join(root, 'latest.json'), { id });
          current = { id, matrix };
          next.status = 'DONE';
          next.message =
            'SOL and XRP v5 comparisons completed, preserving v1-v4. Fees-on development selection and later checks are visible.';
        } catch (e) {
          next.status = 'FAILED';
          next.message =
            e instanceof Error ? e.message : 'Specialist research failed; prior results retained';
        }
      })();
    });
    return { ...next };
  }
  async function selected(input: unknown) {
    const { asset, strategy } = Selection.parse(input),
      matrix = current?.matrix,
      row = matrix?.rows.find((r) => r.asset === asset),
      mode = fees[strategy] ? 'STANDARD' : 'ZERO',
      cell = row?.variants[mode].find((c) => c.strategy === strategy);
    if (!row || !cell || !matrix) throw new Error('Run the specialist test first');
    const data = (await loadMarketHistory(join(marketRoot, 'datasets'), row.datasetId)).dataset,
      result = await readReport(cell.reportId);
    if (
      result.report.asset !== asset ||
      result.report.datasetId !== row.datasetId ||
      result.report.plan.strategy !== strategy ||
      result.report.plan.feeMode !== mode ||
      canonicalHash(result.report.summary) !== canonicalHash(cell.summary)
    )
      throw new Error('Selected specialist report mismatch');
    return { data, result, cell };
  }
  return {
    state,
    start,
    matrix: () => current,
    async setFees(input: unknown) {
      if (job?.status === 'RUNNING' || changing)
        throw new Error('Wait for the active research job');
      changing = true;
      try {
        const next = SpecialistV5FeesSchema.parse(input);
        await atomic(join(root, 'fees.json'), next);
        fees = next;
        return state();
      } finally {
        changing = false;
      }
    },
    async report(input: unknown) {
      const { data, result, cell } = await selected(input),
        { bars, captures, ...dataset } = data;
      return SpecialistV5ViewSchema.parse({
        id: cell.reportId,
        report: result.report,
        attribution: cell.attribution,
        dataset,
        bars,
        sources: [data.instrument.metadata, ...captures].map(({ url, receivedAt, hash }) => ({
          url,
          receivedAt,
          hash,
        })),
      });
    },
    async verify(input: unknown) {
      const { data, result, cell } = await selected(input);
      const rebuilt =
        result.report.version === 'specialist-v5-replay.v1'
          ? verifySpecialistV5Report(result.report, data)
          : result.report.version === 'specialist-replay.v1'
            ? verifySpecialistReport(result.report, data)
            : verifyMarketReport(result.report, data);
      if (
        rebuilt.id !== cell.reportId ||
        canonicalHash(rebuilt.journal) !== canonicalHash(result.journal)
      )
        throw new Error('Specialist journal replay mismatch');
      return { verified: true as const, reportId: cell.reportId };
    },
  };
}
export type SpecialistV5Service = Awaited<ReturnType<typeof createSpecialistV5Service>>;
export function registerSpecialistV5Routes(app: FastifyInstance, service: SpecialistV5Service) {
  app.get('/specialist-v5', () => service.state());
  app.get(
    '/specialist-v5/matrix',
    (_, reply) => service.matrix() ?? reply.code(404).send({ error: 'NO_SPECIALIST_RESULTS' }),
  );
  app.post('/specialist-v5/run', (req) => {
    z.strictObject({}).parse(req.body);
    return service.start();
  });
  app.post('/specialist-v5/fees', (req, reply) => {
    const { fees } = z.strictObject({ fees: SpecialistV5FeesSchema }).parse(req.body);
    if (service.state().job?.status === 'RUNNING')
      return reply.code(409).send({ error: 'RESEARCH_BUSY' });
    return service.setFees(fees);
  });
  app.get('/specialist-v5/report', (req) => service.report(Selection.parse(req.query)));
  app.post('/specialist-v5/verify', (req) => service.verify(Selection.parse(req.body)));
  app.get('/specialist-v5/export', (_, reply) => {
    const matrix = service.matrix();
    if (!matrix) return reply.code(404).send({ error: 'NO_RESULTS' });
    reply.header('content-disposition', 'attachment; filename="sol-xrp-v5-research.json"');
    return { ...matrix, fees: service.state().fees };
  });
  app.get('/specialist-v5/report-export', async (req, reply) => {
    const result = await service.report(Selection.parse(req.query));
    reply.header(
      'content-disposition',
      `attachment; filename="${result.report.asset}-${result.report.plan.strategy}.json"`,
    );
    return result;
  });
}
