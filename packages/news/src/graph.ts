import {
  NewsGraphConfigSchema,
  NewsGraphDecisionRequestSchema,
  NewsGraphQuerySchema,
  NewsGraphRecordSchema,
  NewsGraphObserveResultSchema,
  UtcTimestampSchema,
} from '@crypto/contracts';
import type { NewsGraphRecord } from '@crypto/contracts';
import type { Clock } from '@crypto/core';
import { canonicalHash, deepFreeze } from '@crypto/core';
import { validateNewsExtractionResult } from './extractor.js';
import { newsGraphGenesis, projectNewsGraph } from './graph-projection.js';

export class NewsGraphError extends Error {
  constructor(readonly code: 'INPUT' | 'CONFLICT' | 'INTEGRITY' | 'CAPACITY') {
    super(`News graph ${code}`);
  }
}
export function validateNewsGraphChain(input: readonly unknown[], configInput: unknown) {
  const configHash = canonicalHash(NewsGraphConfigSchema.parse(configInput));
  if (input.length > 5000) throw new NewsGraphError('CAPACITY');
  let previousHash = newsGraphGenesis,
    previousAt = '';
  return input.map((value, index) => {
    const record = NewsGraphRecordSchema.parse(value),
      { hash, ...payload } = record;
    if (
      record.index !== index ||
      record.previousHash !== previousHash ||
      record.configHash !== configHash ||
      record.recordedAt < previousAt ||
      canonicalHash(payload) !== hash
    )
      throw new NewsGraphError('INTEGRITY');
    previousHash = hash;
    previousAt = record.recordedAt;
    deepFreeze(record);
    return record;
  });
}
export interface NewsGraphWriter {
  append(record: NewsGraphRecord): Promise<void>;
}
export class NewsGraphService {
  readonly config: ReturnType<typeof NewsGraphConfigSchema.parse>;
  #records: NewsGraphRecord[] = [];
  #writes: Promise<unknown> = Promise.resolve();
  constructor(
    configInput: unknown,
    records: readonly unknown[],
    private readonly clock: Clock,
    private readonly codeVersion: string,
    private readonly writer?: NewsGraphWriter,
  ) {
    this.config = NewsGraphConfigSchema.parse(configInput);
    deepFreeze(this.config);
    for (const record of validateNewsGraphChain(records, this.config)) {
      if (record.recordedAt > clock.now()) throw new NewsGraphError('INTEGRITY');
      this.#validate(record.action, record.recordedAt);
      this.#records.push(record);
    }
  }
  records() {
    return Object.freeze([...this.#records]);
  }
  headHash() {
    return this.#records.at(-1)?.hash ?? newsGraphGenesis;
  }
  query(input: unknown) {
    const { decisionAt } = NewsGraphQuerySchema.parse(input);
    if (decisionAt > this.clock.now()) throw new NewsGraphError('INPUT');
    const result = projectNewsGraph(this.#records, this.config, decisionAt);
    deepFreeze(result);
    return result;
  }
  #validate(action: NewsGraphRecord['action'], at: string) {
    if (action.kind === 'OBSERVE') {
      const result = validateNewsExtractionResult(action.extraction);
      if (result.processedAt > at) throw new NewsGraphError('INPUT');
      const observed = this.#records.filter((r) => r.action.kind === 'OBSERVE');
      if (
        result.claims.length &&
        (result.input.dataCutoff > result.startedAt ||
          result.input.article.version.processedAt > result.startedAt)
      )
        throw new NewsGraphError('INPUT');
      for (const prior of observed)
        if (prior.action.kind === 'OBSERVE') {
          const old = prior.action.extraction.input,
            incoming = result.input;
          if (
            (old.source.id === incoming.source.id &&
              old.source.version === incoming.source.version &&
              canonicalHash(old.source) !== canonicalHash(incoming.source)) ||
            (old.article.version.versionId === incoming.article.version.versionId &&
              old.article.versionHash !== incoming.article.versionHash) ||
            (old.article.version.entityId === incoming.article.version.entityId &&
              old.article.version.processedAt === incoming.article.version.processedAt &&
              old.article.version.versionId !== incoming.article.version.versionId)
          )
            throw new NewsGraphError('INTEGRITY');
        }
      if (observed.length >= this.config.maxExtractions) throw new NewsGraphError('CAPACITY');
      const ids = new Set(
        observed.flatMap((r) =>
          r.action.kind === 'OBSERVE' ? r.action.extraction.claims.map((c) => c.id) : [],
        ),
      );
      result.claims.forEach((c) => ids.add(c.id));
      if (ids.size > this.config.maxNodes) throw new NewsGraphError('CAPACITY');
      return;
    }
    const target = this.#target(action.decision, at);
    if (canonicalHash(target) !== action.targetHash) throw new NewsGraphError('INTEGRITY');
  }
  #target(action: ReturnType<typeof NewsGraphDecisionRequestSchema.parse>['action'], at: string) {
    const view = projectNewsGraph(this.#records, this.config, at);
    if (action.kind === 'ACKNOWLEDGE') {
      const item = view.review.find((r) => r.id === action.reviewId);
      if (!item) throw new NewsGraphError('INPUT');
      return item;
    }
    if (action.kind === 'LINK') {
      const from = view.nodes.find((n) => n.id === action.from),
        to = view.nodes.find((n) => n.id === action.to);
      if (
        !from ||
        !to ||
        from.id === to.id ||
        from.clusterId !== to.clusterId ||
        (action.relationship === 'QUOTED_OFFICIAL' && to.publicationType !== 'OFFICIAL_SECURITY')
      )
        throw new NewsGraphError('INPUT');
      const todo = [to.id],
        visited = new Set<string>();
      while (todo.length) {
        const id = todo.pop()!;
        if (id === from.id) throw new NewsGraphError('INPUT');
        if (visited.has(id)) continue;
        visited.add(id);
        todo.push(
          ...view.edges
            .filter(
              (e) =>
                e.from === id && !['SAME_ARTICLE', 'SAME_ORIGIN_GROUP'].includes(e.relationship),
            )
            .map((e) => e.to),
        );
      }
      return { from, to, relationship: action.relationship };
    }
    const node = view.nodes.find((n) => n.id === action.claimId);
    if (!node) throw new NewsGraphError('INPUT');
    return node;
  }
  #enqueue<T>(work: () => Promise<T>) {
    const next = this.#writes.then(work);
    this.#writes = next.catch(() => undefined);
    return next;
  }
  async #append(action: NewsGraphRecord['action']) {
    if (!this.writer) throw new NewsGraphError('INPUT');
    if (this.#records.length >= 5000) throw new NewsGraphError('CAPACITY');
    const recordedAt = UtcTimestampSchema.parse(this.clock.now());
    if (recordedAt < (this.#records.at(-1)?.recordedAt ?? '')) throw new NewsGraphError('INPUT');
    this.#validate(action, recordedAt);
    const payload = {
        schemaVersion: 'news-graph-record.v1' as const,
        index: this.#records.length,
        previousHash: this.headHash(),
        configHash: canonicalHash(this.config),
        codeVersion: this.codeVersion,
        recordedAt,
        action,
      },
      record = NewsGraphRecordSchema.parse({ ...payload, hash: canonicalHash(payload) });
    // Validate the resulting projection before publishing an irreversible journal record.
    projectNewsGraph([...this.#records, record], this.config, recordedAt);
    await this.writer.append(record);
    deepFreeze(record);
    this.#records.push(record);
    return record;
  }
  observe(input: unknown) {
    return this.#enqueue(async () => {
      const extraction = validateNewsExtractionResult(input),
        hash = canonicalHash(extraction);
      if (
        this.#records.some(
          (r) => r.action.kind === 'OBSERVE' && canonicalHash(r.action.extraction) === hash,
        )
      )
        return NewsGraphObserveResultSchema.parse({ created: false, record: null });
      return NewsGraphObserveResultSchema.parse({
        created: true,
        record: await this.#append({ kind: 'OBSERVE', extraction }),
      });
    });
  }
  decide(input: unknown) {
    return this.#enqueue(async () => {
      const request = NewsGraphDecisionRequestSchema.parse(input);
      if (request.expectedHeadHash !== this.headHash()) throw new NewsGraphError('CONFLICT');
      const target = this.#target(request.action, this.clock.now());
      return this.#append({
        kind: 'REVIEW',
        operator: request.operator,
        reason: request.reason,
        targetHash: canonicalHash(target),
        decision: request.action,
      });
    });
  }
}
