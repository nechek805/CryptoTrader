import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  StreamConfigSchema,
  StreamManifestSchema,
  StreamRecordSchema,
  StreamStepSchema,
} from '@crypto/contracts';
import type { StreamConfig, StreamStep } from '@crypto/contracts';
import { canonicalHash, canonicalJson } from '@crypto/core';
import { byteHash, DepthStreamState } from '@crypto/connectors';

const genesis = canonicalHash({ schemaVersion: 'market-stream-chain.v1' });
const maxBytes = 64 * 1024 * 1024;
const recordingSource = (config: StreamConfig) =>
  config.provider === 'synthetic'
    ? {
        profile: 'synthetic-depth.v1',
        restBaseUrl: null,
        websocketBaseUrl: null,
        termsUrl: null,
        license: 'SYNTHETIC',
      }
    : {
        profile: 'binance-spot-depth-ms.v1',
        restBaseUrl: 'https://data-api.binance.vision',
        websocketBaseUrl: 'wss://data-stream.binance.vision',
        termsUrl: 'https://www.binance.com/en/terms',
        license: 'UNDETERMINED',
      };
async function boundedRead(path: string, limit: number): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile() || info.size > limit) throw new Error('Invalid recording file');
  const bytes = await readFile(path);
  if (bytes.length > limit) throw new Error('Recording limit');
  return bytes.toString('utf8');
}

export async function replayStreamRecording(directory: string) {
  if (!(await lstat(directory)).isDirectory()) throw new Error('Invalid recording directory');
  const manifestText = await boundedRead(join(directory, 'manifest.json'), 16384);
  const manifest = StreamManifestSchema.parse(JSON.parse(manifestText));
  if (manifest.configHash !== canonicalHash(manifest.config))
    throw new Error('Config hash mismatch');
  if (canonicalHash(manifest.source) !== canonicalHash(recordingSource(manifest.config)))
    throw new Error('Source profile mismatch');
  const name = basename(directory),
    metadataHash = canonicalHash(manifest);
  if (
    name.startsWith('market-stream-recording_') &&
    name !== `market-stream-recording_${metadataHash.slice(7)}`
  )
    throw new Error('Metadata address mismatch');
  const body = await boundedRead(join(directory, 'observations.jsonl'), maxBytes);
  if (byteHash(body) !== manifest.recordsHash || !body.endsWith('\n'))
    throw new Error('Recording hash mismatch');
  const lines = body.slice(0, -1).split('\n');
  if (lines.length !== manifest.count) throw new Error('Recording count mismatch');
  const state = new DepthStreamState(manifest.config);
  let previousHash = genesis;
  const records = lines.map((line, index) => {
    const record = StreamRecordSchema.parse(JSON.parse(line));
    const { hash, ...payload } = record;
    const rawHash = 'raw' in record.step.input ? byteHash(record.step.input.raw) : null;
    if (
      record.index !== index ||
      record.previousHash !== previousHash ||
      canonicalHash(payload) !== hash ||
      record.rawHash !== rawHash
    )
      throw new Error('Recording chain mismatch');
    if (canonicalHash(state.consume(record.step)) !== canonicalHash(record.view))
      throw new Error('Replay state mismatch');
    previousHash = hash;
    return record;
  });
  if (previousHash !== manifest.finalHash || records.at(-1)?.step.input.kind !== 'STOPPED')
    throw new Error('Incomplete recording');
  return { manifest, records, metadataHash };
}

export async function writeStreamRecording(
  configValue: StreamConfig,
  steps: Iterable<StreamStep> | AsyncIterable<StreamStep>,
  outputRoot: string,
  codeVersion: string,
) {
  const config = StreamConfigSchema.parse(configValue),
    state = new DepthStreamState(config);
  const lines: string[] = [];
  let previousHash = genesis,
    bytes = 0,
    lastKind: string | undefined;
  for await (const input of steps) {
    const step = StreamStepSchema.parse(input);
    if (lines.length >= 5000 || lastKind === 'STOPPED')
      throw new Error('Recording limit or extra events after stop');
    const view = state.consume(step);
    const payload = {
      schemaVersion: 'market-stream-record.v1' as const,
      index: lines.length,
      previousHash,
      step,
      rawHash: 'raw' in step.input ? byteHash(step.input.raw) : null,
      view,
    };
    previousHash = canonicalHash(payload);
    const line = `${canonicalJson(StreamRecordSchema.parse({ ...payload, hash: previousHash }))}\n`;
    bytes += Buffer.byteLength(line);
    if (bytes > maxBytes) throw new Error('Recording byte limit');
    lines.push(line);
    lastKind = step.input.kind;
  }
  if (lastKind !== 'STOPPED') throw new Error('Incomplete recording');
  const body = lines.join('');
  const manifest = StreamManifestSchema.parse({
    schemaVersion: 'market-stream-recording.v1',
    config,
    configHash: canonicalHash(config),
    codeVersion,
    clockSemantics: 'utc-nanoseconds.v1',
    reducerVersion: 'depth-reducer.v1',
    source: recordingSource(config),
    recordsHash: byteHash(body),
    finalHash: previousHash,
    count: lines.length,
  });
  const metadataHash = canonicalHash(manifest);
  await mkdir(outputRoot, { recursive: true });
  const root = await realpath(outputRoot);
  const directory = join(root, `market-stream-recording_${metadataHash.slice(7)}`),
    stage = join(root, `.stream-stage-${randomUUID()}`);
  try {
    await lstat(directory);
    const existing = await replayStreamRecording(directory);
    if (existing.metadataHash !== metadataHash) throw new Error('Existing recording mismatch');
    return { directory, ...existing };
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  await mkdir(stage);
  try {
    await writeFile(join(stage, 'manifest.json'), `${canonicalJson(manifest)}\n`, { flag: 'wx' });
    await writeFile(join(stage, 'observations.jsonl'), body, { flag: 'wx' });
    await replayStreamRecording(stage);
    await rename(stage, directory);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
  return { directory, ...(await replayStreamRecording(directory)) };
}
