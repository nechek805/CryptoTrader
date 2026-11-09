import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import {
  HashSchema,
  MarketMatrixSchema,
  SpecialistV5MatrixSchema,
  DirectionStateSchema,
  DirectionMatrixSchema,
  DirectionReportSchema,
  DirectionSelectionSchema,
  DirectionViewSchema,
  SpecialistV5FeesSchema,
  DEFAULT_SPECIALIST_V5_FEES,
  SHORT_ASSUMPTIONS,
  MarketReportSchema,
  SpecialistReportSchema,
  SpecialistV5ReportSchema,
} from '@crypto/contracts';
import type { DirectionMatrix, DirectionProfile } from '@crypto/contracts';
import { canonicalHash, canonicalJson } from '@crypto/core';
import { loadMarketHistory } from '@crypto/research';
import {
  DIRECTION_ENGINE_HASH,
  runDirectionalTest,
  verifyDirectionalReport,
  reconcileMarginResearchJournal,
  reconcileSpotJournal,
  verifyMarketReport,
  verifySpecialistReport,
  verifySpecialistV5Report,
} from '@crypto/backtest';
const Report = z.union([
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
export async function createDirectionalService(
  root: string,
  marketRoot = join('data', 'market-strategy-tests'),
  v4Root = join('data', 'sol-xrp-lab'),
  v5Root = join('data', 'sol-xrp-v5'),
) {
  await mkdir(join(root, 'reports'), { recursive: true });
  await mkdir(join(root, 'matrices'), { recursive: true });
  let current: { id: string; matrix: DirectionMatrix } | null = null,
    job: z.infer<typeof DirectionStateSchema>['job'] = null,
    fees = { ...DEFAULT_SPECIALIST_V5_FEES },
    changing = false;
  try {
    fees = SpecialistV5FeesSchema.parse(await bounded(join(root, 'fees.json')));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  async function readReport(idInput: unknown) {
    const id = HashSchema.parse(idInput);
    let value: unknown;
    for (const dir of [root, marketRoot, v4Root, v5Root]) {
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
    if (b.report.version === 'directional-replay.v1') reconcileMarginResearchJournal(b.journal);
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
      matrix = DirectionMatrixSchema.parse(
        await bounded(join(root, 'matrices', id.slice(7) + '.json')),
      );
    if (canonicalHash(matrix) !== id) throw new Error('Directional matrix hash mismatch');
    if (matrix.engineHash === DIRECTION_ENGINE_HASH) {
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
  const state = () => DirectionStateSchema.parse({ matrixId: current?.id ?? null, job, fees });
  function start() {
    if (changing) throw new Error('Wait for fee preferences');
    if (job?.status === 'RUNNING') return { ...job };
    const next: NonNullable<typeof job> = {
      id: randomUUID(),
      status: 'RUNNING',
      completed: 0,
      total: 34,
      message: 'Opening the preserved ten-token snapshots…',
    };
    job = next;
    setImmediate(() => {
      void (async () => {
        try {
          const specialistId = await pointer(v5Root),
            specialist = SpecialistV5MatrixSchema.parse(
              await bounded(join(v5Root, 'matrices', specialistId.slice(7) + '.json')),
            ),
            marketId = specialist.sourceMatrixId,
            market = MarketMatrixSchema.parse(
              await bounded(join(marketRoot, 'matrices', marketId.slice(7) + '.json')),
            );
          if (
            canonicalHash(market) !== marketId ||
            canonicalHash(specialist) !== specialistId ||
            specialist.sourceMatrixId !== marketId ||
            !market.feeVariants ||
            market.origin !== 'PUBLIC_HISTORICAL' ||
            specialist.from !== market.from ||
            specialist.to !== market.to
          )
            throw new Error('Preserved market and specialist comparisons must share one history');
          const cells: DirectionMatrix['cells'] = [],
            profiles: DirectionProfile[] = [],
            datasetIds = {} as DirectionMatrix['datasetIds'];
          for (const row of market.rows) {
            if (!row.datasetId || row.status !== 'COMPLETE')
              throw new Error('Each market requires verified historical candles');
            const data = (await loadMarketHistory(join(marketRoot, 'datasets'), row.datasetId))
              .dataset;
            if (
              data.origin !== 'PUBLIC_HISTORICAL' ||
              data.instrument.asset !== row.asset ||
              data.from !== market.from ||
              data.to !== market.to
            )
              throw new Error('Directional source mismatch');
            datasetIds[row.asset] = row.datasetId;
            const specialistRow = specialist.rows.find((r) => r.asset === row.asset),
              coinProfiles: DirectionProfile[] = (['V1', 'V2', 'V3'] as const).map((strategy) => ({
                asset: row.asset,
                strategy,
              }));
            if (specialistRow) {
              const v4 = SpecialistReportSchema.parse(
                (
                  await readReport(
                    specialistRow.variants.STANDARD.find((c) => c.strategy === 'V4')!.reportId,
                  )
                ).report,
              );
              if (specialistRow.datasetId !== row.datasetId)
                throw new Error('Specialist snapshot differs');
              coinProfiles.push(
                { asset: row.asset, strategy: 'V4', candidate: v4.plan.candidate },
                { asset: row.asset, strategy: 'V5', candidate: specialistRow.selected },
              );
            }
            for (const profile of coinProfiles) {
              profiles.push(profile);
              for (const feeMode of ['STANDARD', 'ZERO'] as const) {
                const legacy =
                  profile.strategy === 'V4' || profile.strategy === 'V5'
                    ? specialistRow!.variants[feeMode].find((c) => c.strategy === profile.strategy)
                    : market.feeVariants[feeMode]
                        .find((r) => r.asset === row.asset)
                        ?.cells.find((c) => c.strategy === profile.strategy);
                if (!legacy) throw new Error('Legacy report missing');
                const old = (await readReport(legacy.reportId)).report;
                if (
                  old.version === 'directional-replay.v1' ||
                  old.asset !== row.asset ||
                  old.datasetId !== row.datasetId ||
                  old.plan.strategy !== profile.strategy ||
                  old.plan.feeMode !== feeMode ||
                  canonicalHash(old.summary) !== canonicalHash(legacy.summary)
                )
                  throw new Error('Legacy baseline mismatch');
                cells.push({
                  asset: row.asset,
                  strategy: profile.strategy,
                  mode: 'LONG_ONLY',
                  feeMode,
                  reportId: legacy.reportId,
                  summary: legacy.summary,
                  legacy: true,
                });
                // Verify long behavior before crediting the short extension. Finance is zero for longs.
                const compat = runDirectionalTest(data, profile, 'LONG_ONLY', feeMode);
                for (const key of [
                  'finalEquity',
                  'netPnl',
                  'fees',
                  'slippage',
                  'closedTrades',
                  'wins',
                  'openBase',
                  'maxDrawdown',
                ] as const)
                  if (compat.report.summary[key] !== old.summary[key])
                    throw new Error(
                      `Long-only compatibility failed: ${row.asset} ${profile.strategy} ${key}`,
                    );
                for (const mode of ['SHORT_ONLY', 'LONG_SHORT'] as const) {
                  next.message = `${row.asset} ${profile.strategy} · ${mode} · fees ${feeMode === 'STANDARD' ? 'on' : 'off'}`;
                  await new Promise<void>((resolve) => setImmediate(resolve));
                  const result = runDirectionalTest(data, profile, mode, feeMode);
                  await immutable('reports', result.id, {
                    report: result.report,
                    journal: result.journal,
                  });
                  cells.push({
                    asset: row.asset,
                    strategy: profile.strategy,
                    mode,
                    feeMode,
                    reportId: result.id,
                    summary: result.report.summary,
                    legacy: false,
                  });
                }
              }
              next.completed++;
            }
          }
          const matrix = DirectionMatrixSchema.parse({
              version: 'directional-matrix.v1',
              engineHash: DIRECTION_ENGINE_HASH,
              sourceMarketMatrixId: marketId,
              sourceSpecialistMatrixId: specialistId,
              generatedAt: new Date().toISOString(),
              from: market.from,
              to: market.to,
              initialUsdt: '10000',
              assumptions: SHORT_ASSUMPTIONS,
              profiles,
              datasetIds,
              cells,
            }),
            id = canonicalHash(matrix);
          await immutable('matrices', id, matrix);
          await atomic(join(root, 'latest.json'), { id });
          current = { id, matrix };
          next.status = 'DONE';
          next.message =
            'All ten tokens completed. Original long-only reports preserved; short borrowing assumptions remain explicit.';
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
    const s = DirectionSelectionSchema.parse(input),
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
      (result.report.version === 'directional-replay.v1'
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
        const next = SpecialistV5FeesSchema.parse(input);
        await atomic(join(root, 'fees.json'), next);
        fees = next;
        return state();
      } finally {
        changing = false;
      }
    },
    async report(input: unknown) {
      const { data, result, cell } = await selected(input);
      return DirectionViewSchema.parse({
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
          r.version === 'directional-replay.v1'
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
export type DirectionalService = Awaited<ReturnType<typeof createDirectionalService>>;
export function registerDirectionalRoutes(app: FastifyInstance, service: DirectionalService) {
  app.get('/directional-tests', () => service.state());
  app.get(
    '/directional-tests/matrix',
    (_, reply) => service.matrix() ?? reply.code(404).send({ error: 'NO_DIRECTIONAL_RESULTS' }),
  );
  app.post('/directional-tests/run', (req) => {
    z.strictObject({}).parse(req.body);
    return service.start();
  });
  app.post('/directional-tests/fees', (req, reply) => {
    const body = z.strictObject({ fees: SpecialistV5FeesSchema }).parse(req.body);
    if (service.state().job?.status === 'RUNNING')
      return reply.code(409).send({ error: 'RESEARCH_BUSY' });
    return service.setFees(body.fees);
  });
  app.get('/directional-tests/report', (req) =>
    service.report(DirectionSelectionSchema.parse(req.query)),
  );
  app.post('/directional-tests/verify', (req) =>
    service.verify(DirectionSelectionSchema.parse(req.body)),
  );
  app.get('/directional-tests/export', (_, reply) => {
    const value = service.matrix();
    if (!value) return reply.code(404).send({ error: 'NO_RESULTS' });
    reply.header('content-disposition', 'attachment; filename="long-short-market-tests.json"');
    return { ...value, fees: service.state().fees };
  });
  app.get('/directional-tests/report-export', async (req, reply) => {
    const result = await service.report(DirectionSelectionSchema.parse(req.query));
    reply.header('content-disposition', 'attachment; filename="directional-report.json"');
    return result;
  });
}
