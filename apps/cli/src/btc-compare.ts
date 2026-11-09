import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BtcReportSchema, HashSchema } from '@crypto/contracts';
import { canonicalHash, canonicalJson } from '@crypto/core';
import { compareBtcStrategies } from '@crypto/backtest';
import { loadBtcDataset } from '@crypto/research';
import { z } from 'zod';

async function main() {
  const id = HashSchema.parse(process.argv[2]);
  const data = await loadBtcDataset('data/btc-market-test/datasets', id),
    result = compareBtcStrategies(data.dataset);
  const root = 'data/btc-market-test';
  await mkdir(join(root, 'comparisons'), { recursive: true });
  async function immutable(path: string, value: unknown) {
    const body = canonicalJson(value);
    try {
      await writeFile(path, body, { flag: 'wx' });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const old: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (canonicalHash(old) !== canonicalHash(value))
        throw new Error('Existing evidence differs', { cause: e });
    }
  }
  for (const r of [result.original, result.revised, ...result.evidence])
    await immutable(join(root, 'reports', r.id.slice(7) + '.json'), {
      report: r.report,
      journal: r.journal,
    });
  await immutable(join(root, 'comparisons', result.id.slice(7) + '.json'), result.comparison);
  const before = z
    .object({ report: BtcReportSchema })
    .parse(
      JSON.parse(
        (await readFile(join(root, 'before-revision.json'), 'utf8')).replace(/^\uFEFF/, ''),
      ) as unknown,
    );
  if (canonicalHash(before.report) !== result.original.id)
    throw new Error('Original screenshot run was not reproduced');
  process.stdout.write(
    JSON.stringify({ comparisonId: result.id, ...result.comparison }, null, 2) + '\n',
  );
}
main().catch((error: unknown) => {
  process.stderr.write(
    error instanceof Error ? (error.stack ?? error.message) : 'Comparison failed',
  );
  process.exitCode = 1;
});
