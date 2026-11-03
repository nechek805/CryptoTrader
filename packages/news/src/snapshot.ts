import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  NewsSnapshotInputSchema,
  NewsSnapshotRequestSchema,
  NewsSnapshotSchema,
} from '@crypto/contracts';
import { canonicalHash, canonicalJson, deepFreeze } from '@crypto/core';
import { NewsIngestStore } from './store.js';
import { NewsReviewService, validateNewsCorrectionChain } from './review.js';

const limit = 64 * 1024 * 1024;
export function restoreNewsSnapshotInput(input: unknown) {
  const data = NewsSnapshotInputSchema.parse(input),
    store = new NewsIngestStore(data.registry);
  for (const row of data.captures) store.ingestParsed(row.capture, row.parsed);
  return store;
}
export function buildNewsSnapshot(
  store: NewsIngestStore,
  corrections: readonly unknown[],
  requestInput: unknown,
  codeVersion: string,
) {
  const request = NewsSnapshotRequestSchema.parse(requestInput),
    state = store.state(),
    records = validateNewsCorrectionChain(corrections).filter(
      (r) => r.recordedAt <= request.decisionAt,
    );
  const input = NewsSnapshotInputSchema.parse({
    registry: {
      ...state.registry,
      providers: state.registry.providers.filter((p) => p.knownAt <= request.decisionAt),
      sources: state.registry.sources.filter((s) => s.knownAt <= request.decisionAt),
    },
    captures: state.captures.flatMap((capture, i) =>
      capture.processedAt > request.decisionAt
        ? []
        : [
            {
              capture: { ...capture, raw: '', rawRetention: 'HASH_ONLY' },
              parsed: state.parseResults[i],
            },
          ],
    ),
  });
  const knownStore = restoreNewsSnapshotInput(input),
    data = new NewsReviewService(
      knownStore,
      records,
      { now: () => request.generatedAt },
      codeVersion,
    ),
    query = {
      decisionAt: request.decisionAt,
      mode: request.mode,
      allowEstimated: request.allowEstimated,
    };
  const artifact = NewsSnapshotSchema.parse({
    schemaVersion: 'news-snapshot.v1',
    algorithmVersion: 'news-review.v1',
    clockSemantics: 'utc-nanoseconds.v1',
    execution: 'DISABLED',
    codeVersion,
    request,
    input,
    inputHash: canonicalHash(input),
    configHash: canonicalHash(request),
    sourceHashes: input.registry.sources.map((s) => canonicalHash(s)),
    versionHashes: knownStore.state().documents.map((v) => canonicalHash(v)),
    corrections: records,
    result: data.articles(query),
    coverage: data.coverage({ decisionAt: request.decisionAt }),
    review: data.queue({ decisionAt: request.decisionAt }),
  });
  deepFreeze(artifact);
  return artifact;
}
export async function verifyNewsSnapshot(path: string) {
  const info = await lstat(path);
  if (!info.isFile() || info.size > limit) throw new Error('Invalid news snapshot');
  const bytes = await readFile(path);
  if (bytes.length > limit) throw new Error('News snapshot limit');
  const artifact = NewsSnapshotSchema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    ),
    expected = buildNewsSnapshot(
      restoreNewsSnapshotInput(artifact.input),
      artifact.corrections,
      artifact.request,
      artifact.codeVersion,
    ),
    hash = canonicalHash(artifact);
  if (canonicalHash(expected) !== hash || basename(path) !== `news-snapshot_${hash.slice(7)}.json`)
    throw new Error('News snapshot integrity mismatch');
  return { path, hash, artifact };
}
export async function writeNewsSnapshot(
  store: NewsIngestStore,
  corrections: readonly unknown[],
  request: unknown,
  outputRoot: string,
  codeVersion: string,
) {
  const artifact = buildNewsSnapshot(store, corrections, request, codeVersion),
    hash = canonicalHash(artifact),
    body = `${canonicalJson(artifact)}\n`;
  if (Buffer.byteLength(body) > limit) throw new Error('News snapshot limit');
  await mkdir(outputRoot, { recursive: true });
  const root = await realpath(outputRoot),
    path = join(root, `news-snapshot_${hash.slice(7)}.json`),
    stage = join(root, `.news-stage-${randomUUID()}`),
    file = await open(stage, 'wx');
  try {
    try {
      await file.writeFile(body);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await link(stage, path);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      const existing = await verifyNewsSnapshot(path);
      if (existing.hash !== hash)
        throw new Error('Existing news snapshot mismatch', { cause: error });
    }
  } finally {
    await unlink(stage);
  }
  return verifyNewsSnapshot(path);
}
