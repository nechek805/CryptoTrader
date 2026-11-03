import {
  NewsEventConfigSchema,
  NewsEventDecisionSchema,
  NewsEventQuerySchema,
  NewsEventRecordSchema,
  NewsGraphConfigSchema,
  UtcTimestampSchema,
} from '@crypto/contracts';
import type { NewsEventRecord, NewsGraphRecord, NewsEventIdentity } from '@crypto/contracts';
import type { Clock } from '@crypto/core';
import { canonicalHash, deepFreeze, deterministicId } from '@crypto/core';
import { NewsGraphService, validateNewsGraphChain, NewsGraphError } from './graph.js';
import { newsGraphGenesis, projectNewsGraph } from './graph-projection.js';
import { newsEventGenesis, newsEventIdentities, projectNewsEvents } from './event-projection.js';

export function validateNewsEventChain(
  input: readonly unknown[],
  configInput: unknown,
  graphConfigInput: unknown,
) {
  const config = NewsEventConfigSchema.parse(configInput),
    graphConfig = NewsGraphConfigSchema.parse(graphConfigInput),
    configHash = canonicalHash({ config, graphConfig });
  if (input.length > 5000) throw new NewsGraphError('CAPACITY');
  let previousHash = newsEventGenesis,
    previousAt = '';
  return input.map((value, index) => {
    const r = NewsEventRecordSchema.parse(value),
      { hash, ...payload } = r;
    if (
      r.index !== index ||
      r.previousHash !== previousHash ||
      r.configHash !== configHash ||
      r.recordedAt < previousAt ||
      canonicalHash(payload) !== hash
    )
      throw new NewsGraphError('INTEGRITY');
    previousHash = hash;
    previousAt = r.recordedAt;
    deepFreeze(r);
    return r;
  });
}
export function newsEventPrefix<T extends { hash: string; recordedAt: string }>(
  records: readonly T[],
  decisionAt: string,
  head: string | undefined,
  genesis: string,
) {
  const known = records.filter((r) => r.recordedAt <= decisionAt);
  if (head === undefined) return known;
  if (head === genesis) return [];
  const index = known.findIndex((r) => r.hash === head);
  if (index < 0) throw new NewsGraphError('INPUT');
  return known.slice(0, index + 1);
}
export interface NewsEventWriter {
  append(record: NewsEventRecord): Promise<void>;
}
export class NewsEventService {
  readonly config: ReturnType<typeof NewsEventConfigSchema.parse>;
  readonly graphConfig: ReturnType<typeof NewsGraphConfigSchema.parse>;
  readonly graphRecords: readonly NewsGraphRecord[];
  #records: NewsEventRecord[] = [];
  #writes: Promise<unknown> = Promise.resolve();
  constructor(
    configInput: unknown,
    graphConfigInput: unknown,
    graphRecords: readonly unknown[],
    records: readonly unknown[],
    private readonly clock: Clock,
    private readonly codeVersion: string,
    private readonly writer?: NewsEventWriter,
  ) {
    this.config = NewsEventConfigSchema.parse(configInput);
    this.graphConfig = NewsGraphConfigSchema.parse(graphConfigInput);
    this.graphRecords = validateNewsGraphChain(graphRecords, this.graphConfig);
    new NewsGraphService(this.graphConfig, this.graphRecords, clock, codeVersion);
    deepFreeze(this.config);
    deepFreeze(this.graphConfig);
    deepFreeze(this.graphRecords);
    for (const r of validateNewsEventChain(records, this.config, this.graphConfig)) {
      if (r.recordedAt > clock.now()) throw new NewsGraphError('INTEGRITY');
      const prefix = this.#graphAt(r.recordedAt, r.graphHeadHash),
        resolved = this.#resolve(r.action, r.recordedAt, r.previousHash, r.graphHeadHash, prefix);
      if (
        canonicalHash(resolved.resolution) !== canonicalHash(r.resolution) ||
        resolved.targetHash !== r.targetHash
      )
        throw new NewsGraphError('INTEGRITY');
      this.#records.push(r);
    }
  }
  records() {
    return Object.freeze([...this.#records]);
  }
  headHash() {
    return this.#records.at(-1)?.hash ?? newsEventGenesis;
  }
  graphHeadHash() {
    return this.graphRecords.at(-1)?.hash ?? newsGraphGenesis;
  }
  #graphAt(at: string, head?: string) {
    return newsEventPrefix(this.graphRecords, at, head, newsGraphGenesis);
  }
  query(input: unknown) {
    const q = NewsEventQuerySchema.parse(input);
    if (q.decisionAt > this.clock.now()) throw new NewsGraphError('INPUT');
    const graph = this.#graphAt(q.decisionAt, q.graphHeadHash),
      metadata = newsEventPrefix(this.#records, q.decisionAt, q.metadataHeadHash, newsEventGenesis);
    for (const r of metadata)
      if (r.graphHeadHash !== newsGraphGenesis && !graph.some((g) => g.hash === r.graphHeadHash))
        throw new NewsGraphError('INPUT');
    const view = projectNewsEvents(graph, this.graphConfig, metadata, this.config, q.decisionAt);
    deepFreeze(view);
    return view;
  }
  #resolve(
    action: NewsEventRecord['action'],
    at: string,
    previousHash: string,
    graphHeadHash: string,
    graphRecords: readonly NewsGraphRecord[],
  ) {
    const graph = projectNewsGraph(graphRecords, this.graphConfig, at),
      definitions = newsEventIdentities(graph, this.#records),
      parents: NewsEventIdentity[] = [],
      children: NewsEventIdentity[] = [];
    if (action.kind === 'MERGE' || action.kind === 'SPLIT') {
      const ids = action.kind === 'MERGE' ? action.eventIds : [action.eventId];
      if (new Set(ids).size !== ids.length) throw new NewsGraphError('INPUT');
      for (const id of ids) {
        const row = definitions.find((d) => d.identity.id === id && d.active);
        if (!row) throw new NewsGraphError('INPUT');
        parents.push(row.identity);
      }
      parents.sort((a, b) => (a.id < b.id ? -1 : 1));
      const memberships = parents.flatMap((p) => p.claimIds);
      if (new Set(memberships).size !== memberships.length) throw new NewsGraphError('INPUT');
      const groups =
        action.kind === 'MERGE'
          ? [{ label: action.label, claimIds: [...memberships].sort() }]
          : action.partitions.map((p) => ({ label: p.label, claimIds: [...p.claimIds].sort() }));
      const flattened = groups.flatMap((p) => p.claimIds);
      if (
        new Set(groups.map((p) => p.label)).size !== groups.length ||
        new Set(flattened).size !== flattened.length ||
        canonicalHash([...flattened].sort()) !== canonicalHash([...memberships].sort())
      )
        throw new NewsGraphError('INPUT');
      const parentIds = parents.map((p) => p.id),
        baseClusterIds = [...new Set(parents.flatMap((p) => p.baseClusterIds))].sort();
      for (const group of groups)
        children.push({
          id: deterministicId(action.kind === 'MERGE' ? 'merged-event' : 'split-event', {
            previousHash,
            graphHeadHash,
            recordedAt: at,
            parentIds,
            group,
          }),
          kind: action.kind === 'MERGE' ? 'MERGED' : 'SPLIT',
          label: group.label,
          claimIds: group.claimIds,
          baseClusterIds,
          parentIds,
          createdAt: UtcTimestampSchema.parse(at),
        });
    }
    return {
      targetHash: canonicalHash(parents.length ? parents : action),
      resolution: { parents, children },
    };
  }
  decide(input: unknown) {
    const next = this.#writes.then(async () => {
      if (!this.writer) throw new NewsGraphError('INPUT');
      const request = NewsEventDecisionSchema.parse(input),
        recordedAt = UtcTimestampSchema.parse(this.clock.now());
      if (
        request.expectedHeadHash !== this.headHash() ||
        request.expectedGraphHeadHash !== this.graphHeadHash()
      )
        throw new NewsGraphError('CONFLICT');
      if (recordedAt < (this.#records.at(-1)?.recordedAt ?? '')) throw new NewsGraphError('INPUT');
      if (this.#records.length >= 5000) throw new NewsGraphError('CAPACITY');
      const graph = this.#graphAt(recordedAt, request.expectedGraphHeadHash),
        resolved = this.#resolve(
          request.action,
          recordedAt,
          request.expectedHeadHash,
          request.expectedGraphHeadHash,
          graph,
        ),
        payload = {
          schemaVersion: 'news-event-record.v1' as const,
          index: this.#records.length,
          previousHash: request.expectedHeadHash,
          configHash: canonicalHash({ config: this.config, graphConfig: this.graphConfig }),
          graphHeadHash: request.expectedGraphHeadHash,
          codeVersion: this.codeVersion,
          recordedAt,
          operator: request.operator,
          reason: request.reason,
          action: request.action,
          ...resolved,
        },
        record = NewsEventRecordSchema.parse({ ...payload, hash: canonicalHash(payload) });
      projectNewsEvents(
        graph,
        this.graphConfig,
        [...this.#records, record],
        this.config,
        recordedAt,
      );
      await this.writer.append(record);
      deepFreeze(record);
      this.#records.push(record);
      return record;
    });
    this.#writes = next.catch(() => undefined);
    return next;
  }
}
