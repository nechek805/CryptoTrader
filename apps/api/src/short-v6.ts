import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import {
  HashSchema,
  DirectionMatrixSchema,
  ShortV6StateSchema,
  ShortV6MatrixSchema,
  DirectionReportSchema,
  ShortV6ReportSchema,
  ShortV6SelectionSchema,
  ShortV6ViewSchema,
  ShortV6FeesSchema,
  DEFAULT_SHORT_V6_FEES,
  MarketReportSchema,
  SpecialistReportSchema,
  SpecialistV5ReportSchema,
} from '@crypto/contracts';
import type { ShortV6Matrix } from '@crypto/contracts';
import { canonicalHash, canonicalJson } from '@crypto/core';
import { loadMarketHistory } from '@crypto/research';
import {
  SHORT_V6_ENGINE_HASH,
  runShortV6Test,
  verifyShortV6Report,
  verifyDirectionalReport,
  searchShortV6,
  shortV6Profile,
  eligibleShortV6,
  shortV6Diagnosis,
  analyseShortV6Trades,
  compareShortV6Trades,
  reconcileMarginResearchJournal,
  reconcileSpotJournal,
  verifyMarketReport,
  verifySpecialistReport,
  verifySpecialistV5Report,
} from '@crypto/backtest';
const Report = z.union([
  ShortV6ReportSchema,
  DirectionReportSchema,
  MarketReportSchema,
  SpecialistReportSchema,
  SpecialistV5ReportSchema,
]);
async function bounded(path: string) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size > 40000000) throw new Error('Directional artifact rejected');
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}
async function pointer(root: string) {
  return z.strictObject({ id: HashSchema }).parse(await bounded(join(root, 'latest.json'))).id;
}
async function atomic(path: string, value: unknown) {
  const tmp = path + '.' + randomUUID() + '.tmp';
  await writeFile(tmp, canonicalJson(value), { flag: 'wx' });
  await rename(tmp, path);
}
export async function createShortV6Service(
  root: string,
  marketRoot = join('data', 'market-strategy-tests'),
  v4Root = join('data', 'sol-xrp-lab'),
  v5Root = join('data', 'sol-xrp-v5'),
  directionRoot = join('data', 'directional-tests'),
) {
  await mkdir(join(root, 'reports'), { recursive: true });
  await mkdir(join(root, 'matrices'), { recursive: true });
  let current: { id: string; matrix: ShortV6Matrix } | null = null,
    job: z.infer<typeof ShortV6StateSchema>['job'] = null,
    fees = { ...DEFAULT_SHORT_V6_FEES },
    changing = false;
  try {
    fees = ShortV6FeesSchema.parse(await bounded(join(root, 'fees.json')));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  async function readReport(idInput: unknown) {
    const id = HashSchema.parse(idInput);
    let value: unknown;
    for (const dir of [root, directionRoot, marketRoot, v4Root, v5Root]) {
      try {
        value = await bounded(join(dir, 'reports', id.slice(7) + '.json'));
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    }
    const b = z
      .strictObject({ report: Report, journal: z.array(z.unknown()).max(50000) })
      .parse(value);
    if (canonicalHash(b.report) !== id || canonicalHash(b.journal) !== b.report.journalHash)
      throw new Error('Directional report integrity mismatch');
    if (b.report.version === 'directional-replay.v1' || b.report.version === 'short-v6-replay.v1')
      reconcileMarginResearchJournal(b.journal);
    else reconcileSpotJournal(b.journal);
    return b;
  }
  async function immutable(dir: string, id: string, value: unknown) {
    const path = join(root, dir, HashSchema.parse(id).slice(7) + '.json');
    try {
      await writeFile(path, canonicalJson(value), { flag: 'wx' });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      if (canonicalHash(await bounded(path)) !== canonicalHash(value))
        throw new Error('Immutable directional artifact differs', { cause: e });
    }
  }
  try {
    const id = await pointer(root),
      matrix = ShortV6MatrixSchema.parse(
        await bounded(join(root, 'matrices', id.slice(7) + '.json')),
      );
    if (canonicalHash(matrix) !== id) throw new Error('Directional matrix hash mismatch');
    if (matrix.engineHash === SHORT_V6_ENGINE_HASH) {
      for (const [asset, datasetId] of Object.entries(matrix.datasetIds)) {
        const d = (await loadMarketHistory(join(marketRoot, 'datasets'), datasetId)).dataset;
        if (
          d.instrument.asset !== asset ||
          d.from !== matrix.from ||
          d.to !== matrix.to ||
          d.origin !== 'PUBLIC_HISTORICAL'
        )
          throw new Error('Directional snapshot mismatch');
      }
      current = { id, matrix };
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const state = () => ShortV6StateSchema.parse({ matrixId: current?.id ?? null, job, fees });
  function start() {
    if (changing) throw new Error('Wait for fee preferences');
    if (job?.status === 'RUNNING') return { ...job };
    const next: NonNullable<typeof job> = {
      id: randomUUID(),
      status: 'RUNNING',
      completed: 0,
      total: 2,
      message: 'Opening the preserved ten-token snapshots…',
    };
    job = next;
    setImmediate(() => {
      void (async () => {
        try {
          const sourceId = await pointer(directionRoot),
            source = DirectionMatrixSchema.parse(
              await bounded(join(directionRoot, 'matrices', sourceId.slice(7) + '.json')),
            );
          if (canonicalHash(source) !== sourceId)
            throw new Error('Frozen direction matrix hash mismatch');
          const cells: ShortV6Matrix['cells'] = [...source.cells],
            profiles: ShortV6Matrix['profiles'] = [...source.profiles],
            research: ShortV6Matrix['research'] = [],
            splitIndex = Math.floor((((source.to - source.from) / 3600000) * 2) / 3);
          async function save(result: ReturnType<typeof runShortV6Test>) {
            await immutable('reports', result.id, {
              report: result.report,
              journal: result.journal,
            });
            return { reportId: result.id, summary: result.report.summary };
          }
          for (const asset of ['SOL', 'XRP'] as const) {
            const data = (
                await loadMarketHistory(join(marketRoot, 'datasets'), source.datasetIds[asset])
              ).dataset,
              parent = source.profiles.find((p) => p.asset === asset && p.strategy === 'V5');
            if (
              !parent ||
              data.instrument.asset !== asset ||
              data.from !== source.from ||
              data.to !== source.to ||
              data.origin !== 'PUBLIC_HISTORICAL'
            )
              throw new Error('V6 parent snapshot mismatch');
            for (const mode of ['LONG_ONLY', 'SHORT_ONLY', 'LONG_SHORT'] as const)
              for (const feeMode of ['STANDARD', 'ZERO'] as const) {
                const old = DirectionReportSchema.safeParse(
                    (
                      await readReport(
                        source.cells.find(
                          (c) =>
                            c.asset === asset &&
                            c.strategy === 'V5' &&
                            c.mode === mode &&
                            c.feeMode === feeMode,
                        )!.reportId,
                      )
                    ).report,
                  ),
                  fresh = runShortV6Test(data, parent, mode, feeMode);
                if (mode === 'LONG_ONLY') {
                  const original = (
                    await readReport(
                      source.cells.find(
                        (c) =>
                          c.asset === asset &&
                          c.strategy === 'V5' &&
                          c.mode === mode &&
                          c.feeMode === feeMode,
                      )!.reportId,
                    )
                  ).report;
                  if (
                    canonicalHash(fresh.report.summary.netPnl) !==
                    canonicalHash(original.summary.netPnl)
                  )
                    throw new Error('V6 long parent mismatch');
                } else {
                  if (!old.success) throw new Error('V5 directional parent missing');
                  for (const key of ['summary', 'trades', 'journalHash'] as const)
                    if (canonicalHash(fresh.report[key]) !== canonicalHash(old.data[key]))
                      throw new Error('V6 no-change compatibility mismatch');
                  const normalized = fresh.report.decisions.map((d) =>
                    Object.fromEntries(
                      Object.entries(d).filter(
                        ([key]) =>
                          !['shortSlopeAtr', 'shortDistanceAtr', 'shortTargetAtr'].includes(key),
                      ),
                    ),
                  );
                  if (canonicalHash(normalized) !== canonicalHash(old.data.decisions))
                    throw new Error('V6 parent decisions changed');
                }
              }
            const search = await searchShortV6(data, parent, splitIndex, (text) => {
                next.message = text;
              }),
              selected = search.selected.candidate,
              profile = shortV6Profile(parent, selected),
              searchRows: ShortV6Matrix['research'][number]['search'] = [];
            for (const trial of search.trials)
              searchRows.push({
                candidate: trial.candidate,
                development: await save(trial.result),
                eligible: eligibleShortV6(trial),
                selected: canonicalHash(trial.candidate) === canonicalHash(selected),
              });
            const slice = async (fromIndex: number, toIndex: number) => ({
              fromIndex,
              toIndex,
              v5Short: await save(
                runShortV6Test(data, parent, 'SHORT_ONLY', 'STANDARD', { fromIndex, toIndex }),
              ),
              v6Short: await save(
                runShortV6Test(data, profile, 'SHORT_ONLY', 'STANDARD', { fromIndex, toIndex }),
              ),
              v5Combined: await save(
                runShortV6Test(data, parent, 'LONG_SHORT', 'STANDARD', { fromIndex, toIndex }),
              ),
              v6Combined: await save(
                runShortV6Test(data, profile, 'LONG_SHORT', 'STANDARD', { fromIndex, toIndex }),
              ),
            });
            const development = await slice(0, splitIndex),
              check = await slice(splitIndex, data.bars.length);
            profiles.push(profile);
            for (const mode of ['LONG_ONLY', 'SHORT_ONLY', 'LONG_SHORT'] as const)
              for (const feeMode of ['STANDARD', 'ZERO'] as const) {
                next.message = `${asset} V6 ${mode}, fees ${feeMode === 'STANDARD' ? 'on' : 'off'}`;
                await new Promise<void>((resolve) => setImmediate(resolve));
                const result = runShortV6Test(data, profile, mode, feeMode);
                await save(result);
                if (mode === 'LONG_ONLY') {
                  const baseline = source.cells.find(
                    (c) =>
                      c.asset === asset &&
                      c.strategy === 'V5' &&
                      c.mode === mode &&
                      c.feeMode === feeMode,
                  )!;
                  for (const key of [
                    'netPnl',
                    'finalEquity',
                    'fees',
                    'slippage',
                    'closedTrades',
                    'wins',
                    'maxDrawdown',
                  ] as const)
                    if (result.report.summary[key] !== baseline.summary[key])
                      throw new Error('V6 changed long-only behavior');
                }
                cells.push({
                  asset,
                  strategy: 'V6',
                  mode,
                  feeMode,
                  reportId: result.id,
                  summary: result.report.summary,
                  legacy: false,
                });
              }
            const v5 = DirectionReportSchema.parse(
                (
                  await readReport(
                    source.cells.find(
                      (c) =>
                        c.asset === asset &&
                        c.strategy === 'V5' &&
                        c.mode === 'SHORT_ONLY' &&
                        c.feeMode === 'STANDARD',
                    )!.reportId,
                  )
                ).report,
              ),
              v6 = ShortV6ReportSchema.parse(
                (
                  await readReport(
                    cells.find(
                      (c) =>
                        c.asset === asset &&
                        c.strategy === 'V6' &&
                        c.mode === 'SHORT_ONLY' &&
                        c.feeMode === 'STANDARD',
                    )!.reportId,
                  )
                ).report,
              );
            research.push({
              asset,
              parent,
              selected,
              diagnosis: shortV6Diagnosis(v5, data),
              v5ShortTrades: analyseShortV6Trades(v5, data),
              tradeChanges: compareShortV6Trades(v5, v6),
              search: searchRows,
              development,
              check,
            });
            next.completed++;
          }
          const matrix = ShortV6MatrixSchema.parse({
              ...source,
              version: 'short-v6-matrix.v1',
              engineHash: SHORT_V6_ENGINE_HASH,
              sourceDirectionMatrixId: sourceId,
              splitIndex,
              selection: 'EARLIER_SHORT_NET_WITH_FEES_MIN_TWO_TRADES_DRAWDOWN_2_PERCENT',
              historyUse: 'PREVIOUSLY_SEEN_HISTORY_EXPLORATORY_CHECK',
              generatedAt: new Date().toISOString(),
              profiles,
              cells,
              research,
              searchNotes: [
                'Registered V6 grids: SOL 25 profiles including unchanged baseline, stronger falling slope, nearer short targets and optional delayed trailing. XRP 19 profiles including baseline, bounded distance from MA200 and short-specific targets. All 44 development trials are retained.',
                'Rank earlier short-only net P&L with fees on, require at least two closed trades and no more than 2% hourly drawdown. Ties prefer baseline/no trailing, then fewer trades, then canonical candidate hash. Later and combined outcomes never rank candidates.',
                'Long-only V5 rules and all costs/risk caps remain fixed. Long-only compatibility and the no-change directional parent reproduce before comparison. Combined trade sizes/opportunities can change when short entries/exits change.',
                'History and later slices were previously seen. This adds 44 candidate profiles after prior V4/V5 tuning, asset selection and the untuned short extension. These are not independent trials; later-period performance can deteriorate. No maximum/future-profit claim.',
              ],
            }),
            id = canonicalHash(matrix);
          await immutable('matrices', id, matrix);
          await atomic(join(root, 'latest.json'), { id });
          current = { id, matrix };
          next.status = 'DONE';
          next.message =
            'Separate SOL/XRP V6 comparisons completed; original V1-V5 reports and later checks retained.';
        } catch (e) {
          next.status = 'FAILED';
          next.message =
            e instanceof Error ? e.message : 'Directional tests failed; old results retained';
        }
      })();
    });
    return { ...next };
  }
  async function selected(input: unknown) {
    const s = ShortV6SelectionSchema.parse(input),
      matrix = current?.matrix,
      mode = fees[s.strategy] ? 'STANDARD' : 'ZERO',
      cell = matrix?.cells.find(
        (c) =>
          c.asset === s.asset &&
          c.strategy === s.strategy &&
          c.mode === s.mode &&
          c.feeMode === mode,
      );
    if (!matrix || !cell)
      throw new Error('Run the directional comparison or choose a supported coin/version');
    const result = await readReport(cell.reportId),
      data = (await loadMarketHistory(join(marketRoot, 'datasets'), matrix.datasetIds[s.asset]))
        .dataset;
    if (
      result.report.asset !== s.asset ||
      result.report.datasetId !== matrix.datasetIds[s.asset] ||
      result.report.plan.feeMode !== mode ||
      (result.report.version === 'directional-replay.v1' ||
      result.report.version === 'short-v6-replay.v1'
        ? result.report.plan.mode !== s.mode || result.report.plan.profile.strategy !== s.strategy
        : s.mode !== 'LONG_ONLY' || result.report.plan.strategy !== s.strategy) ||
      canonicalHash(result.report.summary) !== canonicalHash(cell.summary)
    )
      throw new Error('Selected directional result mismatch');
    return { data, result, cell };
  }
  return {
    state,
    start,
    matrix: () => current,
    async setFees(input: unknown) {
      if (job?.status === 'RUNNING' || changing) throw new Error('Wait for active research');
      changing = true;
      try {
        const next = ShortV6FeesSchema.parse(input);
        await atomic(join(root, 'fees.json'), next);
        fees = next;
        return state();
      } finally {
        changing = false;
      }
    },
    async report(input: unknown) {
      const { data, result, cell } = await selected(input);
      return ShortV6ViewSchema.parse({
        id: cell.reportId,
        report: result.report,
        bars: data.bars,
        sources: [data.instrument.metadata, ...data.captures].map(({ url, hash, receivedAt }) => ({
          url,
          hash,
          receivedAt,
        })),
      });
    },
    async verify(input: unknown) {
      const { data, result, cell } = await selected(input);
      const r = result.report,
        rebuilt =
          r.version === 'short-v6-replay.v1'
            ? verifyShortV6Report(r, data)
            : r.version === 'directional-replay.v1'
              ? verifyDirectionalReport(r, data)
              : r.version === 'specialist-v5-replay.v1'
                ? verifySpecialistV5Report(r, data)
                : r.version === 'specialist-replay.v1'
                  ? verifySpecialistReport(r, data)
                  : verifyMarketReport(r, data);
      if (
        rebuilt.id !== cell.reportId ||
        canonicalHash(rebuilt.journal) !== canonicalHash(result.journal)
      )
        throw new Error('Directional journal replay mismatch');
      return { verified: true, reportId: cell.reportId };
    },
  };
}
export type ShortV6Service = Awaited<ReturnType<typeof createShortV6Service>>;
export function registerShortV6Routes(app: FastifyInstance, service: ShortV6Service) {
  app.get('/short-v6', () => service.state());
  app.get(
    '/short-v6/matrix',
    (_, reply) => service.matrix() ?? reply.code(404).send({ error: 'NO_DIRECTIONAL_RESULTS' }),
  );
  app.post('/short-v6/run', (req) => {
    z.strictObject({}).parse(req.body);
    return service.start();
  });
  app.post('/short-v6/fees', (req, reply) => {
    const body = z.strictObject({ fees: ShortV6FeesSchema }).parse(req.body);
    if (service.state().job?.status === 'RUNNING')
      return reply.code(409).send({ error: 'RESEARCH_BUSY' });
    return service.setFees(body.fees);
  });
  app.get('/short-v6/report', (req) => service.report(ShortV6SelectionSchema.parse(req.query)));
  app.post('/short-v6/verify', (req) => service.verify(ShortV6SelectionSchema.parse(req.body)));
  app.get('/short-v6/export', (_, reply) => {
    const value = service.matrix();
    if (!value) return reply.code(404).send({ error: 'NO_RESULTS' });
    reply.header('content-disposition', 'attachment; filename="long-short-market-tests.json"');
    return { ...value, fees: service.state().fees };
  });
  app.get('/short-v6/report-export', async (req, reply) => {
    const result = await service.report(ShortV6SelectionSchema.parse(req.query));
    reply.header('content-disposition', 'attachment; filename="directional-report.json"');
    return result;
  });
}
