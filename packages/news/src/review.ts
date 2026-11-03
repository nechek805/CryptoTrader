import {
  NewsArticleQuerySchema,
  NewsArticleResultSchema,
  NewsCorrectionRecordSchema,
  NewsCorrectionRequestSchema,
  NewsCoverageReportSchema,
  NewsReviewQuerySchema,
  NewsReviewQueueSchema,
  NewsReviewTargetSchema,
  UtcTimestampSchema,
} from '@crypto/contracts';
import type {
  NewsCorrectionRecord,
  NewsReviewedDocument,
  NewsReviewTarget,
  NewsReviewApi,
} from '@crypto/contracts';
import type { Clock } from '@crypto/core';
import { canonicalHash, deepFreeze, deterministicId } from '@crypto/core';
import { newsCaptureHash } from './store.js';
import type { NewsIngestStore } from './store.js';

export const newsCorrectionGenesis = canonicalHash({ schemaVersion: 'news-correction-chain.v1' });
export class NewsReviewError extends Error {
  constructor(readonly code: 'INPUT' | 'CONFLICT' | 'INTEGRITY' | 'CAPACITY') {
    super(`News review ${code}`);
  }
}
export function validateNewsCorrectionChain(input: readonly unknown[]) {
  if (input.length > 5000) throw new NewsReviewError('CAPACITY');
  let previousHash = newsCorrectionGenesis,
    previousAt = '';
  return input.map((value, index) => {
    const record = NewsCorrectionRecordSchema.parse(value),
      { hash, ...payload } = record;
    if (
      record.index !== index ||
      record.previousHash !== previousHash ||
      record.recordedAt < previousAt ||
      canonicalHash(payload) !== hash
    )
      throw new NewsReviewError('INTEGRITY');
    previousHash = hash;
    previousAt = record.recordedAt;
    deepFreeze(record);
    return record;
  });
}
export interface NewsCorrectionWriter {
  append(record: NewsCorrectionRecord): Promise<void>;
}
const maximum = (...values: string[]) => UtcTimestampSchema.parse(values.sort().at(-1));
const sameTarget = (a: NewsReviewTarget, b: NewsReviewTarget) =>
  canonicalHash(a) === canonicalHash(b);

