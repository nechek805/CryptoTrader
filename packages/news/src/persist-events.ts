import { EventEnvelopeSchema, NewsEventPersistenceSchema } from '@crypto/contracts';
import type { ResearchDatabase } from '@crypto/db';
import { canonicalHash, deterministicId } from '@crypto/core';
import { validateNewsEventSnapshot } from './event-snapshot.js';

export async function persistNewsEventSnapshot(db: ResearchDatabase, input: unknown) {
  const snapshot = validateNewsEventSnapshot(input),
    hash = canonicalHash(snapshot),
    observations = snapshot.input.graphRecords.filter((r) => r.action.kind === 'OBSERVE'),
    synthetic =
      observations.length > 0 &&
      observations.every(
        (r) =>
          r.action.kind === 'OBSERVE' &&
          r.action.extraction.input.article.version.document.provenance.origin === 'FIXTURE',
      );
  return db.transaction(async (repo) => {
    let created = 0;
    const payloads = [
      ...snapshot.input.metadataRecords.map((r) => ({
        hash: r.hash,
        payload: r,
        knownAt: r.recordedAt,
        kind: 'news-event-curation',
        parents: [r.targetHash, r.graphHeadHash],
        version: r.codeVersion,
      })),
      {
        hash,
        payload: snapshot,
        knownAt: snapshot.request.generatedAt,
        kind: 'news-event-snapshot',
        parents: [snapshot.view.graphHeadHash, snapshot.view.metadataHeadHash, snapshot.inputHash],
        version: snapshot.codeVersion,
      },
    ];
    for (const p of payloads) {
      const envelope = EventEnvelopeSchema.parse({
        schemaVersion: 'event-envelope.v1',
        id: deterministicId('news-event-evidence', p.hash),
        kind: p.kind,
        provider: 'local:news-events',
        occurredAt: null,
        observedAt: p.knownAt,
        availableAt: p.knownAt,
        processedAt: p.knownAt,
        ingestedAt: p.knownAt,
        availabilityBasis: 'OBSERVED',
        researchUse: 'ELIGIBLE',
        rawHash: p.hash,
        payload: p.payload,
        qualityFlags: synthetic ? ['SYNTHETIC'] : [],
        provenance: {
          origin: synthetic ? 'FIXTURE' : 'DERIVED',
          sourceIds: ['local:news-events'],
          parentIds: p.parents,
          sourceVersion: p.version,
          capturedAt: p.knownAt,
          rawTimestamp: null,
        },
      });
      created += Number((await repo.ingestRaw({ envelope, sourceRawId: p.hash })).created);
    }
    return NewsEventPersistenceSchema.parse({
      schemaVersion: 'news-event-persistence.v1',
      created,
      audit: await repo.verifyAuditChain(),
    });
  });
}
