import { lstat, readFile } from 'node:fs/promises';
import {
  datasetPanelFixture,
  datasetPanelReport,
  writeDatasetPanel,
  verifyDatasetPanel,
  readDatasetPanel,
} from '@crypto/research';
import { workingTreeVersion } from './database-fixtures.js';

async function json(path: string, limit: number) {
  const s = await lstat(path);
  if (!s.isFile() || s.size > limit) throw new Error('Invalid dataset input');
  const b = await readFile(path);
  if (b.length > limit) throw new Error('Dataset input limit');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(b)) as unknown;
}
export async function datasetPanelCommand(args: string[]) {
  const command = args[0],
    allowed =
      command === 'dataset-fixture'
        ? ['--out']
        : command === 'dataset-build'
          ? ['--input', '--request', '--out']
          : command === 'dataset-replay'
            ? ['--directory', '--out']
            : command === 'dataset-verify' || command === 'dataset-report'
              ? ['--directory']
              : command === 'dataset-view'
                ? ['--directory', '--split', '--horizon']
                : null,
    options = new Map<string, string>();
  if (!allowed) throw new Error('Invalid dataset command');
  for (let i = 1; i < args.length; i += 2) {
    const k = args[i]!,
      v = args[i + 1];
    if (!allowed.includes(k) || options.has(k) || !v || v.startsWith('--'))
      throw new Error('Invalid option');
    options.set(k, v);
  }
  const required = (k: string) => {
    const v = options.get(k);
    if (!v) throw new Error('Required option missing');
    return v;
  };
  if (command === 'dataset-view') {
    const client = await readDatasetPanel(required('--directory')),
      split = required('--split');
    const horizon = options.get('--horizon');
    if (horizon !== undefined && !/^[1-9][0-9]*$/.test(horizon)) throw new Error('Invalid horizon');
    process.stdout.write(
      `${JSON.stringify({ columns: client.columns, rows: horizon === undefined ? client.features(split) : client.supervised(split, Number(horizon)) }, null, 2)}\n`,
    );
    return;
  }
  if (command === 'dataset-verify' || command === 'dataset-report') {
    const v = await verifyDatasetPanel(required('--directory'));
    process.stdout.write(
      command === 'dataset-report'
        ? datasetPanelReport(v.artifact, v.manifest)
        : `${JSON.stringify({ valid: true, manifest: v.manifest })}\n`,
    );
    return;
  }
  let input: unknown, request: unknown;
  if (command === 'dataset-fixture') ({ input, request } = datasetPanelFixture());
  else if (command === 'dataset-replay') {
    const v = await verifyDatasetPanel(required('--directory'));
    ({ input, request } = v.artifact);
  } else {
    input = await json(required('--input'), 64 * 1024 * 1024);
    request = await json(required('--request'), 16384);
  }
  const v = await writeDatasetPanel(
    input,
    request,
    options.get('--out') ?? 'data/dataset-panels',
    await workingTreeVersion(),
  );
  process.stdout.write(
    `${JSON.stringify({ directory: v.directory, manifest: v.manifest, counts: v.artifact.audit.splits, execution: 'DISABLED', synthetic: v.artifact.input.market.sources.every((s) => s.origin === 'SYNTHETIC') }, null, 2)}\n`,
  );
}
