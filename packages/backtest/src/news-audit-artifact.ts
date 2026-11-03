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
import { NewsAuditBundleSchema, NewsAuditReportSchema } from '@crypto/contracts';
import { canonicalHash, canonicalJson, deepFreeze } from '@crypto/core';
import { runNewsAudit, newsAuditMarkdown } from './news-audit.js';
const limit = 64 * 1024 * 1024,
  hash = (v: string | Uint8Array) => `sha256:${createHash('sha256').update(v).digest('hex')}`;
async function cleanup(stage: string, root: string) {
  if (dirname(resolve(stage)) !== root || !basename(stage).startsWith('.news-audit-stage-'))
    throw new Error('Unsafe news audit staging cleanup');
  await rm(stage, { recursive: true, force: true });
}
async function bounded(path: string) {
  const s = await lstat(path);
  if (!s.isFile() || s.size > limit) throw new Error('News audit file limit/type');
  const bytes = await readFile(path);
  if (bytes.length > limit) throw new Error('News audit file limit');
  return bytes;
}
async function synced(path: string, text: string) {
  const h = await open(path, 'wx');
  try {
    await h.writeFile(text);
    await h.sync();
  } finally {
    await h.close();
  }
}
function texts(v: Awaited<ReturnType<typeof runNewsAudit>>) {
  const files: Record<string, string> = {
    'input.json': `${canonicalJson(v.input)}\n`,
    'report.json': `${canonicalJson(v.report)}\n`,
    'report.md': newsAuditMarkdown(v.report),
    'decisions.jsonl': v.journal,
    'extractions.json': `${canonicalJson(v.extractionArchive)}\n`,
    'handoff.json': `${canonicalJson(v.handoff)}\n`,
  };
  for (const [id, s] of v.snapshots)
    files[`snapshots/${id.slice(7)}.json`] = `${canonicalJson(s)}\n`;
  if (
    Object.values(files).some((t) => Buffer.byteLength(t) > limit) ||
    Object.values(files).reduce((n, t) => n + Buffer.byteLength(t), 0) > 128 * 1024 * 1024
  )
    throw new Error('News audit bundle byte budget');
  return files;
}
async function readBundle(input: string) {
  const directory = resolve(input);
  if (!(await lstat(directory)).isDirectory()) throw new Error('News audit directory type');
  const decode = (b: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(b);
  const metadata = NewsAuditBundleSchema.parse(
    JSON.parse(decode(await bounded(join(directory, 'bundle.json')))),
  );
  if (Object.keys(metadata.files).length > 358) throw new Error('News audit file work budget');
  let total = 0;
  for (const [file, expected] of Object.entries(metadata.files)) {
    const b = await bounded(join(directory, ...file.split('/')));
    total += b.length;
    if (total > 128 * 1024 * 1024 || hash(b) !== expected)
      throw new Error('News audit file checksum/budget');
  }
  const names = (await readdir(directory)).filter((n) => n !== 'snapshots'),
    snapshots = await readdir(join(directory, 'snapshots'));
  if (
    names.some((n) => n !== 'bundle.json' && !Object.hasOwn(metadata.files, n)) ||
    snapshots.some((n) => !Object.hasOwn(metadata.files, `snapshots/${n}`)) ||
    names.length - 1 + snapshots.length !== Object.keys(metadata.files).length
  )
    throw new Error('News audit file index mismatch');
  const report = NewsAuditReportSchema.parse(
      JSON.parse(decode(await bounded(join(directory, 'report.json')))),
    ),
    reportHash = canonicalHash(report);
  if (
    reportHash !== metadata.reportHash ||
    metadata.id !== `news-audit_${reportHash.slice(7)}` ||
    basename(directory) !== metadata.id
  )
    throw new Error('News audit report identity mismatch');
  const inputData: unknown = JSON.parse(decode(await bounded(join(directory, 'input.json'))));
  return { directory, hash: reportHash, report, metadata, input: inputData };
}
export async function verifyNewsAudit(directory: string) {
  const b = await readBundle(directory),
    replay = await runNewsAudit(b.input, b.report.codeVersion),
    expected = Object.fromEntries(
      Object.entries(texts(replay)).map(([file, text]) => [file, hash(text)]),
    );
  if (
    canonicalHash(replay.report) !== b.hash ||
    canonicalHash(expected) !== canonicalHash(b.metadata.files)
  )
    throw new Error('News audit semantic integrity mismatch');
  deepFreeze(b.report);
  deepFreeze(b.metadata);
  deepFreeze(b.input);
  return b;
}
export async function writeNewsAudit(input: unknown, rootInput: string, codeVersion: string) {
  const v = await runNewsAudit(input, codeVersion),
    files = texts(v),
    reportHash = canonicalHash(v.report),
    id = `news-audit_${reportHash.slice(7)}`;
  await mkdir(rootInput, { recursive: true });
  const root = await realpath(rootInput),
    stage = await mkdtemp(join(root, '.news-audit-stage-')),
    directory = join(root, id);
  try {
    await mkdir(join(stage, 'snapshots'));
    const index: Record<string, string> = {};
    for (const [file, text] of Object.entries(files)) {
      await synced(join(stage, ...file.split('/')), text);
      index[file] = hash(text);
    }
    const metadata = NewsAuditBundleSchema.parse({
      schemaVersion: 'news-audit-bundle.v1',
      id,
      reportHash,
      files: index,
    });
    await synced(join(stage, 'bundle.json'), `${canonicalJson(metadata)}\n`);
    try {
      await rename(stage, directory);
    } catch (e) {
      if (!(
        e instanceof Error &&
        'code' in e &&
        ['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(String(e.code))
      ))
        throw e;
      const old = await readBundle(directory);
      if (old.hash !== reportHash || canonicalHash(old.metadata) !== canonicalHash(metadata))
        throw new Error('Existing immutable news audit mismatch', { cause: e });
    }
    return { directory, hash: reportHash, report: v.report, metadata };
  } finally {
    await cleanup(stage, root);
  }
}
