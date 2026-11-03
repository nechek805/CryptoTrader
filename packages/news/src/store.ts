import { z } from 'zod';
import {
  NewsCaptureSchema,
  NewsDocumentSchema,
  NewsDocumentVersionSchema,
  NewsStoreSchema,
  NewsStoreV2Schema,
  AnyNewsParseResultSchema,
  UtcTimestampSchema,
} from '@crypto/contracts';
import type { NewsCapture, NewsDocumentVersion } from '@crypto/contracts';
import { canonicalHash, deepFreeze, deterministicId } from '@crypto/core';
import {
  NewsIngestError,
  parseNewsCapture,
  parseLiveNewsCapture,
  allowedNewsArticle,
  byteHash,
} from '@crypto/connectors';
import { NewsRegistry } from './registry.js';
import { canonicalNewsUrl, validateRestoredItem } from './dedup.js';

export function newsCaptureHash(capture: NewsCapture) {
  const identity: Partial<NewsCapture> = { ...capture };
  delete identity.raw;
  delete identity.rawRetention;
  return canonicalHash(identity);
}
export class NewsIngestStore {
  readonly registry: NewsRegistry;
  #captures: NewsCapture[] = [];
  #parsed: ReturnType<typeof AnyNewsParseResultSchema.parse>[] = [];
  #documents: NewsDocumentVersion[] = [];
  constructor(registryInput: unknown) {
    this.registry = new NewsRegistry(registryInput);
  }
  ingest(input: unknown) {
    const capture = NewsCaptureSchema.parse(input);
    const source = this.registry.source(capture.sourceId, capture.processedAt);
    if (
      source.version !== capture.sourceVersion ||
      source.knownAt > capture.observedAt ||
      capture.origin !== (source.accessMethod === 'FIXTURE' ? 'FIXTURE' : 'PUBLIC_READ_ONLY')
    )
      throw new NewsIngestError('POLICY');
    return this.ingestParsed(capture, parseNewsCapture(source, capture));
  }
  /** Validated retained metadata enables journal recovery without storing forbidden bodies. */
  ingestParsed(input: unknown, parsedInput: unknown) {
    const capture = NewsCaptureSchema.parse(input),
      source = this.registry.source(capture.sourceId, capture.processedAt);
    const parsed = AnyNewsParseResultSchema.parse(parsedInput),
      captureHash = newsCaptureHash(capture);
    if (
      source.version !== capture.sourceVersion ||
      source.knownAt > capture.observedAt ||
      capture.feedUrl !== source.feedUrl ||
      capture.origin !== (source.accessMethod === 'FIXTURE' ? 'FIXTURE' : 'PUBLIC_READ_ONLY') ||
      parsed.sourceId !== source.id ||
      parsed.rawHash !== capture.rawHash ||
      (capture.rawRetention === 'HASH_ONLY' && capture.raw !== '')
    )
      throw new NewsIngestError('INTEGRITY');
    if (
      capture.rawRetention === 'RETAINED' &&
      (byteHash(capture.raw) !== capture.rawHash ||
        canonicalHash(
          parsed.schemaVersion === 'news-parse-result.v2'
            ? parseLiveNewsCapture(source, capture)
            : parseNewsCapture(source, capture),
        ) !== canonicalHash(parsed))
    )
      throw new NewsIngestError('INTEGRITY');
    for (const item of parsed.items) {
      validateRestoredItem(item, source);
      if (allowedNewsArticle(item.canonicalUrl, source) !== item.canonicalUrl)
        throw new NewsIngestError('URL');
    }
    if (this.#captures.some((c) => newsCaptureHash(c) === captureHash))
      return { captureHash, newVersions: 0, parseResult: parsed };
    if (this.#captures.length >= 1000) throw new NewsIngestError('LIMIT');
    const changes: NewsDocumentVersion[] = [];
    for (const item of parsed.items) {
      const entityId = deterministicId('news-document', {
        sourceId: source.id,
        providerItemId: item.providerItemId,
      });
      const latest = this.#documents.filter((v) => v.entityId === entityId).at(-1);
      if (
        latest &&
        canonicalNewsUrl(latest.document.canonicalUrl) !== canonicalNewsUrl(item.canonicalUrl)
      )
        throw new NewsIngestError('CONFLICT');
      if (latest?.contentHash === item.contentHash && latest.sourceHash === canonicalHash(source))
        continue;
      if (
        latest &&
        (capture.observedAt < latest.observedAt || capture.processedAt <= latest.processedAt)
      )
        throw new NewsIngestError('CONFLICT');
      const revision = (latest?.revision ?? 0) + 1,
        versionId = deterministicId('news-document-version', {
          entityId,
          revision,
          contentHash: item.contentHash,
          captureHash,
        });
      const observed = capture.availabilityEvidence !== 'UNKNOWN';
      const document = NewsDocumentSchema.parse({
        schemaVersion: 'news-document.v1',
        id: entityId,
        sourceId: source.id,
        canonicalUrl: item.canonicalUrl,
        sourceChain: [
          {
            sourceId: source.id,
            documentId: entityId,
            relationship: source.publicationType === 'SYNDICATED' ? 'SYNDICATED' : 'ORIGINAL',
          },
        ],
        language: item.language,
        ...(item.publishedAt === null ? {} : { publishedAt: item.publishedAt }),
        firstObservedAt: latest?.document.firstObservedAt ?? capture.observedAt,
        availableAt: observed ? capture.processedAt : null,
        availabilityBasis: capture.availabilityEvidence,
        researchUse: observed ? 'ELIGIBLE' : 'DESCRIPTIVE_ONLY',
        licensing: {
          policy: source.licensing.policy,
          reference: source.licensing.reference,
          permitsSnippet: source.licensing.permitsSnippet,
        },
        contentHash: item.contentHash,
        title: item.title,
        ...(item.approvedSnippet === null ? {} : { approvedSnippet: item.approvedSnippet }),
        qualityFlags: [
          ...(capture.origin === 'FIXTURE' ? ['SYNTHETIC'] : []),
          ...(item.timestampStatus === 'MISSING'
            ? ['MISSING']
            : item.timestampStatus === 'UNCERTAIN'
              ? ['UNCERTAIN_TIMESTAMP']
              : []),
        ],
        provenance: {
          origin: capture.origin,
          sourceIds: [source.id],
          parentIds: [captureHash],
          sourceVersion: `news-source.v1/${source.version}`,
          capturedAt: capture.observedAt,
          rawTimestamp: null,
        },
      });
      changes.push(
        NewsDocumentVersionSchema.parse({
          schemaVersion: 'news-document-version.v1',
          versionId,
          entityId,
          revision,
          previousVersionId: latest?.versionId ?? null,
          providerItemId: item.providerItemId,
          sourceVersion: source.version,
          sourceHash: canonicalHash(source),
          captureHash,
          rawHash: capture.rawHash,
          contentHash: item.contentHash,
          observedAt: capture.observedAt,
          processedAt: capture.processedAt,
          updatedAt: item.updatedAt,
          rawPublishedAt: item.rawPublishedAt,
          rawUpdatedAt: item.rawUpdatedAt,
          independenceGroup: source.independenceGroup,
          publicationType: source.publicationType,
          document,
        }),
      );
    }
    if (this.#documents.length + changes.length > 2000) throw new NewsIngestError('LIMIT');
    const stored = NewsCaptureSchema.parse(
      source.licensing.permitsRawStorage && parsed.feedError !== 'LIMIT'
        ? capture
        : { ...capture, raw: '', rawRetention: 'HASH_ONLY' },
    );
    deepFreeze(stored);
    deepFreeze(parsed);
    changes.forEach((v) => deepFreeze(v));
    this.#captures.push(stored);
    this.#parsed.push(parsed);
    this.#documents.push(...changes);
    return { captureHash, newVersions: changes.length, parseResult: parsed };
  }
  state() {
    const v2 = this.#parsed.some((p) => p.schemaVersion === 'news-parse-result.v2');
    const state = (v2 ? NewsStoreV2Schema : NewsStoreSchema).parse({
      schemaVersion: v2 ? 'news-store.v2' : 'news-store.v1',
      registry: this.registry.snapshot(),
      captures: this.#captures,
      parseResults: this.#parsed,
      documents: this.#documents,
    });
    deepFreeze(state);
    return state;
  }
  history(input: unknown) {
    const request = z
      .strictObject({ entityId: z.string().min(1).max(200), decisionAt: UtcTimestampSchema })
      .parse(input);
    return Object.freeze(
      this.#documents.filter(
        (d) => d.entityId === request.entityId && d.processedAt <= request.decisionAt,
      ),
    );
  }
  documentsAt(input: unknown) {
    const request = z
      .strictObject({
        decisionAt: UtcTimestampSchema,
        mode: z.enum(['ELIGIBLE', 'DESCRIPTIVE_ONLY']),
      })
      .parse(input);
    const latest = new Map<string, NewsDocumentVersion>();
    for (const row of this.#documents)
      if (row.processedAt <= request.decisionAt) latest.set(row.entityId, row);
    return Object.freeze(
      [...latest.values()].filter(
        (v) =>
          request.mode === 'DESCRIPTIVE_ONLY' ||
          (v.document.researchUse === 'ELIGIBLE' &&
            v.document.availableAt !== null &&
            v.document.availableAt <= request.decisionAt),
      ),
    );
  }
}