/** Corrections are overlays. Neither captured evidence nor old decision views are rewritten. */
export class NewsReviewService implements NewsReviewApi {
  #records: NewsCorrectionRecord[];
  #writes: Promise<unknown> = Promise.resolve();
  constructor(
    readonly store: NewsIngestStore,
    records: readonly unknown[],
    private readonly clock: Clock,
    private readonly codeVersion: string,
    private readonly writer?: NewsCorrectionWriter,
  ) {
    this.#records = validateNewsCorrectionChain(records);
    for (const record of this.#records) {
      const target = this.#target(record.target);
      if (
        record.targetHash !== target.hash ||
        record.recordedAt < target.knownAt ||
        record.recordedAt > this.clock.now()
      )
        throw new NewsReviewError('INTEGRITY');
      this.#validateAction(record.target, record.action);
    }
  }
  records() {
    return Object.freeze([...this.#records]);
  }
  headHash() {
    return this.#records.at(-1)?.hash ?? newsCorrectionGenesis;
  }
  #at(input: unknown) {
    const { decisionAt } = NewsReviewQuerySchema.parse(input);
    if (decisionAt > this.clock.now()) throw new NewsReviewError('INPUT');
    return decisionAt;
  }
  #known(at: string) {
    return this.#records.filter((r) => r.recordedAt <= at);
  }
  #headAt(at: string) {
    return this.#known(at).at(-1)?.hash ?? newsCorrectionGenesis;
  }
  #target(input: unknown) {
    const target = NewsReviewTargetSchema.parse(input),
      state = this.store.state();
    if (target.kind === 'DOCUMENT') {
      const version = state.documents.find((v) => v.versionId === target.versionId);
      if (!version) throw new NewsReviewError('INPUT');
      return { hash: canonicalHash(version), knownAt: version.processedAt };
    }
    const i = state.captures.findIndex((c) => newsCaptureHash(c) === target.captureHash),
      capture = state.captures[i],
      parsed = state.parseResults[i];
    if (
      !capture ||
      !parsed ||
      (target.itemIndex === null
        ? parsed.feedStatus !== 'REJECTED'
        : !parsed.rejected.some((r) => r.index === target.itemIndex))
    )
      throw new NewsReviewError('INPUT');
    return {
      hash: canonicalHash({ captureHash: newsCaptureHash(capture), parsed }),
      knownAt: capture.processedAt,
    };
  }
  #validateAction(target: NewsReviewTarget, action: NewsCorrectionRecord['action']) {
    if (
      (target.kind === 'CAPTURE' &&
        (action.kind !== 'ACKNOWLEDGE' || action.category !== 'UNPARSED')) ||
      (target.kind === 'DOCUMENT' &&
        action.kind === 'ACKNOWLEDGE' &&
        action.category === 'UNPARSED')
    )
      throw new NewsReviewError('INPUT');
  }
  correct(input: unknown): Promise<NewsCorrectionRecord> {
    const work = this.#writes.then(async () => {
      if (!this.writer) throw new NewsReviewError('INPUT');
      const request = NewsCorrectionRequestSchema.parse(input);
      if (request.expectedHeadHash !== this.headHash()) throw new NewsReviewError('CONFLICT');
      const target = this.#target(request.target),
        recordedAt = UtcTimestampSchema.parse(this.clock.now());
      if (this.#records.length >= 5000) throw new NewsReviewError('CAPACITY');
      if (recordedAt < target.knownAt || recordedAt < (this.#records.at(-1)?.recordedAt ?? ''))
        throw new NewsReviewError('INPUT');
      this.#validateAction(request.target, request.action);
      const fields = {
        target: request.target,
        operator: request.operator,
        reason: request.reason,
        action: request.action,
      };
      const payload = {
        schemaVersion: 'news-correction-record.v1' as const,
        index: this.#records.length,
        previousHash: request.expectedHeadHash,
        ...fields,
        targetHash: target.hash,
        recordedAt,
        codeVersion: this.codeVersion,
      };
      const record = NewsCorrectionRecordSchema.parse({ ...payload, hash: canonicalHash(payload) });
      await this.writer.append(record);
      deepFreeze(record);
      this.#records.push(record);
      return record;
    });
    this.#writes = work.catch(() => undefined);
    return work;
  }
  articles(input: unknown) {
    const request = NewsArticleQuerySchema.parse(input),
      decisionAt = this.#at({ decisionAt: request.decisionAt }),
      records = this.#known(decisionAt),
      state = this.store.state();
    const articles = this.store
      .documentsAt({ decisionAt, mode: 'DESCRIPTIVE_ONLY' })
      .map((version) => {
        const capture = state.captures.find((c) => newsCaptureHash(c) === version.captureHash)!;
        const baseClass =
          capture.availabilityEvidence === 'OBSERVED'
            ? 'POINT_IN_TIME_VERIFIED'
            : capture.availabilityEvidence === 'ARCHIVED_CAPTURE'
              ? 'POINT_IN_TIME_ESTIMATED'
              : 'DESCRIPTIVE_ONLY';
        let temporalClass: NewsReviewedDocument['temporalClass'] = baseClass,
          effectiveAvailableAt = version.document.availableAt,
          effectivePublishedAt = version.document.publishedAt ?? null,
          excluded = false;
        const applied = records.filter((r) =>
          sameTarget(r.target, { kind: 'DOCUMENT', versionId: version.versionId }),
        );
        for (const record of applied) {
          const action = record.action;
          if (action.kind === 'EXCLUDE') excluded = true;
          if (action.kind === 'RESET') {
            temporalClass = baseClass;
            effectiveAvailableAt =
              version.document.availableAt === null
                ? null
                : maximum(version.document.availableAt, record.recordedAt);
            effectivePublishedAt = version.document.publishedAt ?? null;
            excluded = false;
          }
          if (action.kind === 'SET_PUBLICATION_TIME') {
            effectivePublishedAt = action.publishedAt;
            if (effectiveAvailableAt !== null)
              effectiveAvailableAt = maximum(effectiveAvailableAt, record.recordedAt);
          }
          if (action.kind === 'ESTIMATE_AVAILABILITY') {
            // An analyst cannot turn an estimate into verified evidence or backdate its knowledge.
            temporalClass = 'POINT_IN_TIME_ESTIMATED';
            effectiveAvailableAt = maximum(
              action.estimatedAvailableAt,
              version.processedAt,
              record.recordedAt,
            );
          }
        }
        const replayEligible =
          !excluded &&
          effectiveAvailableAt !== null &&
          effectiveAvailableAt <= decisionAt &&
          (temporalClass === 'POINT_IN_TIME_VERIFIED' ||
            (request.allowEstimated && temporalClass === 'POINT_IN_TIME_ESTIMATED'));
        return {
          version,
          versionHash: canonicalHash(version),
          temporalClass,
          effectiveAvailableAt,
          effectivePublishedAt,
          excluded,
          replayEligible,
          correctionHashes: applied.map((r) => r.hash),
        };
      })
      .filter((v) => request.mode === 'RESEARCH' || v.replayEligible);
    return NewsArticleResultSchema.parse({
      schemaVersion: 'news-reviewed-articles.v1',
      ...request,
      correctionHeadHash: this.#headAt(decisionAt),
      articles,
    });
  }
  queue(input: unknown) {
    const decisionAt = this.#at(input),
      state = this.store.state(),
      records = this.#known(decisionAt);
    const items: ReturnType<typeof NewsReviewQueueSchema.parse>['items'] = [];
    const add = (
      target: NewsReviewTarget,
      sourceId: string,
      sourceHash: string,
      category: 'UNPARSED' | 'LEGAL_RESTRICTIONS' | 'SUSPICIOUS_TIMESTAMP',
      detail: string,
      knownAt: string,
    ) => {
      const applied = records.filter((r) => sameTarget(r.target, target));
      let status: 'OPEN' | 'ACKNOWLEDGED' | 'EXCLUDED' = 'OPEN';
      for (const r of applied) {
        if (r.action.kind === 'RESET') status = 'OPEN';
        if (r.action.kind === 'EXCLUDE') status = 'EXCLUDED';
        if (
          status !== 'EXCLUDED' &&
          r.action.kind === 'ACKNOWLEDGE' &&
          r.action.category === category
        )
          status = 'ACKNOWLEDGED';
      }
      items.push({
        id: deterministicId('news-review', { target, category }),
        target,
        sourceId,
        sourceHash,
        category,
        detail,
        knownAt: UtcTimestampSchema.parse(knownAt),
        status,
        correctionHashes: applied.map((r) => r.hash),
      });
    };
    state.captures.forEach((c, i) => {
      if (c.processedAt > decisionAt) return;
      const parsed = state.parseResults[i]!,
        source = state.registry.sources.find(
          (s) => s.id === c.sourceId && s.version === c.sourceVersion,
        )!;
      const target = { kind: 'CAPTURE' as const, captureHash: newsCaptureHash(c), itemIndex: null };
      if (parsed.feedStatus === 'REJECTED')
        add(
          target,
          c.sourceId,
          canonicalHash(source),
          'UNPARSED',
          `Feed rejected: ${parsed.feedError}`,
          c.processedAt,
        );
      for (const rejected of parsed.rejected)
        add(
          { ...target, itemIndex: rejected.index },
          c.sourceId,
          canonicalHash(source),
          'UNPARSED',
          `Item ${rejected.index} rejected: ${rejected.reason}`,
          c.processedAt,
        );
    });
    for (const row of this.articles({ decisionAt }).articles) {
      const v = row.version,
        source = state.registry.sources.find((s) => canonicalHash(s) === v.sourceHash)!,
        target = { kind: 'DOCUMENT' as const, versionId: v.versionId };
      if (
        source.licensing.policy === 'METADATA_ONLY' ||
        !source.licensing.permitsSnippet ||
        (source.accessMethod === 'PUBLIC_HTTPS' && !source.licensing.approvedForLive)
      )
        add(
          target,
          source.id,
          v.sourceHash,
          'LEGAL_RESTRICTIONS',
          source.licensing.restrictions,
          v.processedAt,
        );
      if (
        v.document.qualityFlags.some((f) => f === 'UNCERTAIN_TIMESTAMP' || f === 'MISSING') ||
        (row.effectivePublishedAt !== null && row.effectivePublishedAt > v.observedAt) ||
        (v.updatedAt !== null &&
          row.effectivePublishedAt !== null &&
          v.updatedAt < row.effectivePublishedAt) ||
        row.temporalClass !== 'POINT_IN_TIME_VERIFIED'
      )
        add(
          target,
          source.id,
          v.sourceHash,
          'SUSPICIOUS_TIMESTAMP',
          'Missing/uncertain provider time, inconsistent dates or unverified historical availability; publication is not first observation.',
          v.processedAt,
        );
    }
    return NewsReviewQueueSchema.parse({
      schemaVersion: 'news-review-queue.v1',
      decisionAt,
      correctionHeadHash: this.#headAt(decisionAt),
      items,
    });
  }
  coverage(input: unknown) {
    const decisionAt = this.#at(input),
      { articles } = this.articles({ decisionAt }),
      state = this.store.state();
    const count = (rows: NewsReviewedDocument[]) => ({
      articles: rows.length,
      verified: rows.filter((r) => r.temporalClass === 'POINT_IN_TIME_VERIFIED').length,
      estimated: rows.filter((r) => r.temporalClass === 'POINT_IN_TIME_ESTIMATED').length,
      descriptive: rows.filter((r) => r.temporalClass === 'DESCRIPTIVE_ONLY').length,
    });
    const totals = count(articles);
    const languages = [...new Set(articles.map((r) => r.version.document.language))]
      .sort()
      .map((language) => {
        const rows = articles.filter((r) => r.version.document.language === language);
        return {
          language,
          ...count(rows),
          sourceIds: [...new Set(rows.map((r) => r.version.document.sourceId))].sort(),
        };
      });
    const latestSources = new Map<string, (typeof state.registry.sources)[number]>();
    for (const s of state.registry.sources) if (s.knownAt <= decisionAt) latestSources.set(s.id, s);
    const sources = [...latestSources.values()].map((s) => {
      const rows = articles.filter((r) => r.version.document.sourceId === s.id);
      return {
        sourceId: s.id,
        sourceHash: canonicalHash(s),
        declaredLanguages: s.languages,
        observedLanguages: [...new Set(rows.map((r) => r.version.document.language))].sort(),
        articles: rows.length,
      };
    });
    const parsed = state.parseResults.filter(
      (_r, i) => state.captures[i]!.processedAt <= decisionAt,
    );
    return NewsCoverageReportSchema.parse({
      schemaVersion: 'news-coverage-report.v1',
      decisionAt,
      correctionHeadHash: this.#headAt(decisionAt),
      ...totals,
      defensibleFirstObservedPercent:
        totals.articles === 0 ? null : ((totals.verified * 100) / totals.articles).toFixed(2),
      replayEligible: articles.filter((r) => r.replayEligible).length,
      excluded: articles.filter((r) => r.excluded).length,
      unparsedFeeds: parsed.filter((p) => p.feedStatus === 'REJECTED').length,
      rejectedItems: parsed.reduce((n, p) => n + p.rejected.length, 0),
      languages,
      sources,
    });
  }
}
