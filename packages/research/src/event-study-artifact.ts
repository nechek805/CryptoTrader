import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { EventStudyArtifactSchema } from '@crypto/contracts';
import { canonicalHash, canonicalJson, deepFreeze } from '@crypto/core';
import { SnapshotEventStudy } from './event-study.js';

const limit = 64 * 1024 * 1024;
export function buildEventStudyArtifact(input: unknown, request: unknown, codeVersion: string) {
  const study = new SnapshotEventStudy(input);
  const artifact = EventStudyArtifactSchema.parse({
    schemaVersion: 'event-study-artifact.v1',
    algorithmVersion: 'exact-close-event-study.v1',
    clockSemantics: 'utc-nanoseconds.v1',
    randomSeed: 0,
    codeVersion,
    input: study.input,
    result: study.run(request),
  });
  deepFreeze(artifact);
  return artifact;
}
export function validateEventStudyArtifact(input: unknown) {
  const artifact = EventStudyArtifactSchema.parse(input),
    expected = buildEventStudyArtifact(
      artifact.input,
      artifact.result.request,
      artifact.codeVersion,
    );
  if (canonicalHash(expected) !== canonicalHash(artifact))
    throw new Error('Event study integrity mismatch');
  deepFreeze(artifact);
  return artifact;
}
export async function verifyEventStudyArtifact(path: string) {
  const info = await lstat(path);
  if (!info.isFile() || info.size > limit) throw new Error('Invalid study artifact');
  const bytes = await readFile(path);
  if (bytes.length > limit) throw new Error('Study artifact limit');
  const artifact = validateEventStudyArtifact(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    ),
    hash = canonicalHash(artifact);
  if (basename(path) !== `event-study_${hash.slice(7)}.json`)
    throw new Error('Study artifact name mismatch');
  return { artifact, hash, path };
}
export async function writeEventStudyArtifact(
  input: unknown,
  request: unknown,
  outputRoot: string,
  codeVersion: string,
) {
  const artifact = buildEventStudyArtifact(input, request, codeVersion),
    hash = canonicalHash(artifact),
    body = `${canonicalJson(artifact)}\n`;
  if (Buffer.byteLength(body) > limit) throw new Error('Study artifact limit');
  await mkdir(outputRoot, { recursive: true });
  const root = await realpath(outputRoot),
    path = join(root, `event-study_${hash.slice(7)}.json`),
    stage = join(root, `.study-stage-${randomUUID()}`),
    handle = await open(stage, 'wx');
  try {
    await handle.writeFile(body);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    try {
      await link(stage, path);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      if ((await verifyEventStudyArtifact(path)).hash !== hash)
        throw new Error('Existing study mismatch', { cause: error });
    }
  } finally {
    await unlink(stage);
  }
  return verifyEventStudyArtifact(path);
}
