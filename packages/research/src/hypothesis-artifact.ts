import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { HypothesisRegistryArtifactSchema } from '@crypto/contracts';
import { canonicalHash, canonicalJson, deepFreeze } from '@crypto/core';
import { buildHypothesisRegistry } from './hypothesis-registry.js';

const limit = 64 * 1024 * 1024;
export function validateHypothesisRegistry(input: unknown) {
  const artifact = HypothesisRegistryArtifactSchema.parse(input),
    expected = buildHypothesisRegistry(artifact.input, artifact.request, artifact.codeVersion);
  if (canonicalHash(expected) !== canonicalHash(artifact))
    throw new Error('Hypothesis registry integrity mismatch');
  deepFreeze(artifact);
  return artifact;
}
export async function verifyHypothesisRegistry(path: string) {
  const info = await lstat(path);
  if (!info.isFile() || info.size > limit) throw new Error('Invalid hypothesis registry file');
  const bytes = await readFile(path);
  if (bytes.length > limit) throw new Error('Hypothesis registry limit');
  const artifact = validateHypothesisRegistry(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    ),
    hash = canonicalHash(artifact);
  if (basename(path) !== `hypothesis-registry_${hash.slice(7)}.json`)
    throw new Error('Hypothesis registry name mismatch');
  return { path, hash, artifact };
}
export async function writeHypothesisRegistry(
  input: unknown,
  request: unknown,
  outputRoot: string,
  codeVersion: string,
) {
  const artifact = buildHypothesisRegistry(input, request, codeVersion),
    hash = canonicalHash(artifact),
    body = `${canonicalJson(artifact)}\n`;
  if (Buffer.byteLength(body) > limit) throw new Error('Hypothesis registry limit');
  await mkdir(outputRoot, { recursive: true });
  const root = await realpath(outputRoot),
    path = join(root, `hypothesis-registry_${hash.slice(7)}.json`),
    stage = join(root, `.hypothesis-stage-${randomUUID()}`),
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
      if ((await verifyHypothesisRegistry(path)).hash !== hash)
        throw new Error('Existing registry mismatch', { cause: error });
    }
  } finally {
    await unlink(stage);
  }
  return verifyHypothesisRegistry(path);
}
