import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { BacktestBundleSchema } from '@crypto/contracts';
import { canonicalHash, canonicalJson, deepFreeze } from '@crypto/core';
import { runBacktest, validateBacktestReport } from './backtest.js';
import { formatBacktestReport } from './backtest-report.js';
import type { StrategyFactory } from './strategy.js';
const limit = 64 * 1024 * 1024,
  hash = (b: Uint8Array | string) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
async function bounded(path: string) {
  const s = await lstat(path);
  if (!s.isFile() || s.size > limit) throw new Error('Invalid backtest file');
  const b = await readFile(path);
  if (b.length > limit) throw new Error('Backtest file limit');
  return b;
}
async function synced(path: string, text: string) {
  if (Buffer.byteLength(text) > limit) throw new Error('Backtest artifact limit');
  const h = await open(path, 'wx');
  try {
    await h.writeFile(text);
    await h.sync();
  } finally {
    await h.close();
  }
}
async function cleanup(stage: string, root: string) {
  if (dirname(resolve(stage)) !== root || !basename(stage).startsWith('.backtest-stage-'))
    throw new Error('Unsafe backtest staging cleanup');
  await rm(stage, { recursive: true, force: true });
}
export async function verifyBacktest(directoryInput: string, factory?: StrategyFactory) {
  const directory = resolve(directoryInput);
  if (!(await lstat(directory)).isDirectory()) throw new Error('Invalid backtest directory');
  const metadata = BacktestBundleSchema.parse(
      JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(
          await bounded(join(directory, 'bundle.json')),
        ),
      ),
    ),
    json = await bounded(join(directory, 'report.json')),
    markdown = await bounded(join(directory, 'report.md')),
    manifest = await bounded(join(directory, 'manifest.json'));
  if (
    hash(json) !== metadata.files.reportJson ||
    hash(markdown) !== metadata.files.reportMarkdown ||
    hash(manifest) !== metadata.files.manifestJson
  )
    throw new Error('Backtest file checksum mismatch');
  const report = validateBacktestReport(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(json)),
      factory,
    ),
    reportHash = canonicalHash(report),
    id = `backtest_${reportHash.slice(7)}`;
  if (
    id !== metadata.id ||
    basename(directory) !== id ||
    reportHash !== metadata.reportHash ||
    report.manifestHash !== metadata.manifestHash ||
    markdown.toString('utf8') !== formatBacktestReport(report) ||
    manifest.toString('utf8') !== `${canonicalJson(report.manifest)}\n`
  )
    throw new Error('Backtest bundle integrity mismatch');
  deepFreeze(metadata);
  return { directory, hash: reportHash, report, metadata };
}
export async function writeBacktest(
  input: unknown,
  rootInput: string,
  codeVersion: string,
  factory?: StrategyFactory,
) {
  const report = validateBacktestReport(runBacktest(input, codeVersion, factory), factory),
    reportHash = canonicalHash(report),
    id = `backtest_${reportHash.slice(7)}`,
    json = `${canonicalJson(report)}\n`,
    markdown = formatBacktestReport(report),
    manifest = `${canonicalJson(report.manifest)}\n`,
    metadata = BacktestBundleSchema.parse({
      schemaVersion: 'backtest-bundle.v1',
      id,
      reportHash,
      manifestHash: report.manifestHash,
      files: {
        reportJson: hash(json),
        reportMarkdown: hash(markdown),
        manifestJson: hash(manifest),
      },
    });
  if (Buffer.byteLength(json) > limit || Buffer.byteLength(manifest) > limit)
    throw new Error('Backtest artifact limit');
  await mkdir(rootInput, { recursive: true });
  const root = await realpath(rootInput),
    stage = await mkdtemp(join(root, '.backtest-stage-')),
    directory = join(root, id);
  try {
    await synced(join(stage, 'report.json'), json);
    await synced(join(stage, 'report.md'), markdown);
    await synced(join(stage, 'manifest.json'), manifest);
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
      const old = await verifyBacktest(directory, factory);
      if (old.hash !== reportHash) throw new Error('Existing backtest mismatch', { cause: error });
    }
    return { directory, hash: reportHash, report, metadata };
  } finally {
    await cleanup(stage, root);
  }
}
