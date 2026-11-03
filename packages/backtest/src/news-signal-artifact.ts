import { createHash } from 'node:crypto';
import {
  lstat,
  readFile,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rename,
  readdir,
  rm,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { NewsSignalBundleSchema, NewsSignalReportSchema } from '@crypto/contracts';
import { canonicalHash, canonicalJson, deepFreeze } from '@crypto/core';
import { replayNewsSignals, newsSignalMarkdown } from './news-signal-replay.js';
const limit = 64 * 1024 * 1024,
  hash = (s: string | Uint8Array) => `sha256:${createHash('sha256').update(s).digest('hex')}`;
async function bounded(path: string) {
  const s = await lstat(path);
  if (!s.isFile() || s.size > limit) throw new Error('Invalid news signal artifact');
  const b = await readFile(path);
  if (b.length > limit) throw new Error('News signal byte limit');
  return b;
}
async function synced(path: string, text: string) {
  if (Buffer.byteLength(text) > limit) throw new Error('News signal byte limit');
  const h = await open(path, 'wx');
  try {
    await h.writeFile(text);
    await h.sync();
  } finally {
    await h.close();
  }
}
async function cleanup(stage: string, root: string) {
  if (dirname(resolve(stage)) !== root || !basename(stage).startsWith('.news-signal-stage-'))
    throw new Error('Unsafe news signal staging cleanup');
  await rm(stage, { recursive: true, force: true });
}
async function readBundle(input: string) {
  const directory = resolve(input);
  if (!(await lstat(directory)).isDirectory()) throw new Error('Invalid news signal directory');
  const decode = (b: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(b),
    metadata = NewsSignalBundleSchema.parse(
      JSON.parse(decode(await bounded(join(directory, 'bundle.json')))),
    );
  for (const [file, expected] of Object.entries(metadata.files))
    if (hash(await bounded(join(directory, ...file.split('/')))) !== expected)
      throw new Error('News signal file checksum mismatch');
  const actual = (await readdir(directory)).filter((n) => n !== 'snapshots'),
    snapshots = await readdir(join(directory, 'snapshots'));
  if (
    actual.some((n) => n !== 'bundle.json' && !Object.hasOwn(metadata.files, n)) ||
    snapshots.some((n) => !Object.hasOwn(metadata.files, `snapshots/${n}`)) ||
    actual.length - 1 + snapshots.length !== Object.keys(metadata.files).length
  )
    throw new Error('News signal file index mismatch');
  const report = NewsSignalReportSchema.parse(
      JSON.parse(decode(await bounded(join(directory, 'report.json')))),
    ),
    reportHash = canonicalHash(report);
  if (
    reportHash !== metadata.reportHash ||
    metadata.id !== `news-signals_${reportHash.slice(7)}` ||
    basename(directory) !== metadata.id
  )
    throw new Error('News signal report identity mismatch');
  return { directory, hash: reportHash, report, metadata };
}
export async function verifyNewsSignals(directory: string) {
  const b = await readBundle(directory),
    files: Record<string, string> = {},
    lines: string[] = [];
  const r = await replayNewsSignals(b.report.manifest, b.report.codeVersion, {
    snapshot: (id, value) => {
      files[`snapshots/${id.slice(7)}.json`] = hash(`${canonicalJson(value)}\n`);
      return Promise.resolve();
    },
    decision: (r) => {
      lines.push(`${canonicalJson(r)}\n`);
      return Promise.resolve();
    },
  });
  files['manifest.json'] = hash(`${canonicalJson(r.manifest)}\n`);
  files['report.json'] = hash(`${canonicalJson(r)}\n`);
  files['report.md'] = hash(newsSignalMarkdown(r));
  files['decisions.jsonl'] = hash(lines.join(''));
  if (canonicalHash(r) !== b.hash || canonicalHash(files) !== canonicalHash(b.metadata.files))
    throw new Error('News signal semantic snapshot/decision integrity mismatch');
  deepFreeze(b.report);
  deepFreeze(b.metadata);
  return b;
}
export async function writeNewsSignals(input: unknown, rootInput: string, codeVersion: string) {
  // Validate and finish the bounded replay before publishing any externally visible bundle.
  const snapshots = new Map<string, string>(),
    lines: string[] = [];
  const report = await replayNewsSignals(input, codeVersion, {
      snapshot: (id, value) => {
        snapshots.set(id, `${canonicalJson(value)}\n`);
        return Promise.resolve();
      },
      decision: (r) => {
        lines.push(`${canonicalJson(r)}\n`);
        return Promise.resolve();
      },
    }),
    reportHash = canonicalHash(report),
    id = `news-signals_${reportHash.slice(7)}`;
  await mkdir(rootInput, { recursive: true });
  const root = await realpath(rootInput),
    stage = await mkdtemp(join(root, '.news-signal-stage-')),
    directory = join(root, id),
    files: Record<string, string> = {};
  try {
    await mkdir(join(stage, 'snapshots'));
    for (const [snapshot, text] of snapshots) {
      const file = `snapshots/${snapshot.slice(7)}.json`;
      await synced(join(stage, ...file.split('/')), text);
      files[file] = hash(text);
    }
    for (const [file, text] of [
      ['manifest.json', `${canonicalJson(report.manifest)}\n`],
      ['report.json', `${canonicalJson(report)}\n`],
      ['report.md', newsSignalMarkdown(report)],
      ['decisions.jsonl', lines.join('')],
    ] as const) {
      await synced(join(stage, file), text);
      files[file] = hash(text);
    }
    const metadata = NewsSignalBundleSchema.parse({
      schemaVersion: 'news-signal-bundle.v1',
      id,
      reportHash,
      files,
    });
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
      const old = await readBundle(directory);
      if (canonicalHash(old.metadata) !== canonicalHash(metadata) || old.hash !== reportHash)
        throw new Error('Existing immutable news signal bundle mismatch', { cause: error });
    }
    return { directory, hash: reportHash, report, metadata };
  } finally {
    await cleanup(stage, root);
  }
}
