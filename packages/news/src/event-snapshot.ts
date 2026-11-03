import { randomUUID } from 'node:crypto';
import { open, mkdir, realpath, link, unlink, lstat, readFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import {
  NewsEventSnapshotRequestSchema,
  NewsEventSnapshotSchema,
  NewsEventConfigSchema,
  NewsGraphConfigSchema,
  NewsEventInputsSchema,
  UtcTimestampSchema,
} from '@crypto/contracts';
import { canonicalHash, canonicalJson, deepFreeze } from '@crypto/core';
import { NewsEventService, newsEventPrefix, validateNewsEventChain } from './events.js';
import { validateNewsGraphChain } from './graph.js';
import { newsGraphGenesis } from './graph-projection.js';
import { newsEventGenesis } from './event-projection.js';

const limit = 64 * 1024 * 1024;
export function buildNewsEventSnapshot(
  graphConfigInput: unknown,
  graphInput: readonly unknown[],
  metadataInput: readonly unknown[],
  configInput: unknown,
  requestInput: unknown,
  codeVersion: string,
) {
  const graphConfig = NewsGraphConfigSchema.parse(graphConfigInput),
    config = NewsEventConfigSchema.parse(configInput),
    request = NewsEventSnapshotRequestSchema.parse(requestInput),
    graphRecords = newsEventPrefix(
      validateNewsGraphChain(graphInput, graphConfig),
      request.decisionAt,
      request.graphHeadHash,
      newsGraphGenesis,
    ),
    metadataRecords = newsEventPrefix(
      validateNewsEventChain(metadataInput, config, graphConfig),
      request.decisionAt,
      request.metadataHeadHash,
      newsEventGenesis,
    ),
    service = new NewsEventService(
      config,
      graphConfig,
      graphRecords,
      metadataRecords,
      { now: () => request.generatedAt },
      codeVersion,
    ),
    view = service.query({ decisionAt: request.decisionAt }),
    input = { graphRecords, metadataRecords };
  const artifact = NewsEventSnapshotSchema.parse({
    schemaVersion: 'news-event-snapshot.v1',
    execution: 'DISABLED',
    algorithmVersion: 'news-temporal-events.v1',
    clockSemantics: 'utc-nanoseconds.v1',
    randomSeed: 0,
    codeVersion,
    request: {
      ...request,
      graphHeadHash: view.graphHeadHash,
      metadataHeadHash: view.metadataHeadHash,
    },
    config,
    graphConfig,
    input,
    inputHash: canonicalHash(input),
    configHash: canonicalHash({ config, graphConfig }),
    view,
  });
  deepFreeze(artifact);
  return artifact;
}
export function validateNewsEventSnapshot(input: unknown) {
  const artifact = NewsEventSnapshotSchema.parse(input),
    expected = buildNewsEventSnapshot(
      artifact.graphConfig,
      artifact.input.graphRecords,
      artifact.input.metadataRecords,
      artifact.config,
      artifact.request,
      artifact.codeVersion,
    );
  if (canonicalHash(expected) !== canonicalHash(artifact))
    throw new Error('Event snapshot integrity mismatch');
  deepFreeze(artifact);
  return artifact;
}
export async function verifyNewsEventSnapshot(path: string) {
  const info = await lstat(path);
  if (!info.isFile() || info.size > limit) throw new Error('Event snapshot limit');
  const bytes = await readFile(path);
  if (bytes.length > limit) throw new Error('Event snapshot limit');
  const artifact = validateNewsEventSnapshot(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    ),
    hash = canonicalHash(artifact);
  if (basename(path) !== `news-event_${hash.slice(7)}.json`)
    throw new Error('Event snapshot name mismatch');
  return { path, hash, artifact };
}
export async function writeNewsEventSnapshot(
  graphConfig: unknown,
  graph: readonly unknown[],
  metadata: readonly unknown[],
  config: unknown,
  request: unknown,
  outputRoot: string,
  codeVersion: string,
) {
  const artifact = buildNewsEventSnapshot(
      graphConfig,
      graph,
      metadata,
      config,
      request,
      codeVersion,
    ),
    hash = canonicalHash(artifact),
    body = `${canonicalJson(artifact)}\n`;
  if (Buffer.byteLength(body) > limit) throw new Error('Event snapshot limit');
  await mkdir(outputRoot, { recursive: true });
  const root = await realpath(outputRoot),
    path = join(root, `news-event_${hash.slice(7)}.json`),
    stage = join(root, `.event-stage-${randomUUID()}`),
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
      if ((await verifyNewsEventSnapshot(path)).hash !== hash)
        throw new Error('Existing event snapshot mismatch', { cause: error });
    }
  } finally {
    await unlink(stage);
  }
  return verifyNewsEventSnapshot(path);
}
export function newsEventResearchInputs(
  snapshotInput: unknown,
  decisionInput: unknown,
  purpose: 'EVENT_STUDY' | 'NEWS_SIGNAL_INPUT' = 'EVENT_STUDY',
) {
  const snapshot = validateNewsEventSnapshot(snapshotInput),
    decisionAt = UtcTimestampSchema.parse(decisionInput);
  if (decisionAt > snapshot.request.decisionAt)
    throw new Error('Decision exceeds frozen snapshot cutoff');
  const historical = buildNewsEventSnapshot(
      snapshot.graphConfig,
      snapshot.input.graphRecords,
      snapshot.input.metadataRecords,
      snapshot.config,
      { decisionAt, generatedAt: snapshot.request.generatedAt },
      snapshot.codeVersion,
    ),
    events = historical.view.events.filter(
      (e) =>
        e.replayEligible &&
        e.availableAt !== null &&
        e.availableAt <= decisionAt &&
        (purpose === 'EVENT_STUDY' || e.abstentionReasons.length === 0),
    );
  return NewsEventInputsSchema.parse({
    schemaVersion: 'news-event-research-inputs.v1',
    decisionAt,
    purpose,
    events,
  });
}
export function newsEventProvenanceDot(input: unknown) {
  const { view } = validateNewsEventSnapshot(input),
    lines = ['digraph provenance {', '  rankdir=LR;'],
    ids = new Map<string, string>(),
    id = (value: string) => {
      let key = ids.get(value);
      if (!key) {
        key = `n${ids.size}`;
        ids.set(value, key);
      }
      return key;
    },
    node = (key: string, label: string) =>
      lines.push(`  ${id(key)} [label=${JSON.stringify(label)}];`),
    edge = (from: string, to: string, label: string) =>
      lines.push(`  ${id(from)} -> ${id(to)} [label=${JSON.stringify(label)}];`);
  for (const e of view.events) {
    node(
      e.identity.id,
      `${e.identity.id}\n${e.identity.kind}: ${e.identity.label} (${e.confidence.grade})`,
    );
    for (const claim of e.identity.claimIds) edge(e.identity.id, claim, 'SUPPORTS_EVENT');
    for (const parent of e.identity.parentIds) edge(parent, e.identity.id, 'LINEAGE');
  }
  for (const n of view.graph.nodes) {
    node(n.id, `${n.id}\n${n.polarity}: ${n.text}`);
    node(`source:${n.sourceId}`, n.sourceId);
    edge(n.id, `source:${n.sourceId}`, 'ATTRIBUTED_TO');
  }
  for (const e of view.graph.edges) edge(e.from, e.to, e.relationship);
  lines.push('}');
  return lines.join('\n');
}
