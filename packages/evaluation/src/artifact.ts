import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { EvaluationPlanSchema, HashSchema, PaperReportSchema } from '@crypto/contracts';
import { canonicalHash, canonicalJson } from '@crypto/core';
import { evaluatePaperExperiment, evaluationEvidence, evaluationMarkdown } from './report.js';

const Input = z.strictObject({
  schemaVersion: z.literal('evaluation-input.v1'),
  paper: PaperReportSchema,
  plan: EvaluationPlanSchema,
  codeVersion: z.string().min(1).max(200),
});
const Bundle = z.strictObject({
  schemaVersion: z.literal('evaluation-bundle.v1'),
  reportHash: HashSchema,
  inputHash: HashSchema,
  files: z.record(
    z
      .string()
      .regex(/^(input\.json|report\.json|report\.md|metrics\.csv|evidence\/[a-f0-9]{64}\.json)$/),
    HashSchema,
  ),
});
const bytesHash = (s: string) => `sha256:${createHash('sha256').update(s).digest('hex')}`;
async function json(path: string, limit = 256 * 1024 * 1024): Promise<unknown> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit)
    throw new Error('Invalid evaluation file');
  const bytes = await readFile(path);
  if (bytes.length > limit) throw new Error('Evaluation file limit');
  return JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)) as unknown;
}
function filesFor(input: z.infer<typeof Input>) {
  const report = evaluatePaperExperiment(input.paper, input.plan, input.codeVersion),
    files = new Map<string, string>([
      ['input.json', `${canonicalJson(input)}\n`],
      ['report.json', `${canonicalJson(report)}\n`],
      ['report.md', evaluationMarkdown(report)],
      [
        'metrics.csv',
        `portfolio,net_pnl,net_return,closed_trades,profit_factor,max_drawdown\n${report.metrics.map((m) => [m.portfolio, m.netPnl ?? 'N/A', m.netReturn ?? 'N/A', m.closedTrades, m.profitFactor ?? 'N/A', m.maxDrawdown ?? 'N/A'].join(',')).join('\n')}\n`,
      ],
    ]);
  for (const e of evaluationEvidence(input.paper, input.plan))
    files.set(e.file, `${canonicalJson(e.value)}\n`);
  const metadata = Bundle.parse({
    schemaVersion: 'evaluation-bundle.v1',
    reportHash: report.hash,
    inputHash: canonicalHash(input),
    files: Object.fromEntries([...files].map(([k, v]) => [k, bytesHash(v)])),
  });
  return { report, files, metadata };
}
async function inventory(root: string, prefix = ''): Promise<string[]> {
  const names = [];
  for (const e of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isSymbolicLink()) throw new Error('Symlink in evaluation bundle');
    if (e.isDirectory() && path === 'evidence') names.push(...(await inventory(root, path)));
    else if (e.isFile()) names.push(path);
    else throw new Error('Unknown evaluation bundle entry');
  }
  return names.sort();
}
export async function verifyEvaluationBundle(directory: string) {
  const input = Input.parse(await json(join(directory, 'input.json'))),
    expected = filesFor(input),
    metadata = Bundle.parse(await json(join(directory, 'bundle.json'), 16 * 1024 * 1024));
  if (
    canonicalHash(metadata) !== canonicalHash(expected.metadata) ||
    basename(directory) !== `evaluation_${expected.report.hash.slice(7)}`
  )
    throw new Error('Evaluation bundle address or metadata integrity');
  const names = await inventory(directory),
    expectedNames = [...expected.files.keys(), 'bundle.json'].sort();
  if (canonicalHash(names) !== canonicalHash(expectedNames))
    throw new Error('Evaluation bundle inventory integrity');
  let total = 0;
  for (const [name, content] of expected.files) {
    const stat = await lstat(join(directory, name));
    total += stat.size;
    if (
      !stat.isFile() ||
      stat.size > 256 * 1024 * 1024 ||
      total > 512 * 1024 * 1024 ||
      (await readFile(join(directory, name), 'utf8')) !== content
    )
      throw new Error('Evaluation bundle semantic integrity');
  }
  return { directory, report: expected.report, metadata, input };
}
export async function writeEvaluationBundle(
  paper: unknown,
  plan: unknown,
  outputRoot: string,
  codeVersion = 'evaluation.v1',
) {
  const input = Input.parse({ schemaVersion: 'evaluation-input.v1', paper, plan, codeVersion }),
    built = filesFor(input),
    root = resolve(outputRoot);
  await mkdir(root, { recursive: true });
  if ((await lstat(root)).isSymbolicLink()) throw new Error('Invalid evaluation output root');
  const target = join(root, `evaluation_${built.report.hash.slice(7)}`),
    stage = join(root, `.evaluation-stage-${randomUUID()}`);
  try {
    await lstat(target);
    return await verifyEvaluationBundle(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (
    !resolve(stage).startsWith(`${root}${sep}`) ||
    !basename(stage).startsWith('.evaluation-stage-')
  )
    throw new Error('Invalid evaluation staging cleanup path');
  await mkdir(stage);
  await mkdir(join(stage, 'evidence'));
  try {
    const all = new Map(built.files);
    all.set('bundle.json', `${canonicalJson(built.metadata)}\n`);
    for (const [name, content] of all) {
      const file = await open(join(stage, name), 'wx', 0o600);
      try {
        await file.writeFile(content);
        await file.sync();
      } finally {
        await file.close();
      }
    }
    await rename(stage, target);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
  return { directory: target, report: built.report, metadata: built.metadata, input };
}
/** Never hide losing or inconclusive runs. Corrupt entries fail explicitly instead of disappearing. */
export async function listEvaluationRuns(root: string) {
  const rows = [];
  for (const name of (await readdir(root))
    .filter((n) => /^evaluation_[a-f0-9]{64}$/.test(n))
    .sort()) {
    const verified = await verifyEvaluationBundle(join(root, name));
    rows.push({
      directory: verified.directory,
      reportHash: verified.report.hash,
      recommendation: verified.report.memo.recommendation,
      outcomes: verified.report.metrics.map((m) => ({ portfolio: m.portfolio, netPnl: m.netPnl })),
    });
  }
  return rows;
}
