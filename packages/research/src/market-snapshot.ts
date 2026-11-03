import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import {
  ImportedMarketBarSchema,
  MarketSnapshotManifestSchema,
  NormalizedMarketImportSchema,
} from '@crypto/contracts';
import type {
  ImportedMarketBar,
  MarketSnapshotManifest,
  NormalizedMarketImport,
} from '@crypto/contracts';
import { canonicalHash, canonicalJson, deterministicId } from '@crypto/core';
import { byteHash, MarketImportError } from '@crypto/connectors';

export type MarketSnapshot = {
  directory: string;
  manifest: MarketSnapshotManifest;
  metadataHash: string;
};
const writer = 'duckdb-1.4.4/parquet-v1' as const;
const sqlString = (value: string) => `'${value.replaceAll("'", "''")}'`;
async function boundedRead(path: string, limit: number): Promise<Buffer> {
  const info = await stat(path);
  if (!info.isFile() || info.size > limit) throw new MarketImportError('LIMIT');
  const bytes = await readFile(path);
  if (bytes.length > limit) throw new MarketImportError('LIMIT');
  return bytes;
}
async function openDuckDB() {
  return DuckDBInstance.create(':memory:', {
    threads: '1',
    autoinstall_known_extensions: 'false',
    autoload_known_extensions: 'false',
    memory_limit: '512MB',
  });
}
async function writeParquet(path: string, bars: ImportedMarketBar[]): Promise<void> {
  const instance = await openDuckDB();
  let connection;
  try {
    connection = await instance.connect();
    await connection.run(
      'CREATE TABLE bars (instrument_id VARCHAR,open_at VARCHAR,close_at VARCHAR,open VARCHAR,high VARCHAR,low VARCHAR,close VARCHAR,volume VARCHAR,available_at VARCHAR,research_use VARCHAR,source_file_hash VARCHAR,source_line INTEGER,record_json VARCHAR)',
    );
    const appender = await connection.createAppender('bars');
    try {
      for (const row of bars) {
        const bar = row.bar;
        for (const value of [
          bar.instrumentId,
          bar.openAt,
          bar.closeAt,
          bar.open,
          bar.high,
          bar.low,
          bar.close,
          bar.volume,
          bar.availableAt,
          bar.researchUse,
          row.source.fileHash,
        ]) {
          if (value === null) appender.appendNull();
          else appender.appendVarchar(value);
        }
        appender.appendInteger(row.row.line);
        appender.appendVarchar(canonicalJson(row));
        appender.endRow();
      }
    } finally {
      appender.closeSync();
    }
    await connection.run(
      `COPY (SELECT * FROM bars ORDER BY instrument_id,open_at) TO ${sqlString(resolve(path))} (FORMAT PARQUET,COMPRESSION UNCOMPRESSED,ROW_GROUP_SIZE 2048,PARQUET_VERSION V1)`,
    );
  } finally {
    connection?.closeSync();
    instance.closeSync();
  }
}
export async function readMarketParquet(path: string): Promise<ImportedMarketBar[]> {
  if ((await stat(path)).size > 512 * 1024 * 1024) throw new MarketImportError('LIMIT');
  const instance = await openDuckDB();
  let connection;
  try {
    connection = await instance.connect();
    const result = await connection.runAndReadAll(
      'SELECT record_json FROM read_parquet($path) ORDER BY instrument_id,open_at LIMIT 200001',
      { path: resolve(path) },
    );
    const rows = result.getRowObjectsJson();
    if (rows.length > 200000) throw new MarketImportError('LIMIT');
    return rows.map((row) => {
      if (typeof row.record_json !== 'string') throw new MarketImportError('MANIFEST');
      const record: unknown = JSON.parse(row.record_json);
      return ImportedMarketBarSchema.parse(record);
    });
  } finally {
    connection?.closeSync();
    instance.closeSync();
  }
}
async function validateExisting(
  directory: string,
  manifest: MarketSnapshotManifest,
): Promise<string> {
  const text = (await boundedRead(join(directory, 'manifest.json'), 64 * 1024 * 1024)).toString(
    'utf8',
  );
  const raw: unknown = JSON.parse(text);
  const parsed = MarketSnapshotManifestSchema.parse(raw);
  if (canonicalJson(parsed) !== canonicalJson(manifest) || text !== `${canonicalJson(manifest)}\n`)
    throw new MarketImportError('OUTPUT');
  for (const [file, hash] of [
    ['bars.parquet', manifest.parquetHash],
    ['quarantine.json', manifest.quarantineHash],
    ['raw-rows.json', manifest.rawRowsHash],
  ]) {
    if (
      !file ||
      !hash ||
      byteHash(await boundedRead(join(directory, file), 512 * 1024 * 1024)) !== hash
    )
      throw new MarketImportError('OUTPUT');
  }
  return byteHash(text);
}
/** Write fully in a private staging directory, then atomically publish a content-addressed directory. */
export async function writeMarketSnapshot(
  input: NormalizedMarketImport,
  outputRoot: string,
  codeVersion: string,
): Promise<MarketSnapshot> {
  if (typeof codeVersion !== 'string' || codeVersion.length === 0)
    throw new MarketImportError('INPUT');
  const imported = NormalizedMarketImportSchema.parse(input);
  await mkdir(resolve(outputRoot), { recursive: true });
  const root = await realpath(resolve(outputRoot));
  const stage = await mkdtemp(join(root, '.stage-'));
  try {
    const quarantine = `${canonicalJson(imported.quarantine)}\n`,
      rawRows = `${canonicalJson(imported.rawBundles)}\n`;
    await writeFile(join(stage, 'quarantine.json'), quarantine, { flag: 'wx' });
    await writeFile(join(stage, 'raw-rows.json'), rawRows, { flag: 'wx' });
    await writeParquet(join(stage, 'bars.parquet'), imported.bars);
    const body = {
      schemaVersion: 'market-snapshot.v1' as const,
      normalizationVersion: imported.normalizationVersion,
      writer,
      codeVersion,
      request: imported.request,
      sources: imported.sources,
      configHash: canonicalHash({
        normalizationVersion: imported.normalizationVersion,
        writer,
        request: imported.request,
        duplicatePolicy: 'QUARANTINE_ALL_CONFLICTS',
        availabilityPolicy: 'LOCAL_CAPTURE_OR_DESCRIPTIVE',
      }),
      datasetHash: canonicalHash(imported.bars),
      parquetHash: byteHash(await readFile(join(stage, 'bars.parquet'))),
      quarantineHash: byteHash(quarantine),
      rawRowsHash: byteHash(rawRows),
      coverage: imported.coverage,
      rowCount: imported.bars.length,
    };
    const manifest = MarketSnapshotManifestSchema.parse({
      ...body,
      id: deterministicId('market-snapshot', body),
    });
    const text = `${canonicalJson(manifest)}\n`;
    await writeFile(join(stage, 'manifest.json'), text, { flag: 'wx' });
    const directory = join(root, manifest.id);
    try {
      await rename(stage, directory);
    } catch (error) {
      if (
        !error ||
        typeof error !== 'object' ||
        !('code' in error) ||
        !['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(String(error.code))
      )
        throw error;
      await validateExisting(directory, manifest);
    }
    return { directory, manifest, metadataHash: await validateExisting(directory, manifest) };
  } catch (error) {
    if (error instanceof MarketImportError) throw error;
    throw new MarketImportError('OUTPUT');
  } finally {
    // Only remove the exact private stage we created under the resolved output root.
    if (dirname(resolve(stage)) === root && basename(stage).startsWith('.stage-'))
      await rm(stage, { recursive: true, force: true });
  }
}
export async function verifyMarketSnapshot(directory: string): Promise<MarketSnapshot> {
  const raw: unknown = JSON.parse(
    (await boundedRead(join(directory, 'manifest.json'), 64 * 1024 * 1024)).toString('utf8'),
  );
  const manifest = MarketSnapshotManifestSchema.parse(raw),
    { id, ...body } = manifest;
  if (id !== deterministicId('market-snapshot', body)) throw new MarketImportError('MANIFEST');
  const metadataHash = await validateExisting(directory, manifest),
    bars = await readMarketParquet(join(directory, 'bars.parquet'));
  if (bars.length !== manifest.rowCount || canonicalHash(bars) !== manifest.datasetHash)
    throw new MarketImportError('MANIFEST');
  return { directory: resolve(directory), manifest, metadataHash };
}
