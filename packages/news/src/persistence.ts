import { EventEnvelopeSchema } from '@crypto/contracts';
import type { UtcTimestamp } from '@crypto/contracts';
import type { ResearchDatabase } from '@crypto/db';
import { canonicalHash, canonicalJson, deterministicId } from '@crypto/core';
import { newsCaptureHash } from './store.js';
import type { NewsIngestStore } from './store.js';

/** Provider/source stores are versioned registry events; documents use existing PG history. */
export async function persistNewsStore(db: ResearchDatabase, store: NewsIngestStore) {
  const state = store.state();
  return db.transaction(async (repo) => {
    let newRegistryRecords = 0,
      newCaptures = 0,
      newVersions = 0,
      newReceipts = 0;
    const raw = async (
      kind: string,
      provider: string,
      payload: unknown,
      observedAt: UtcTimestamp,
      availableAt: UtcTimestamp,
      origin: 'FIXTURE' | 'PUBLIC_READ_ONLY' | 'DERIVED',
      identity: string,
    ) => {
      const hash = canonicalHash(payload);
      const envelope = EventEnvelopeSchema.parse({
        schemaVersion: 'event-envelope.v1',
        id: deterministicId('news-evidence', { kind, provider, hash, identity }),
        kind,
        provider,
        occurredAt: null,
        observedAt,
        availableAt,
        ingestedAt: availableAt,
        processedAt: availableAt,
        availabilityBasis: 'OBSERVED',
        researchUse: 'ELIGIBLE',
        rawHash: hash,
        payload: JSON.parse(canonicalJson(payload)) as unknown,
        qualityFlags: origin === 'FIXTURE' ? ['SYNTHETIC'] : [],
        provenance: {
          origin,
          sourceIds: [provider],
          parentIds: [],
          sourceVersion: 'news-registry-ingest.v1',
          capturedAt: observedAt,
          rawTimestamp: null,
        },
      });
      return repo.ingestRaw({ envelope, sourceRawId: identity });
    };
    const registryIds = new Map<string, string>();
    for (const provider of state.registry.providers) {
      const saved = await raw(
        'news-provider',
        provider.id,
        provider,
        provider.knownAt,
        provider.knownAt,
        provider.kind === 'FIXTURE' ? 'FIXTURE' : 'DERIVED',
        `${provider.id}:${provider.version}`,
      );
      newRegistryRecords += Number(saved.created);
    }
    for (const source of state.registry.sources) {
      const saved = await raw(
        'news-source',
        source.providerId,
        source,
        source.knownAt,
        source.knownAt,
        source.accessMethod === 'FIXTURE' ? 'FIXTURE' : 'DERIVED',
        `${source.id}:${source.version}`,
      );
      registryIds.set(canonicalHash(source), saved.record.id);
      newRegistryRecords += Number(saved.created);
    }
    const captureIds = new Map<string, string>();
    for (let i = 0; i < state.captures.length; i++) {
      const capture = state.captures[i]!,
        source = state.registry.sources.find(
          (s) => s.id === capture.sourceId && s.version === capture.sourceVersion,
        )!;
      const captureHash = newsCaptureHash(capture);
      const saved = await raw(
        'news-feed-capture',
        source.providerId,
        { capture, parseResult: state.parseResults[i] },
        capture.observedAt,
        capture.processedAt,
        capture.origin,
        captureHash,
      );
      captureIds.set(captureHash, saved.record.id);
      newCaptures += Number(saved.created);
    }
    const previous = new Map<string, string>();
    for (const version of state.documents) {
      const saved = await repo.appendNewsDocument(version.document, {
        knownAt: version.processedAt,
        previousVersionId: previous.get(version.entityId) ?? null,
        sourceRawIds: [registryIds.get(version.sourceHash)!, captureIds.get(version.captureHash)!],
      });
      previous.set(version.entityId, saved.record.versionId);
      newVersions += Number(saved.created);
      const source = state.registry.sources.find(
        (s) => s.id === version.document.sourceId && s.version === version.sourceVersion,
      )!;
      const receipt = await raw(
        'news-document-metadata',
        source.providerId,
        { ...version, databaseVersionId: saved.record.versionId },
        version.observedAt,
        version.processedAt,
        version.document.provenance.origin === 'FIXTURE' ? 'FIXTURE' : 'PUBLIC_READ_ONLY',
        version.versionId,
      );
      newReceipts += Number(receipt.created);
    }
    return {
      schemaVersion: 'news-persistence-report.v1',
      newRegistryRecords,
      newCaptures,
      newVersions,
      newReceipts,
      audit: await repo.verifyAuditChain(),
    };
  });
}
