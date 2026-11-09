import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import {
  HashSchema,
  MarketMatrixSchema,
  MarketReportSchema,
  SpecialistReportSchema,
  SpecialistMatrixSchema,
  SpecialistStateSchema,
  SpecialistFeesSchema,
  DEFAULT_SPECIALIST_FEES,
  SpecialistAssetSchema,
  SpecialistKeySchema,
  SpecialistViewSchema,
} from '@crypto/contracts';
import type { SpecialistMatrix, MarketReport } from '@crypto/contracts';
import { canonicalHash, canonicalJson } from '@crypto/core';
import { loadMarketHistory } from '@crypto/research';
import {
  SPECIALIST_ENGINE_HASH,
  runSpecialistStrategy,
  verifySpecialistReport,
  diagnoseSpecialistTrades,
  specialistBaseline,
  searchSpecialist,
  runMarketStrategy,
  verifyMarketReport,
  reconcileSpotJournal,
} from '@crypto/backtest';
import { D, amount } from '../../../packages/backtest/src/spot-math.js';

const Selection = z.strictObject({ asset: SpecialistAssetSchema, strategy: SpecialistKeySchema });
const Report = z.union([MarketReportSchema, SpecialistReportSchema]);
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
function diagnosis(asset: 'SOL' | 'XRP', v2: MarketReport, v3: MarketReport) {
  const pairs = (r: MarketReport) => {
    let entry: MarketReport['trades'][number] | null = null;
    const rows: { entry: number; net: InstanceType<typeof D> }[] = [];
    for (const t of r.trades) {
      if (t.side === 'BUY') entry = t;
      else if (entry) {
        rows.push({
          entry: entry.index,
          net: new D(t.quantity)
            .mul(t.price)
            .minus(t.fee)
            .minus(new D(entry.quantity).mul(entry.price))
            .minus(entry.fee),
        });
        entry = null;
      }
    }
    return rows;
  };
  const second = pairs(v2),
    third = pairs(v3),
    removed = second.filter((t) => !third.some((s) => s.entry === t.entry)),
    wins = removed.filter((t) => t.net.gt(0)),
    losses = removed.filter((t) => t.net.lte(0));
  return [
    `${asset} v2: ${v2.summary.netPnl} USDT, ${v2.summary.closedTrades} closed trades, ${v2.summary.wins} wins. V3: ${v3.summary.netPnl} USDT, ${v3.summary.closedTrades} closed trades, ${v3.summary.wins} wins.`,
    `V3 excluded ${wins.length} winning v2 entries (${amount(wins.reduce((s, t) => s.plus(t.net), new D(0)))} USDT) and ${losses.length} losing v2 entries (${amount(losses.reduce((s, t) => s.plus(t.net), new D(0)))} USDT). Recorded amounts are from v2; later position sizes can differ.`,
    asset === 'XRP'
      ? 'XRP v4 retains v3’s upper-half close and maximum 2 ATR signal range. Its bounded search changes target distance and the MA200 slope lookback.'
      : 'SOL v4 starts from v2 and does not require an upper-half close: that gate rejected profitable SOL entries. Its bounded search changes stop and target distance.',
    'Every candidate keeps 0.25% risk, 10% allocation, 1% prior-volume participation, no leverage and the existing daily loss limit. Selection maximizes development net P&L within the disclosed coin-specific grid and a 2% development drawdown ceiling.',
  ];
}
export async function createSpecialistService(
  root: string,
  marketRoot = join('data', 'market-strategy-tests'),
) {
  await mkdir(join(root, 'reports'), { recursive: true });
  await mkdir(join(root, 'matrices'), { recursive: true });
  let current: { id: string; matrix: SpecialistMatrix } | null = null,
    job: z.infer<typeof SpecialistStateSchema>['job'] = null,
    fees = { ...DEFAULT_SPECIALIST_FEES },
    changing = false;
  try {
    fees = SpecialistFeesSchema.parse(await bounded(join(root, 'fees.json')));
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
      raw = await bounded(join(marketRoot, 'reports', id.slice(7) + '.json'));
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
  async function save(result: ReturnType<typeof runSpecialistStrategy>) {
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
      matrix = SpecialistMatrixSchema.parse(
        await bounded(join(root, 'matrices', p.id.slice(7) + '.json')),
      );
    if (canonicalHash(matrix) !== p.id) throw new Error('Specialist matrix hash mismatch');
    if (matrix.engineHash === SPECIALIST_ENGINE_HASH) {
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
  const state = () => SpecialistStateSchema.parse({ matrixId: current?.id ?? null, job, fees });
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
              .parse(await bounded(join(marketRoot, 'latest.json'))),
            source = MarketMatrixSchema.parse(
              await bounded(join(marketRoot, 'matrices', pointer.id.slice(7) + '.json')),
            );
          if (
            canonicalHash(source) !== pointer.id ||
            source.origin !== 'PUBLIC_HISTORICAL' ||
            !source.feeVariants
          )
            throw new Error('Run the real multi-market fee comparison first');
          const rows: SpecialistMatrix['rows'] = [],
            splitIndex = Math.floor((((source.to - source.from) / 3600000) * 2) / 3);
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
            const baseline = specialistBaseline(asset),
              baseResult = runSpecialistStrategy(data, baseline),
              reference = runMarketStrategy(data, baseline.base);
            for (const key of ['decisions', 'trades', 'summary', 'journalHash'] as const)
              if (canonicalHash(baseResult.report[key]) !== canonicalHash(reference.report[key]))
                throw new Error('Specialist baseline compatibility mismatch');
            const search = await searchSpecialist(data, asset, splitIndex, (text) => {
                next.message = text;
              }),
              selected = search.selected.candidate;
            const searchRows: SpecialistMatrix['rows'][number]['search'] = [];
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
                runSpecialistStrategy(data, selected, 'STANDARD', {
                  fromIndex: splitIndex,
                  toIndex: data.bars.length,
                }),
              );
            const variants: SpecialistMatrix['rows'][number]['variants'] = {
              STANDARD: [],
              ZERO: [],
            };
            for (const mode of ['STANDARD', 'ZERO'] as const) {
              for (const strategy of ['V1', 'V2', 'V3'] as const) {
                const c = source.feeVariants[mode]
                  .find((r) => r.asset === asset)
                  ?.cells.find((c) => c.strategy === strategy);
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
              next.message = `${asset}: full-period v4 replay, fees ${mode === 'STANDARD' ? 'on' : 'off'}`;
              await new Promise<void>((resolve) => setImmediate(resolve));
              const result = runSpecialistStrategy(data, selected, mode);
              await save(result);
              variants[mode].push({
                strategy: 'V4',
                reportId: result.id,
                summary: result.report.summary,
                attribution: diagnoseSpecialistTrades(result.report),
                exposureFraction: amount(
                  new D(result.report.decisions.filter((d) => new D(d.position).gt(0)).length)
                    .div(data.bars.length)
                    .toDecimalPlaces(12),
                ),
              });
            }
            const v2 = (
                await readReport(variants.STANDARD.find((c) => c.strategy === 'V2')!.reportId)
              ).report as MarketReport,
              v3 = (await readReport(variants.STANDARD.find((c) => c.strategy === 'V3')!.reportId))
                .report as MarketReport;
            rows.push({
              asset,
              datasetId: original.datasetId,
              baseline: baseline.base,
              selected,
              diagnosis: diagnosis(asset, v2, v3),
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
          const matrix = SpecialistMatrixSchema.parse({
              version: 'sol-xrp-lab.v1',
              origin: 'PUBLIC_HISTORICAL',
              engineHash: SPECIALIST_ENGINE_HASH,
              generatedAt: new Date().toISOString(),
              sourceMatrixId: pointer.id,
              from: source.from,
              to: source.to,
              splitIndex,
              initialUsdt: '10000',
              interval: '1h',
              selection: 'DEVELOPMENT_NET_PNL_FIXED_RISK_NOT_GLOBAL_OPTIMUM',
              historyUse: 'PREVIOUSLY_SEEN_HISTORY_EXPLORATORY_CHECK',
              candidatesPerCoin: 12,
              candidateCounts: { SOL: 12, XRP: 24 },
              searchNotes: [
                'Initial grid: 12 candidates per coin. SOL improved; XRP did not improve on v3.',
                'XRP development records showed low signal range on its losing entry. Twelve additional predeclared minimum-impulse/target candidates were added. All 24 XRP trials are retained.',
                'Selection uses only development net P&L with fixed risk. Later check data was already seen in prior research; this is not independent forward validation.',
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
            'SOL and XRP v4 comparisons completed. Selection used development data only; later checks remain visible.';
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
        const next = SpecialistFeesSchema.parse(input);
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
      return SpecialistViewSchema.parse({
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
        result.report.version === 'specialist-replay.v1'
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
export type SpecialistService = Awaited<ReturnType<typeof createSpecialistService>>;
export function registerSpecialistRoutes(app: FastifyInstance, service: SpecialistService) {
  app.get('/specialist-tests', () => service.state());
  app.get(
    '/specialist-tests/matrix',
    (_, reply) => service.matrix() ?? reply.code(404).send({ error: 'NO_SPECIALIST_RESULTS' }),
  );
  app.post('/specialist-tests/run', (req) => {
    z.strictObject({}).parse(req.body);
    return service.start();
  });
  app.post('/specialist-tests/fees', (req, reply) => {
    const { fees } = z.strictObject({ fees: SpecialistFeesSchema }).parse(req.body);
    if (service.state().job?.status === 'RUNNING')
      return reply.code(409).send({ error: 'RESEARCH_BUSY' });
    return service.setFees(fees);
  });
  app.get('/specialist-tests/report', (req) => service.report(Selection.parse(req.query)));
  app.post('/specialist-tests/verify', (req) => service.verify(Selection.parse(req.body)));
  app.get('/specialist-tests/export', (_, reply) => {
    const matrix = service.matrix();
    if (!matrix) return reply.code(404).send({ error: 'NO_RESULTS' });
    reply.header('content-disposition', 'attachment; filename="sol-xrp-v4-research.json"');
    return { ...matrix, fees: service.state().fees };
  });
  app.get('/specialist-tests/report-export', async (req, reply) => {
    const result = await service.report(Selection.parse(req.query));
    reply.header(
      'content-disposition',
      `attachment; filename="${result.report.asset}-${result.report.plan.strategy}.json"`,
    );
    return result;
  });
}
