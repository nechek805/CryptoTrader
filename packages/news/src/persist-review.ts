import { EventEnvelopeSchema, NewsCorrectionPersistenceSchema } from '@crypto/contracts';
import type { ResearchDatabase } from '@crypto/db';
import { deterministicId } from '@crypto/core';
import { validateNewsCorrectionChain } from './review.js';
import type { NewsReviewService } from './review.js';
import { newsCaptureHash } from './store.js';

/** Versioned correction evidence, never an UPDATE of a captured NewsDocument. */
export async function persistNewsCorrections(db: ResearchDatabase, service: NewsReviewService) {
  const records = validateNewsCorrectionChain(service.records()),
    state = service.store.state();
  return db.transaction(async (repo) => {
    let created = 0;
    for (const record of records) {
      const target = record.target;
      const version =
        target.kind === 'DOCUMENT'
          ? state.documents.find((v) => v.versionId === target.versionId)
          : undefined;
      const capture =
        target.kind === 'CAPTURE'
          ? state.captures.find((c) => newsCaptureHash(c) === target.captureHash)
          : undefined;
      const sourceId = version?.document.sourceId ?? capture!.sourceId;
      const synthetic = (version?.document.provenance.origin ?? capture?.origin) === 'FIXTURE';
      const envelope = EventEnvelopeSchema.parse({
        schemaVersion: 'event-envelope.v1',
        id: deterministicId('news-correction-evidence', record.hash),
        kind: 'news-analyst-correction',
        provider: 'local:news-review',
        occurredAt: null,
        observedAt: record.recordedAt,
        availableAt: record.recordedAt,
        ingestedAt: record.recordedAt,
        processedAt: record.recordedAt,
        availabilityBasis: 'OBSERVED',
        researchUse: 'ELIGIBLE',
        rawHash: record.hash,
        payload: record,
        qualityFlags: synthetic ? ['SYNTHETIC'] : [],
        provenance: {
          origin: 'DERIVED',
          sourceIds: ['local:news-review', sourceId],
          parentIds: [record.targetHash],
          sourceVersion: record.codeVersion,
          capturedAt: record.recordedAt,
          rawTimestamp: null,
        },
      });
      const result = await repo.ingestRaw({ envelope, sourceRawId: record.hash });
      created += Number(result.created);
    }
    return NewsCorrectionPersistenceSchema.parse({
      schemaVersion: 'news-correction-persistence.v1',
      created,
      audit: await repo.verifyAuditChain(),
    });
  });
}
