import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  MarketDatasetSchema,
  MarketQualityArtifactSchema,
  MarketQualityReportRequestSchema,
} from '@crypto/contracts';
import { canonicalHash, canonicalJson, deepFreeze } from '@crypto/core';
import { SnapshotMarketData } from './market-data.js';

const limit = 16 * 1024 * 1024;
export function buildMarketQualityArtifact(
  datasetInput: unknown,
  requestInput: unknown,
  codeVersion: string,
) {
  const dataset = MarketDatasetSchema.parse(datasetInput),
    request = MarketQualityReportRequestSchema.parse(requestInput),
    data = new SnapshotMarketData(dataset);
  const artifact = MarketQualityArtifactSchema.parse({
    schemaVersion: 'market-quality-artifact.v1',
    algorithmVersion: data.schemaVersion,
    codeVersion,
    clockSemantics: 'utc-nanoseconds.v1',
    execution: 'DISABLED',
    dataset,
    datasetHash: data.datasetHash,
    request,
    configHash: canonicalHash(request),
    report: {
      universe: data.universe(request.universe),
      quality: request.quality.map((q) => data.quality(q)),
      comparisons: request.comparisons.map((q) => data.compare(q)),
      history: request.history.map((q) => data.history(q)),
    },
  });
  deepFreeze(artifact);
  return artifact;
}
export async function verifyMarketQualityArtifact(path: string) {
  const info = await lstat(path);
  if (!info.isFile() || info.size > limit) throw new Error('Invalid quality artifact');
  const bytes = await readFile(path);
  if (bytes.length > limit) throw new Error('Quality artifact limit');
  const artifact = MarketQualityArtifactSchema.parse(JSON.parse(bytes.toString('utf8')));
  const expected = buildMarketQualityArtifact(
    artifact.dataset,
    artifact.request,
    artifact.codeVersion,
  );
  const hash = canonicalHash(artifact),
    name = basename(path);
  if (
    canonicalHash(expected) !== hash ||
    (name.startsWith('market-quality_') && name !== `market-quality_${hash.slice(7)}.json`)
  )
    throw new Error('Quality artifact integrity mismatch');
  return { artifact, hash, path };
}
export async function writeMarketQualityArtifact(
  dataset: unknown,
  request: unknown,
  outputRoot: string,
  codeVersion: string,
) {
  const artifact = buildMarketQualityArtifact(dataset, request, codeVersion),
    hash = canonicalHash(artifact),
    body = `${canonicalJson(artifact)}\n`;
  if (Buffer.byteLength(body) > limit) throw new Error('Quality artifact limit');
  await mkdir(outputRoot, { recursive: true });
  const root = await realpath(outputRoot);
  const path = join(root, `market-quality_${hash.slice(7)}.json`),
    stage = join(root, `.quality-stage-${randomUUID()}`);
  await writeFile(stage, body, { flag: 'wx' });
  try {
    // Hard-link publication is atomic and refuses an existing target on both Windows/Unix.
    try {
      await link(stage, path);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      const existing = await verifyMarketQualityArtifact(path);
      if (existing.hash !== hash)
        throw new Error('Existing quality artifact mismatch', { cause: error });
    }
  } finally {
    await unlink(stage);
  }
  return verifyMarketQualityArtifact(path);
}
