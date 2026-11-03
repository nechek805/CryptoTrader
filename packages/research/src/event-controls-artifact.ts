import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { EventControlsArtifactSchema } from '@crypto/contracts';
import { canonicalHash, canonicalJson, deepFreeze } from '@crypto/core';
import { SnapshotEventControls } from './event-controls.js';

const limit = 64 * 1024 * 1024;
export function buildEventControlsArtifact(input: unknown, request: unknown, codeVersion: string) {
  const controls = new SnapshotEventControls(input),
    artifact = EventControlsArtifactSchema.parse({
      schemaVersion: 'event-controls-artifact.v1',
      algorithmVersion: 'event-controls.v1',
      clockSemantics: 'utc-nanoseconds.v1',
      randomAlgorithm: 'mulberry32.v1',
      codeVersion,
      input: controls.study.input,
      result: controls.run(request),
    });
  deepFreeze(artifact);
  return artifact;
}
export function validateEventControlsArtifact(input: unknown) {
  const artifact = EventControlsArtifactSchema.parse(input),
    expected = buildEventControlsArtifact(
      artifact.input,
      artifact.result.request,
      artifact.codeVersion,
    );
  if (canonicalHash(expected) !== canonicalHash(artifact))
    throw new Error('Controls artifact integrity mismatch');
  deepFreeze(artifact);
  return artifact;
}
export async function verifyEventControlsArtifact(path: string) {
  const info = await lstat(path);
  if (!info.isFile() || info.size > limit) throw new Error('Invalid controls artifact');
  const bytes = await readFile(path);
  if (bytes.length > limit) throw new Error('Controls artifact limit');
  const artifact = validateEventControlsArtifact(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    ),
    hash = canonicalHash(artifact);
  if (basename(path) !== `event-controls_${hash.slice(7)}.json`)
    throw new Error('Controls artifact name mismatch');
  return { path, hash, artifact };
}
export async function writeEventControlsArtifact(
  input: unknown,
  request: unknown,
  outputRoot: string,
  codeVersion: string,
) {
  const artifact = buildEventControlsArtifact(input, request, codeVersion),
    hash = canonicalHash(artifact),
    body = `${canonicalJson(artifact)}\n`;
  if (Buffer.byteLength(body) > limit) throw new Error('Controls artifact limit');
  await mkdir(outputRoot, { recursive: true });
  const root = await realpath(outputRoot),
    path = join(root, `event-controls_${hash.slice(7)}.json`),
    stage = join(root, `.controls-stage-${randomUUID()}`),
    handle = await open(stage, 'wx');
  try {
    try {
      await handle.writeFile(body);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(stage, path);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      if ((await verifyEventControlsArtifact(path)).hash !== hash)
        throw new Error('Existing controls mismatch', { cause: error });
    }
  } finally {
    await unlink(stage);
  }
  return verifyEventControlsArtifact(path);
}
