import { mkdir, mkdtemp, open, readFile, lstat, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import {
  DatasetPanelArtifactSchema,
  DatasetPanelManifestSchema,
  DatasetPanelRowSchema,
} from '@crypto/contracts';
import type { DatasetPanelArtifact, DatasetPanelRow } from '@crypto/contracts';
import { byteHash } from '@crypto/connectors';
import { canonicalHash, canonicalJson, deterministicId, deepFreeze } from '@crypto/core';
import { buildDatasetPanel } from './dataset-panel.js';

const limit = 64 * 1024 * 1024,
  writer = 'duckdb-1.4.4/panel-parquet.v1' as const,
  baseColumns = [
    'row_id',
    'instrument_key',
    'source_id',
    'symbol',
    'group_id',
    'feature_as_of',
    'split',
    'max_input_available_at',
    'max_input_event_at',
  ];
const sqlString = (s: string) => `'${s.replaceAll("'", "''")}'`;
async function cleanStage(stage: string, root: string) {
  if (dirname(resolve(stage)) !== root || !basename(stage).startsWith('.panel-stage-'))
    throw new Error('Unsafe panel staging cleanup');
  await rm(stage, { recursive: true, force: true });
}
async function bounded(path: string, max = limit) {
  const info = await lstat(path);
  if (!info.isFile() || info.size > max) throw new Error('Invalid panel file');
  const b = await readFile(path);
  if (b.length > max) throw new Error('Panel file limit');
  return b;
}
async function synced(path: string, body: string) {
  const h = await open(path, 'wx');
  try {
    await h.writeFile(body);
    await h.sync();
  } finally {
    await h.close();
  }
}
const database = () =>
  DuckDBInstance.create(':memory:', {
    threads: '1',
    autoinstall_known_extensions: 'false',
    autoload_known_extensions: 'false',
    memory_limit: '512MB',
  });
function columns(a: DatasetPanelArtifact) {
  return {
    features: a.request.columns.map((name, i) => ({ name, parquetColumn: `feature_${i}` })),
    labels: a.request.horizonsBars.map((horizonBars) => ({
      horizonBars,
      parquetColumn: `label_${horizonBars}`,
    })),
  };
}
function flat(row: DatasetPanelRow, a: DatasetPanelArtifact) {
  return [
    row.id,
    row.instrumentKey,
    row.sourceId,
    row.symbol,
    row.groupId,
    row.featureAsOf,
    row.split,
    row.maxInputAvailableAt,
    row.maxInputEventAt,
    ...a.request.columns.map((name) => row.features.find((f) => f.name === name)!.value),
    ...a.request.horizonsBars.map((h) => row.labels.find((l) => l.horizonBars === h)!.value),
    canonicalJson(row),
  ];
}
async function parquet(path: string, a: DatasetPanelArtifact) {
  const d = await database();
  let connection;
  try {
    connection = await d.connect();
    const c = columns(a),
      names = [
        ...baseColumns,
        ...c.features.map((c) => c.parquetColumn),
        ...c.labels.map((c) => c.parquetColumn),
        'record_json',
      ];
    await connection.run(`CREATE TABLE panel (${names.map((n) => `${n} VARCHAR`).join(',')})`);
    const appender = await connection.createAppender('panel');
    try {
      for (const row of a.rows.filter((r) => r.status === 'INCLUDED')) {
        for (const v of flat(row, a)) {
          if (v === null) appender.appendNull();
          else appender.appendVarchar(v);
        }
        appender.endRow();
      }
    } finally {
      appender.closeSync();
    }
    await connection.run(
      `COPY (SELECT * FROM panel ORDER BY feature_as_of,instrument_key,row_id) TO ${sqlString(resolve(path))} (FORMAT PARQUET,COMPRESSION UNCOMPRESSED,ROW_GROUP_SIZE 2048,PARQUET_VERSION V1)`,
    );
  } finally {
    connection?.closeSync();
    d.closeSync();
  }
  const handle = await open(path, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
export function validateDatasetPanelArtifact(input: unknown) {
  const artifact = DatasetPanelArtifactSchema.parse(input),
    expected = buildDatasetPanel(artifact.input, artifact.request, artifact.codeVersion);
  if (canonicalHash(expected) !== canonicalHash(artifact))
    throw new Error('Dataset panel integrity mismatch');
  deepFreeze(artifact);
  return artifact;
}
async function readPanelParquet(path: string, a: DatasetPanelArtifact) {
  await bounded(path, 512 * 1024 * 1024);
  const d = await database();
  let connection;
  try {
    connection = await d.connect();
    const result = await connection.runAndReadAll(
        'SELECT * FROM read_parquet($path) ORDER BY feature_as_of,instrument_key,row_id LIMIT 10001',
        { path: resolve(path) },
      ),
      raw = result.getRowObjectsJson();
    if (raw.length > 10000) throw new Error('Panel row limit');
    const c = columns(a),
      names = [
        ...baseColumns,
        ...c.features.map((v) => v.parquetColumn),
        ...c.labels.map((v) => v.parquetColumn),
        'record_json',
      ];
    return raw.map((r) => {
      if (typeof r.record_json !== 'string' || Object.keys(r).length !== names.length)
        throw new Error('Panel Parquet schema mismatch');
      const row = DatasetPanelRowSchema.parse(JSON.parse(r.record_json));
      if (row.status !== 'INCLUDED') throw new Error('Excluded row in Parquet');
      const values = flat(row, a);
      for (let i = 0; i < names.length; i++)
        if (r[names[i]!] !== values[i]) throw new Error('Panel Parquet column mismatch');
      return row;
    });
  } finally {
    connection?.closeSync();
    d.closeSync();
  }
}
export async function verifyDatasetPanel(directoryInput: string) {
  const directory = resolve(directoryInput),
    manifest = DatasetPanelManifestSchema.parse(
      JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(
          await bounded(join(directory, 'manifest.json')),
        ),
      ),
    ),
    { id, ...body } = manifest;
  if (deterministicId('dataset-panel', body) !== id || basename(directory) !== id)
    throw new Error('Panel manifest identity mismatch');
  const file = await bounded(join(directory, 'artifact.json'));
  if (byteHash(file) !== manifest.artifactFileHash)
    throw new Error('Panel artifact file checksum mismatch');
  const artifact = validateDatasetPanelArtifact(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(file)),
    ),
    parquetBytes = await bounded(join(directory, 'panel.parquet'), 512 * 1024 * 1024),
    c = columns(artifact);
  if (
    canonicalHash(artifact) !== manifest.artifactHash ||
    artifact.inputHash !== manifest.inputHash ||
    artifact.configHash !== manifest.configHash ||
    artifact.codeVersion !== manifest.codeVersion ||
    artifact.request.generatedAt !== manifest.generatedAt ||
    canonicalHash(c.features) !== canonicalHash(manifest.featureColumns) ||
    canonicalHash(c.labels) !== canonicalHash(manifest.labelColumns) ||
    byteHash(parquetBytes) !== manifest.parquetHash
  )
    throw new Error('Panel manifest checksum mismatch');
  const rows = await readPanelParquet(join(directory, 'panel.parquet'), artifact),
    expected = artifact.rows.filter((r) => r.status === 'INCLUDED');
  if (
    rows.length !== manifest.rowCount ||
    canonicalHash(rows) !== manifest.rowsHash ||
    canonicalHash(expected) !== canonicalHash(rows)
  )
    throw new Error('Panel Parquet semantic mismatch');
  deepFreeze(manifest);
  deepFreeze(rows);
  return { directory, manifest, artifact, rows };
}
export async function writeDatasetPanel(
  input: unknown,
  request: unknown,
  outputRoot: string,
  codeVersion: string,
) {
  const artifact = buildDatasetPanel(input, request, codeVersion),
    text = `${canonicalJson(artifact)}\n`;
  if (Buffer.byteLength(text) > limit) throw new Error('Panel artifact limit');
  await mkdir(outputRoot, { recursive: true });
  const root = await realpath(outputRoot),
    stage = await mkdtemp(join(root, '.panel-stage-'));
  try {
    await synced(join(stage, 'artifact.json'), text);
    await parquet(join(stage, 'panel.parquet'), artifact);
    const c = columns(artifact),
      included = artifact.rows.filter((r) => r.status === 'INCLUDED'),
      body = {
        schemaVersion: 'dataset-panel-manifest.v1' as const,
        writer,
        artifactHash: canonicalHash(artifact),
        inputHash: artifact.inputHash,
        configHash: artifact.configHash,
        rowsHash: canonicalHash(included),
        parquetHash: byteHash(await bounded(join(stage, 'panel.parquet'), 512 * 1024 * 1024)),
        artifactFileHash: byteHash(text),
        codeVersion: artifact.codeVersion,
        generatedAt: artifact.request.generatedAt,
        rowCount: included.length,
        featureColumns: c.features,
        labelColumns: c.labels,
      },
      manifest = DatasetPanelManifestSchema.parse({
        ...body,
        id: deterministicId('dataset-panel', body),
      }),
      directory = join(root, manifest.id);
    await synced(join(stage, 'manifest.json'), `${canonicalJson(manifest)}\n`);
    try {
      await rename(stage, directory);
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        ['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(String(error.code))
      ))
        throw error;
      const old = await verifyDatasetPanel(directory);
      if (canonicalHash(old.manifest) !== canonicalHash(manifest))
        throw new Error('Existing panel mismatch', { cause: error });
    }
    return verifyDatasetPanel(directory);
  } finally {
    await cleanStage(stage, root);
  }
}
