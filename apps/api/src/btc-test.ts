import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  BtcDataViewSchema,
  BtcJobSchema,
  BtcReportSchema,
  BtcStateSchema,
  HashSchema,
} from '@crypto/contracts';
import type { BtcJob, BtcReport } from '@crypto/contracts';
import { canonicalHash, canonicalJson } from '@crypto/core';
import {
  downloadBtcHistory,
  latestBtcDataset,
  loadBtcDataset,
  storeBtcDataset,
} from '@crypto/research';
import { runBtcTest, reconcileSpotJournal } from '@crypto/backtest';

export async function createBtcTestService(root: string) {
  const datasets = join(root, 'datasets'),
    reports = join(root, 'reports');
  await mkdir(reports, { recursive: true });
  let current = await latestBtcDataset(datasets),
    reportId: string | null = null,
    report: BtcReport | null = null,
    job: BtcJob | null = null;
  if (current && current.dataset.origin !== 'PUBLIC_HISTORICAL')
    throw new Error('The real BTC workspace cannot load synthetic data');
  async function readReport(id: string) {
    const path = join(reports, `${HashSchema.parse(id).slice(7)}.json`),
      stat = await lstat(path);
    if (!stat.isFile() || stat.size > 32000000) throw new Error('Invalid report artifact');
    const raw = z
      .strictObject({ report: BtcReportSchema, journal: z.array(z.unknown()).max(30000) })
      .parse(JSON.parse(await readFile(path, 'utf8')) as unknown);
    reconcileSpotJournal(raw.journal);
    if (canonicalHash(raw.report) !== id || canonicalHash(raw.journal) !== raw.report.journalHash)
      throw new Error('Report integrity mismatch');
    return raw.report;
  }
  const expected = current ? runBtcTest(current.dataset) : null;
  for (const name of (await readdir(reports))
    .filter((n) => /^[a-f0-9]{64}\.json$/.test(n))
    .slice(0, 100)) {
    const id = `sha256:${name.slice(0, -5)}`,
      candidate = await readReport(id);
    if (candidate.datasetId === current?.id && id === expected?.id) {
      report = candidate;
      reportId = id;
    }
  }
  const state = () => BtcStateSchema.parse({ datasetId: current?.id ?? null, reportId, job });
  const start = (kind: BtcJob['kind'], datasetId?: string) => {
    if (job?.status === 'RUNNING') return BtcJobSchema.parse(job);
    if (kind === 'RUN' && (!current || datasetId !== current.id))
      throw new Error('Select the current immutable dataset');
    const next: BtcJob = {
      id: randomUUID(),
      kind,
      status: 'RUNNING',
      message:
        kind === 'DOWNLOAD' ? 'Connecting to public BTC history…' : 'Running frozen candle replay…',
      datasetId: current?.id ?? null,
      reportId: null,
    };
    job = next;
    // Only one bounded local job; existing artifacts remain immutable on failure/restart.
    setImmediate(() => {
      void (async () => {
        try {
          if (kind === 'DOWNLOAD') {
            const data = await downloadBtcHistory((text) => {
              next.message = text;
            });
            current = await storeBtcDataset(datasets, data);
            report = null;
            reportId = null;
            next.datasetId = current.id;
          } else {
            const frozen = await loadBtcDataset(datasets, datasetId!);
            const result = runBtcTest(frozen.dataset);
            try {
              await writeFile(
                join(reports, `${result.id.slice(7)}.json`),
                canonicalJson({ report: result.report, journal: result.journal }),
                { flag: 'wx' },
              );
            } catch (e) {
              if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
              await readReport(result.id);
            }
            report = result.report;
            reportId = result.id;
            next.reportId = result.id;
          }
          next.status = 'DONE';
          next.message =
            kind === 'DOWNLOAD'
              ? 'Real hourly history verified and frozen.'
              : 'Replay complete. Inspect decisions and virtual fills.';
        } catch {
          next.status = 'FAILED';
          next.message =
            'Research task failed. Check connectivity or artifact integrity, then retry. No synthetic data was substituted.';
        }
      })();
    });
    return BtcJobSchema.parse(next);
  };
  return {
    state,
    start,
    data: () => {
      if (!current) return null;
      const { captures, ...dataset } = current.dataset;
      return BtcDataViewSchema.parse({
        id: current.id,
        dataset,
        sources: captures.map(({ url, receivedAt, hash }) => ({ url, receivedAt, hash })),
      });
    },
    report: () => (report ? { id: reportId!, report } : null),
    async verify() {
      if (!current || !report) throw new Error('Run a test first');
      const data = await loadBtcDataset(datasets, current.id),
        result = runBtcTest(data.dataset);
      if (result.id !== reportId) throw new Error('Replay mismatch');
      return { verified: true as const, reportId: result.id };
    },
  };
}
export type BtcTestService = Awaited<ReturnType<typeof createBtcTestService>>;
export function registerBtcTestRoutes(app: FastifyInstance, service: BtcTestService) {
  app.get('/btc-test', () => service.state());
  app.post('/btc-test/download', (req) => {
    z.strictObject({}).parse(req.body);
    return service.start('DOWNLOAD');
  });
  app.post('/btc-test/run', (req) => {
    const body = z.strictObject({ datasetId: HashSchema }).parse(req.body);
    return service.start('RUN', body.datasetId);
  });
  app.get(
    '/btc-test/data',
    (_, reply) => service.data() ?? reply.code(404).send({ error: 'NO_DATASET' }),
  );
  app.get(
    '/btc-test/report',
    (_, reply) => service.report() ?? reply.code(404).send({ error: 'NO_REPORT' }),
  );
  app.post('/btc-test/verify', (req) => {
    z.strictObject({}).parse(req.body);
    return service.verify();
  });
  app.get('/btc-test/export', (_, reply) => {
    const result = service.report();
    if (!result) return reply.code(404).send({ error: 'NO_REPORT' });
    reply.header('content-disposition', 'attachment; filename="btc-retrospective.json"');
    return result;
  });
}
