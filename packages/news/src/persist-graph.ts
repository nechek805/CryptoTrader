import { EventEnvelopeSchema, NewsGraphPersistenceSchema } from '@crypto/contracts';
import type { ResearchDatabase } from '@crypto/db';
import { deterministicId } from '@crypto/core';
import type { NewsGraphService } from './graph.js';

export async function persistNewsGraph(db: ResearchDatabase, service: NewsGraphService) {
  const corpusSynthetic = service
    .records()
    .filter((r) => r.action.kind === 'OBSERVE')
    .every(
      (r) =>
        r.action.kind === 'OBSERVE' &&
        r.action.extraction.input.article.version.document.provenance.origin === 'FIXTURE',
    );
  return db.transaction(async (repo) => {
    let created = 0;
    for (const record of service.records()) {
      const extraction = record.action.kind === 'OBSERVE' ? record.action.extraction : null,
        origin =
          extraction?.input.article.version.document.provenance.origin ??
          (corpusSynthetic ? 'FIXTURE' : 'DERIVED');
      const envelope = EventEnvelopeSchema.parse({
        schemaVersion: 'event-envelope.v1',
        id: deterministicId('news-graph-evidence', record.hash),
        kind: 'news-provenance-graph',
        provider: 'local:news-graph',
        occurredAt: null,
        observedAt: record.recordedAt,
        availableAt: record.recordedAt,
        ingestedAt: record.recordedAt,
        processedAt: record.recordedAt,
        availabilityBasis: 'OBSERVED',
        researchUse: 'ELIGIBLE',
        rawHash: record.hash,
        payload: record,
        qualityFlags: origin === 'FIXTURE' ? ['SYNTHETIC'] : [],
        provenance: {
          origin: origin === 'FIXTURE' ? 'FIXTURE' : 'DERIVED',
          sourceIds: extraction ? [extraction.input.source.id] : ['local:news-graph'],
          parentIds:
            record.action.kind === 'OBSERVE'
              ? [record.action.extraction.input.article.versionHash, record.configHash]
              : [record.action.targetHash, record.previousHash],
          sourceVersion: record.codeVersion,
          capturedAt: record.recordedAt,
          rawTimestamp: null,
        },
      });
      created += Number((await repo.ingestRaw({ envelope, sourceRawId: record.hash })).created);
    }
    return NewsGraphPersistenceSchema.parse({
      schemaVersion: 'news-graph-persistence.v1',
      created,
      audit: await repo.verifyAuditChain(),
    });
  });
}
