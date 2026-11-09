import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { HashSchema, BtcComparisonSchema } from '@crypto/contracts';
import { canonicalHash, canonicalJson } from '@crypto/core';
import { loadBtcDataset } from '@crypto/research';
import { compareThreeBtcStrategies } from '@crypto/backtest';

async function main() {
  const id = HashSchema.parse(process.argv[2]),
    root = 'data/btc-market-test',
    data = await loadBtcDataset(join(root, 'datasets'), id),
    r = compareThreeBtcStrategies(data.dataset);
  const frozen = z
    .object({ id: HashSchema, comparison: BtcComparisonSchema })
    .parse(
      JSON.parse(
        (await readFile(join(root, 'before-v3-comparison.json'), 'utf8')).replace(/^\uFEFF/, ''),
      ) as unknown,
    );
  if (
    r.previous.id !== frozen.id ||
    r.original.id !== frozen.comparison.original.reportId ||
    r.revised.id !== frozen.comparison.revised.reportId
  )
    throw new Error('Prior v1/v2 comparison changed');
  async function save(path: string, value: unknown) {
    try {
      await writeFile(path, canonicalJson(value), { flag: 'wx' });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const old: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (canonicalHash(old) !== canonicalHash(value))
        throw new Error('Frozen evidence differs', { cause: e });
    }
  }
  await mkdir(join(root, 'comparisons'), { recursive: true });
  for (const result of [r.original, r.revised, r.third, ...r.evidence])
    await save(join(root, 'reports', result.id.slice(7) + '.json'), {
      report: result.report,
      journal: result.journal,
    });
  await save(join(root, 'comparisons', r.id.slice(7) + '.json'), r.comparison);
  await save(join(root, 'comparisons', r.previous.id.slice(7) + '.json'), r.previous.comparison);
  process.stdout.write(JSON.stringify({ comparisonId: r.id, ...r.comparison }, null, 2) + '\n');
}
main().catch((e: unknown) => {
  process.stderr.write(e instanceof Error ? (e.stack ?? e.message) : 'Three-way comparison failed');
  process.exitCode = 1;
});
