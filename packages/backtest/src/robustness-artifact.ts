import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  readdir,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { MarketRobustnessBundleSchema, MarketRobustnessReportSchema } from '@crypto/contracts';
import type { MarketRobustnessReport } from '@crypto/contracts';
import { canonicalHash, canonicalJson } from '@crypto/core';
import { runMarketRobustness, validateRobustnessPlan } from './robustness-runner.js';
const limit = 64 * 1024 * 1024,
  hash = (s: Uint8Array | string) => `sha256:${createHash('sha256').update(s).digest('hex')}`;
export function robustnessMarkdown(r: MarketRobustnessReport) {
  return `# Market robustness research\n\nExecution SIMULATED; live execution DISABLED; synthetic: ${r.synthetic}.\n\nPlan ${r.planHash}; experiment ${r.plan.experimentVersion}. Every trial/cell is disclosed below.\n\nAttempts: ${r.attemptCount}; declared prior attempts: ${r.plan.priorTrialCount}; imported calibration trials: ${r.importedCalibrationTrials}; conservative multiple-comparison family: **${r.familySize}**.\n\nRanking: mean net return − worst sampled drawdown − downside empirical cell CVaR(5%). No annualized Sharpe or claim of definitive profitability.\n\n| Rank | Trial | Mean net | Worst DD | Cell tail CVaR | Risk-adjusted net score | Marginal 95% conditional interval | Holm p | Uncertainty |\n| --- | --- | ---: | ---: | ---: | ---: | --- | --- | --- |\n${r.rankings.map((v) => `| ${v.rank} | ${v.trialId} | ${v.meanNetReturn} | ${v.worstDrawdown} | ${v.tailCvar05} | ${v.score} | ${JSON.stringify(v.uncertainty.marginal95)} | ${v.uncertainty.holmP} | ${v.uncertainty.reason} |`).join('\n')}\n\n## All attempted cells\n\n| Trial | Scenario | Status | Net return | Fees | DD | Fills | Cash | Buy-and-hold |\n| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |\n${r.attempts.map((v) => `| ${v.trialId} | ${v.scenarioId} | ${v.status} | ${v.metrics?.netReturn ?? null} | ${v.metrics?.fees ?? null} | ${v.metrics?.maxDrawdownFraction ?? null} | ${v.metrics?.fillCount ?? null} | ${v.cashNetReturn} | ${v.buyAndHoldNetReturn} |`).join('\n')}\n\n## Parameter and feature instability\n\n${r.instability.map((v) => `- ${v.trialId} vs ${v.parentTrialId}: ${v.signFlipCases} return sign flips; ${v.changedSignalEvents}/${v.comparedSignalEvents} changed signal events; max absolute net delta ${v.maxAbsoluteNetDelta}.`).join('\n')}\n\n## Immutable handoff / archive\n\n${r.selection.map((v) => `- ${v.trialId}: ${v.status}; ${v.reasons.join(', ')}; producer ${v.producerHash}; feature ${v.featureHash}; a new forward experiment is required.`).join('\n')}\n\n${r.warnings.map((v) => `- ${v}`).join('\n')}\n`;
}
async function bounded(path: string) {
  const s = await lstat(path);
  if (!s.isFile() || s.size > limit) throw new Error('Invalid robustness file');
  const b = await readFile(path);
  if (b.length > limit) throw new Error('Robustness byte limit');
  return b;
}
async function synced(path: string, text: string) {
  if (Buffer.byteLength(text) > limit) throw new Error('Robustness byte limit');
  const h = await open(path, 'wx');
  try {
    await h.writeFile(text);
    await h.sync();
  } finally {
    await h.close();
  }
}
async function cleanup(stage: string, root: string) {
  if (dirname(resolve(stage)) !== root || !basename(stage).startsWith('.robustness-stage-'))
    throw new Error('Unsafe robustness staging cleanup');
  await rm(stage, { recursive: true, force: true });
}
async function readBundle(directoryInput: string) {
  const directory = resolve(directoryInput);
  if (!(await lstat(directory)).isDirectory()) throw new Error('Invalid robustness directory');
  const metadata = MarketRobustnessBundleSchema.parse(
    JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        await bounded(join(directory, 'bundle.json')),
      ),
    ),
  );
  for (const [name, expected] of Object.entries(metadata.files))
    if (hash(await bounded(join(directory, ...name.split('/')))) !== expected)
      throw new Error('Robustness file checksum mismatch');
  const actual = (await readdir(directory)).filter((n) => n !== 'evidence');
  if (actual.some((n) => n !== 'bundle.json' && !Object.hasOwn(metadata.files, n)))
    throw new Error('Unindexed robustness file');
  const names = await readdir(join(directory, 'evidence'));
  if (
    names.some((n) => !Object.hasOwn(metadata.files, `evidence/${n}`)) ||
    Object.keys(metadata.files).length !== actual.length - 1 + names.length
  )
    throw new Error('Robustness evidence index mismatch');
  const report = MarketRobustnessReportSchema.parse(
    JSON.parse((await bounded(join(directory, 'report.json'))).toString('utf8')),
  );
  if (
    metadata.reportHash !== canonicalHash(report) ||
    metadata.id !== `market-robustness_${metadata.reportHash.slice(7)}` ||
    basename(directory) !== metadata.id
  )
    throw new Error('Robustness report identity mismatch');
  return { directory, metadata, report, hash: metadata.reportHash };
}
/** Full semantic verification rebuilds every successful OR failed planned cell and hash chain. */
export async function verifyMarketRobustness(directoryInput: string) {
  const b = await readBundle(directoryInput),
    files: Record<string, string> = {},
    lines: string[] = [];
  const rebuilt = await runMarketRobustness(b.report.plan, b.report.codeVersion, {
    journal: (entry) => {
      lines.push(`${canonicalJson(entry)}\n`);
      return Promise.resolve();
    },
    evidence: (name, e) => {
      files[`evidence/${name}.json`] = hash(`${canonicalJson(e)}\n`);
      return Promise.resolve();
    },
  });
  files['journal.jsonl'] = hash(lines.join(''));
  files['plan.json'] = hash(`${canonicalJson(rebuilt.report.plan)}\n`);
  files['report.json'] = hash(`${canonicalJson(rebuilt.report)}\n`);
  files['report.md'] = hash(robustnessMarkdown(rebuilt.report));
  // v1 development bundles carried archive/handoff content in report.json only.
  // v2 also requires the separately indexed immutable receipts.
  if (b.metadata.schemaVersion === 'market-robustness-bundle.v1') {
    delete files['evidence/robust-handoff.json'];
    delete files['evidence/robust-archive.json'];
  }
  if (
    canonicalHash(rebuilt.report) !== b.hash ||
    canonicalHash(files) !== canonicalHash(b.metadata.files)
  )
    throw new Error('Robustness semantic/journal integrity mismatch');
  return b;
}
export async function writeMarketRobustness(
  input: unknown,
  rootInput: string,
  codeVersion: string,
  parentDirectory?: string,
) {
  const plan = validateRobustnessPlan(input);
  if (plan.parentReportHash !== null) {
    if (!parentDirectory) throw new Error('Parent robustness report is required');
    const parent = await verifyMarketRobustness(parentDirectory);
    if (
      parent.hash !== plan.parentReportHash ||
      plan.priorTrialCount < parent.report.familySize ||
      plan.experimentVersion === parent.report.plan.experimentVersion
    )
      throw new Error('Parent count/version lineage mismatch');
  } else if (parentDirectory) throw new Error('Unexpected parent report');
  await mkdir(rootInput, { recursive: true });
  if ((await readdir(rootInput)).some((name) => name.startsWith('.robustness-stage-')))
    throw new Error(
      'Unfinished robustness journal requires explicit review; do not reset attempt history',
    );
  const root = await realpath(rootInput),
    stage = await mkdtemp(join(root, '.robustness-stage-'));
  await mkdir(join(stage, 'evidence'));
  const files: Record<string, string> = {},
    journal = await open(join(stage, 'journal.jsonl'), 'wx');
  let published = false;
  try {
    const planText = `${canonicalJson(plan)}\n`;
    await synced(join(stage, 'plan.json'), planText);
    files['plan.json'] = hash(planText);
    const result = await runMarketRobustness(plan, codeVersion, {
      journal: async (entry) => {
        await journal.writeFile(`${canonicalJson(entry)}\n`);
        await journal.sync();
      },
      evidence: async (name, e) => {
        const file = `evidence/${name}.json`,
          text = `${canonicalJson(e)}\n`;
        await synced(join(stage, 'evidence', `${name}.json`), text);
        files[file] = hash(text);
      },
    });
    await journal.close();
    files['journal.jsonl'] = hash(await bounded(join(stage, 'journal.jsonl')));
    const report = result.report,
      reportHash = canonicalHash(report),
      id = `market-robustness_${reportHash.slice(7)}`,
      directory = join(root, id),
      json = `${canonicalJson(report)}\n`,
      markdown = robustnessMarkdown(report);
    await synced(join(stage, 'report.json'), json);
    await synced(join(stage, 'report.md'), markdown);
    files['report.json'] = hash(json);
    files['report.md'] = hash(markdown);
    const metadata = MarketRobustnessBundleSchema.parse({
      schemaVersion: 'market-robustness-bundle.v2',
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
      if (old.hash !== reportHash || canonicalHash(old.metadata) !== canonicalHash(metadata))
        throw new Error('Existing robustness bundle mismatch', { cause: error });
    }
    published = true;
    return { directory, hash: reportHash, report, metadata };
  } finally {
    await journal.close();
    if (published) await cleanup(stage, root);
  }
  // Interrupted stages deliberately remain: plan, synced attempt chain and completed evidence.
}
