import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import {
  MarketArtifactSchema,
  MarketBaselineManifestSchema,
  MarketBundleSchema,
} from '@crypto/contracts';
import { canonicalHash, canonicalJson } from '@crypto/core';
import { marketFixtureSignals, runMarketBaseline } from './market-backtest.js';
const limit = 64 * 1024 * 1024;
const hash = (s: string | Uint8Array) => `sha256:${createHash('sha256').update(s).digest('hex')}`;
function build(input: unknown, code: string) {
  const m = MarketBaselineManifestSchema.parse(input);
  return m.provider.kind === 'SYMMETRIC_MA_FIXTURE'
    ? marketFixtureSignals(m, code)
    : runMarketBaseline(m, code);
}
type Report = ReturnType<typeof build>;
export function marketBaselineMarkdown(r: Report) {
  const m = r.manifest;
  const rows =
    r.execution === 'DISABLED'
      ? 'Signal-only symmetric synthetic fixture. No execution, borrowed inventory or short PnL.\n'
      : '| Role | Gross PnL | Fees | Net PnL | Net return | Fills |\n| --- | ---: | ---: | ---: | ---: | ---: |\n' +
        r.outcomes
          .map(
            (o) =>
              `| ${o.role} | ${o.metrics.grossPnl} | ${o.metrics.fees} | ${o.metrics.netPnl} | ${o.metrics.netReturn} | ${o.metrics.fillCount} |`,
          )
          .join('\n') +
        '\n';
  return `# Market baseline research\n\n${m.backtest.cohortDisclosure}\n\nProvider: ${m.provider.kind}; regime: ${m.regime}. Execution: ${r.execution}; live execution: DISABLED.\n\nManifest: ${canonicalHash(m)}\n\n${rows}\nFixed owned-asset target: ${m.backtest.quantity}. Post-receipt sizing at decision plus one nanosecond; pending orders block replacement, one attempt per target transition.\n\nOHLCV depth and intrabar paths are unknown. Scores encode target states, not probabilities. These fixed synthetic cases do not establish profitability or generalization. No model selection, ML or ranking.\n`;
}
async function bounded(path: string) {
  const s = await lstat(path);
  if (!s.isFile() || s.size > limit) throw new Error('Invalid market artifact');
  const b = await readFile(path);
  if (b.length > limit) throw new Error('Market artifact limit');
  return b;
}
async function synced(path: string, s: string) {
  if (Buffer.byteLength(s) > limit) throw new Error('Market artifact limit');
  const h = await open(path, 'wx');
  try {
    await h.writeFile(s);
    await h.sync();
  } finally {
    await h.close();
  }
}
async function cleanup(stage: string, root: string) {
  if (dirname(resolve(stage)) !== root || !basename(stage).startsWith('.market-stage-'))
    throw new Error('Unsafe market staging cleanup');
  await rm(stage, { recursive: true, force: true });
}
export async function verifyMarketBaseline(directoryInput: string) {
  const directory = resolve(directoryInput);
  if (!(await lstat(directory)).isDirectory()) throw new Error('Invalid market bundle directory');
  const decode = (b: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(b);
  const metadata = MarketBundleSchema.parse(
    JSON.parse(decode(await bounded(join(directory, 'bundle.json')))),
  );
  const json = await bounded(join(directory, 'report.json')),
    md = await bounded(join(directory, 'report.md')),
    manifest = await bounded(join(directory, 'manifest.json'));
  if (
    hash(json) !== metadata.files.reportJson ||
    hash(md) !== metadata.files.reportMarkdown ||
    hash(manifest) !== metadata.files.manifestJson
  )
    throw new Error('Market bundle checksum mismatch');
  const report = MarketArtifactSchema.parse(JSON.parse(decode(json))),
    rebuilt = build(
      report.manifest,
      report.execution === 'DISABLED' ? report.replay.manifest.codeVersion : report.codeVersion,
    ),
    reportHash = canonicalHash(rebuilt),
    id = `market-baseline_${reportHash.slice(7)}`;
  if (
    canonicalHash(report) !== reportHash ||
    metadata.reportHash !== reportHash ||
    metadata.manifestHash !== canonicalHash(report.manifest) ||
    metadata.id !== id ||
    basename(directory) !== id ||
    decode(md) !== marketBaselineMarkdown(rebuilt) ||
    decode(manifest) !== `${canonicalJson(report.manifest)}\n`
  )
    throw new Error('Market bundle semantic integrity mismatch');
  return { directory, hash: reportHash, report: rebuilt, metadata };
}
export async function writeMarketBaseline(input: unknown, rootInput: string, codeVersion: string) {
  const report = build(input, codeVersion),
    reportHash = canonicalHash(report),
    id = `market-baseline_${reportHash.slice(7)}`,
    json = `${canonicalJson(report)}\n`,
    markdown = marketBaselineMarkdown(report),
    manifest = `${canonicalJson(report.manifest)}\n`;
  const metadata = MarketBundleSchema.parse({
    schemaVersion: 'market-baseline-bundle.v1',
    id,
    reportHash,
    manifestHash: canonicalHash(report.manifest),
    files: { reportJson: hash(json), reportMarkdown: hash(markdown), manifestJson: hash(manifest) },
  });
  await mkdir(rootInput, { recursive: true });
  const root = await realpath(rootInput),
    stage = await mkdtemp(join(root, '.market-stage-')),
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
      if ((await verifyMarketBaseline(directory)).hash !== reportHash)
        throw new Error('Existing market report mismatch', { cause: error });
    }
    return { directory, hash: reportHash, report, metadata };
  } finally {
    await cleanup(stage, root);
  }
}
