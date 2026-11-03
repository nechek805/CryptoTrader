import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { TechnicalFeatureArtifactSchema, TechnicalFeatureRequestSchema } from '@crypto/contracts';
import { canonicalHash, canonicalJson, deepFreeze } from '@crypto/core';
import { SnapshotTechnicalFeatures } from './technical-features.js';
import { technicalFeatureCatalog } from './feature-catalog.js';

const limit = 64 * 1024 * 1024;
export function buildTechnicalFeatureArtifact(
  input: unknown,
  requestInput: unknown,
  codeVersion: string,
) {
  const engine = new SnapshotTechnicalFeatures(input),
    request = TechnicalFeatureRequestSchema.parse(requestInput),
    rows = request.featureAsOf.map((featureAsOf) =>
      engine.query({
        schemaVersion: 'technical-feature-query.v1',
        series: request.series,
        intervalSeconds: request.intervalSeconds,
        historyStartCloseAt: request.historyStartCloseAt,
        config: request.config,
        featureAsOf,
      }),
    ),
    artifact = TechnicalFeatureArtifactSchema.parse({
      schemaVersion: 'technical-feature-artifact.v1',
      algorithmVersion: 'technical-features.v1',
      execution: 'DISABLED',
      clockSemantics: 'utc-nanoseconds.v1',
      randomSeed: 0,
      codeVersion,
      input: engine.input,
      inputHash: engine.datasetHash,
      request,
      configHash: canonicalHash(request),
      catalog: technicalFeatureCatalog(request.config),
      rows,
    });
  deepFreeze(artifact);
  return artifact;
}
export function validateTechnicalFeatureArtifact(input: unknown) {
  const artifact = TechnicalFeatureArtifactSchema.parse(input),
    expected = buildTechnicalFeatureArtifact(
      artifact.input,
      artifact.request,
      artifact.codeVersion,
    );
  if (canonicalHash(expected) !== canonicalHash(artifact))
    throw new Error('Technical feature artifact integrity mismatch');
  deepFreeze(artifact);
  return artifact;
}
export async function verifyTechnicalFeatureArtifact(path: string) {
  const info = await lstat(path);
  if (!info.isFile() || info.size > limit) throw new Error('Invalid feature artifact');
  const bytes = await readFile(path);
  if (bytes.length > limit) throw new Error('Feature artifact limit');
  const artifact = validateTechnicalFeatureArtifact(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    ),
    hash = canonicalHash(artifact);
  if (basename(path) !== `technical-features_${hash.slice(7)}.json`)
    throw new Error('Feature artifact name mismatch');
  return { path, hash, artifact };
}
export async function writeTechnicalFeatureArtifact(
  input: unknown,
  request: unknown,
  outputRoot: string,
  codeVersion: string,
) {
  const artifact = buildTechnicalFeatureArtifact(input, request, codeVersion),
    hash = canonicalHash(artifact),
    body = `${canonicalJson(artifact)}\n`;
  if (Buffer.byteLength(body) > limit) throw new Error('Feature artifact limit');
  await mkdir(outputRoot, { recursive: true });
  const root = await realpath(outputRoot),
    path = join(root, `technical-features_${hash.slice(7)}.json`),
    stage = join(root, `.feature-stage-${randomUUID()}`),
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
      if ((await verifyTechnicalFeatureArtifact(path)).hash !== hash)
        throw new Error('Existing feature artifact mismatch', { cause: error });
    }
  } finally {
    await unlink(stage);
  }
  return verifyTechnicalFeatureArtifact(path);
}
export function technicalFeatureReport(input: unknown) {
  const a = validateTechnicalFeatureArtifact(input),
    lines = [
      '# Deterministic technical features',
      '',
      `Dataset: ${a.inputHash}`,
      `Config: ${a.configHash}`,
      `Software: ${a.codeVersion}`,
      'UTC fixed closes; only inputs closed and available at each feature as-of. Input availability bounds do not assert historical feature computation/publication time. Liquidity is a candle-volume proxy; order-book liquidity is unavailable.',
      '',
      '| As-of | Anchor close | Feature | Status | Value | Max input available |',
      '| --- | --- | --- | --- | --- | --- |',
    ];
  for (const row of a.rows) {
    for (const f of row.features)
      lines.push(
        `| ${row.request.featureAsOf} | ${row.anchorCloseAt} | ${f.featureId} | ${f.status} | ${f.value ?? 'missing'} | ${f.maxInputAvailableAt ?? 'none'} |`,
      );
    lines.push(
      '',
      `Coverage ${row.coverage.availableBars}/${row.coverage.expectedBars}; flags: ${row.liquidity.flags.join(', ')}. Source IDs: ${row.sourceIds.join(', ') || 'none'}.`,
      '',
    );
  }
  lines.push(
    '## Feature catalog',
    '',
    '| Feature | Version | Warm-up bars | Formula |',
    '| --- | --- | --- | --- |',
  );
  for (const d of a.catalog)
    lines.push(`| ${d.featureId} | ${d.version} | ${d.warmupBars} | ${d.formula} |`);
  lines.push(
    '',
    'Missing values are null with reasons. Nothing is forward-filled or extrapolated, and no signal, fill, training panel or regime is produced.',
    '',
  );
  return lines.join('\n');
}
