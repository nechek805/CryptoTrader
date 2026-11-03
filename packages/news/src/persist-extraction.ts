import { EventEnvelopeSchema, NewsExtractionPersistenceSchema } from '@crypto/contracts';
import type { ResearchDatabase } from '@crypto/db';
import { canonicalHash, deterministicId } from '@crypto/core';
import { validateNewsExtractionResult } from './extractor.js';

/** Each versioned extraction is raw derived evidence; no existing claims/articles are overwritten. */
export async function persistNewsExtraction(db: ResearchDatabase, input: unknown) {
  const result = validateNewsExtractionResult(input),
    hash = canonicalHash(result),
    synthetic = result.input.article.version.document.provenance.origin === 'FIXTURE';
  return db.transaction(async (repo) => {
    const envelope = EventEnvelopeSchema.parse({
      schemaVersion: 'event-envelope.v1',
      id: deterministicId('news-extraction-evidence', hash),
      kind: 'news-claim-extraction',
      provider: 'local:news-extractor',
      occurredAt: null,
      observedAt: result.processedAt,
      ingestedAt: result.processedAt,
      processedAt: result.processedAt,
      availableAt: result.processedAt,
      availabilityBasis: 'OBSERVED',
      researchUse: 'ELIGIBLE',
      rawHash: hash,
      payload: result,
      qualityFlags: synthetic ? ['SYNTHETIC'] : [],
      provenance: {
        origin: synthetic ? 'FIXTURE' : 'DERIVED',
        sourceIds: [result.input.source.id],
        parentIds: [
          result.input.article.versionHash,
          result.input.article.version.captureHash,
          result.configHash,
        ],
        sourceVersion: result.adapter.modelVersion,
        capturedAt: result.processedAt,
        rawTimestamp: null,
      },
    });
    const saved = await repo.ingestRaw({ envelope, sourceRawId: hash });
    return NewsExtractionPersistenceSchema.parse({
      schemaVersion: 'news-extraction-persistence.v1',
      created: saved.created,
      hash,
      audit: await repo.verifyAuditChain(),
    });
  });
}
