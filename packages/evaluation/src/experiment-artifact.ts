import { lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, join, resolve, sep } from 'node:path';
import { canonicalHash, canonicalJson } from '@crypto/core';
import { assessExperiment, experimentFindingsMarkdown } from './experiment-assessment.js';
import { verifyTrialRun } from './experiment-runtime.js';
import { readTrialJson } from './experiment-store.js';
import { writeEvaluationBundle, verifyEvaluationBundle } from './artifact.js';

export async function verifyTrialBundle(directory: string) {
  if ((await lstat(directory)).isSymbolicLink()) throw new Error('Symlink trial bundle');
  const run = verifyTrialRun(await readTrialJson(join(directory, 'run.json'))),
    assessment = assessExperiment(run);
  if (
    basename(directory) !== `trial_${assessment.hash.slice(7)}` ||
    canonicalHash(await readTrialJson(join(directory, 'manifest.json'), 1024 * 1024)) !==
      canonicalHash(run.manifest) ||
    canonicalHash(await readTrialJson(join(directory, 'assessment.json'))) !==
      canonicalHash(assessment) ||
    (await readFile(join(directory, 'findings.md'), 'utf8')) !==
      experimentFindingsMarkdown(assessment)
  )
    throw new Error('Trial assessment semantic integrity');
  const expected = ['assessment.json', 'evaluation', 'findings.md', 'manifest.json', 'run.json'];
  if (canonicalHash((await readdir(directory)).sort()) !== canonicalHash(expected))
    throw new Error('Trial bundle inventory integrity');
  const nested = join(directory, 'evaluation', `evaluation_${assessment.evaluation.hash.slice(7)}`),
    verified = await verifyEvaluationBundle(nested);
  if (
    canonicalHash(verified.report) !== canonicalHash(assessment.evaluation) ||
    (await readdir(join(directory, 'evaluation'))).length !== 1
  )
    throw new Error('Trial evaluation binding');
  return { directory, run, assessment };
}
export async function writeTrialBundle(input: unknown, outputRoot: string) {
  const run = verifyTrialRun(input),
    assessment = assessExperiment(run),
    root = resolve(outputRoot);
  await mkdir(root, { recursive: true });
  if ((await lstat(root)).isSymbolicLink()) throw new Error('Symlink trial root');
  const target = join(root, `trial_${assessment.hash.slice(7)}`);
  try {
    await lstat(target);
    return await verifyTrialBundle(target);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const stage = join(root, `.trial-bundle-${randomUUID()}`);
  if (!resolve(stage).startsWith(root + sep) || !basename(stage).startsWith('.trial-bundle-'))
    throw new Error('Invalid staging cleanup path');
  await mkdir(stage);
  try {
    for (const [name, bytes] of [
      ['manifest.json', canonicalJson(run.manifest) + '\n'],
      ['run.json', canonicalJson(run) + '\n'],
      ['assessment.json', canonicalJson(assessment) + '\n'],
      ['findings.md', experimentFindingsMarkdown(assessment)],
    ]) {
      const file = await open(join(stage, name!), 'wx', 0o600);
      try {
        await file.writeFile(bytes!);
        await file.sync();
      } finally {
        await file.close();
      }
    }
    await writeEvaluationBundle(
      run.paper,
      run.manifest.protocol.evaluation,
      join(stage, 'evaluation'),
      run.manifest.protocol.codeVersion,
    );
    await rename(stage, target);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
  return { directory: target, run, assessment };
}
