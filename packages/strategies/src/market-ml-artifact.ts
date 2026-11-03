import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { MarketMlReportSchema, MarketMlBundleSchema } from '@crypto/contracts';
import type { MarketMlReport } from '@crypto/contracts';
import { canonicalHash, canonicalJson } from '@crypto/core';
import { trainMarketModel } from './market-ml-training.js';
import { marketMlMarkdown } from './market-ml-report.js';
const limit = 64 * 1024 * 1024,
  hash = (s: string | Uint8Array) => `sha256:${createHash('sha256').update(s).digest('hex')}`;
async function bounded(path: string) {
  const s = await lstat(path);
  if (!s.isFile() || s.size > limit) throw new Error('Invalid ML artifact');
  const b = await readFile(path);
  if (b.length > limit) throw new Error('ML artifact limit');
  return b;
}
async function synced(path: string, body: string) {
  if (Buffer.byteLength(body) > limit) throw new Error('ML artifact limit');
  const h = await open(path, 'wx');
  try {
    await h.writeFile(body);
    await h.sync();
  } finally {
    await h.close();
  }
}
async function cleanup(stage: string, root: string) {
  if (dirname(resolve(stage)) !== root || !basename(stage).startsWith('.market-ml-stage-'))
    throw new Error('Unsafe ML staging cleanup');
  await rm(stage, { recursive: true, force: true });
}
function contents(r: MarketMlReport) {
  return {
    reportJson: `${canonicalJson(r)}\n`,
    reportMarkdown: marketMlMarkdown(r),
    modelJson: `${canonicalJson(r.model)}\n`,
    configJson: `${canonicalJson(r.model.config)}\n`,
    predictionsJson: `${canonicalJson(r.predictions)}\n`,
  };
}
const names = {
  reportJson: 'report.json',
  reportMarkdown: 'report.md',
  modelJson: 'model.json',
  configJson: 'config.json',
  predictionsJson: 'predictions.json',
} as const;
export async function verifyMarketModel(directoryInput: string, panelDirectory: string) {
  const directory = resolve(directoryInput);
  if (!(await lstat(directory)).isDirectory()) throw new Error('Invalid ML directory');
  const decode = (b: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(b),
    metadata = MarketMlBundleSchema.parse(
      JSON.parse(decode(await bounded(join(directory, 'bundle.json')))),
    );
  const report = MarketMlReportSchema.parse(
    JSON.parse(decode(await bounded(join(directory, 'report.json')))),
  );
  const rebuilt = await trainMarketModel(
      panelDirectory,
      report.model.config,
      report.model.codeVersion,
    ),
    reportHash = canonicalHash(rebuilt),
    id = `market-ml_${reportHash.slice(7)}`,
    files = contents(rebuilt);
  if (
    canonicalHash(report) !== reportHash ||
    metadata.reportHash !== reportHash ||
    metadata.id !== id ||
    basename(directory) !== id
  )
    throw new Error('ML semantic report integrity mismatch');
  for (const key of Object.keys(names) as (keyof typeof names)[]) {
    const bytes = await bounded(join(directory, names[key]));
    if (hash(bytes) !== metadata.files[key] || decode(bytes) !== files[key])
      throw new Error('ML file or semantic checksum mismatch');
  }
  return { directory, hash: reportHash, report: rebuilt, metadata };
}
export async function writeMarketModel(
  panelDirectory: string,
  config: unknown,
  rootInput: string,
  codeVersion: string,
) {
  const report = await trainMarketModel(panelDirectory, config, codeVersion),
    reportHash = canonicalHash(report),
    id = `market-ml_${reportHash.slice(7)}`,
    files = contents(report),
    metadata = MarketMlBundleSchema.parse({
      schemaVersion: 'market-ml-bundle.v1',
      id,
      reportHash,
      files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, hash(v)])),
    });
  await mkdir(rootInput, { recursive: true });
  const root = await realpath(rootInput),
    stage = await mkdtemp(join(root, '.market-ml-stage-')),
    directory = join(root, id);
  try {
    for (const key of Object.keys(names) as (keyof typeof names)[])
      await synced(join(stage, names[key]), files[key]);
    await synced(join(stage, 'bundle.json'), `${canonicalJson(metadata)}\n`);
    try {
      await rename(stage, directory);
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        ['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(String(error.code))
      ))
        throw error;
      if ((await verifyMarketModel(directory, panelDirectory)).hash !== reportHash)
        throw new Error('Existing ML bundle mismatch', { cause: error });
    }
    return { directory, hash: reportHash, report, metadata };
  } finally {
    await cleanup(stage, root);
  }
}
