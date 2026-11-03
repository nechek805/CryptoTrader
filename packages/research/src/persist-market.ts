import {
  EventEnvelopeSchema,
  NormalizedMarketImportSchema,
  ResearchRunSchema,
  MarketSnapshotReferenceSchema,
} from '@crypto/contracts';
import type {
  InputReference,
  NormalizedMarketImport,
  StoredRevision,
  MarketBar,
} from '@crypto/contracts';
import { canonicalHash, canonicalJson, deterministicId } from '@crypto/core';
import type { ResearchDatabase } from '@crypto/db';
import { MarketImportError, byteHash } from '@crypto/connectors';
import { captureHash, rawCapturePayload } from './normalize-market.js';
import type { MarketSnapshot } from './market-snapshot.js';
import { verifyMarketSnapshot } from './market-snapshot.js';

export async function persistMarketImport(
  db: ResearchDatabase,
  input: NormalizedMarketImport,
  snapshot: MarketSnapshot,
  codeVersion: string,
) {
  const imported = NormalizedMarketImportSchema.parse(input);
  if (imported.rawBundles.reduce((count, bundle) => count + bundle.rows.length, 0) > 5000)
    throw new MarketImportError('LIMIT');
  if (
    codeVersion !== snapshot.manifest.codeVersion ||
    canonicalHash(imported.bars) !== snapshot.manifest.datasetHash ||
    canonicalHash(imported.request) !== canonicalHash(snapshot.manifest.request) ||
    byteHash(`${canonicalJson(imported.rawBundles)}\n`) !== snapshot.manifest.rawRowsHash ||
    byteHash(`${canonicalJson(imported.quarantine)}\n`) !== snapshot.manifest.quarantineHash
  )
    throw new MarketImportError('MANIFEST');
  const verified = await verifyMarketSnapshot(snapshot.directory);
  if (verified.metadataHash !== snapshot.metadataHash) throw new MarketImportError('MANIFEST');
  return db.transaction(async (repo) => {
    const batchKnownAt = imported.sources
      .map((source) => source.capturedAt)
      .sort()
      .at(-1);
    if (!batchKnownAt) throw new MarketImportError('PERSISTENCE');
    const rawIds = new Map<string, string>(),
      refs: InputReference[] = [],
      seenRaw = new Set<string>();
    let newRaw = 0,
      newVersions = 0;
    for (const bundle of imported.rawBundles)
      for (const row of bundle.rows) {
        const { source } = bundle,
          rawHash = captureHash(source, row),
          capturedAt = source.capturedAt;
        const envelope = EventEnvelopeSchema.parse({
          schemaVersion: 'event-envelope.v1',
          id: deterministicId('market-capture', { provider: source.provider, rawHash }),
          kind: 'market-archive-row',
          provider: source.provider,
          occurredAt: null,
          observedAt: capturedAt,
          availableAt: capturedAt,
          ingestedAt: capturedAt,
          availabilityBasis: 'OBSERVED',
          researchUse: 'ELIGIBLE',
          rawHash,
          payload: rawCapturePayload(source, row),
          qualityFlags: source.origin === 'FIXTURE' ? ['SYNTHETIC'] : [],
          provenance: {
            origin: source.origin,
            sourceIds: [source.provider],
            parentIds: [],
            sourceVersion: source.providerVersion,
            capturedAt,
            rawTimestamp: null,
          },
        });
        const saved = await repo.ingestRaw({ envelope, sourceRawId: null });
        newRaw += Number(saved.created);
        rawIds.set(rawHash, saved.record.id);
        if (!seenRaw.has(saved.record.id)) {
          seenRaw.add(saved.record.id);
          refs.push({
            kind: 'RAW_EVENT',
            id: saved.record.id,
            contentHash: saved.record.contentHash,
          });
        }
      }
    for (const item of imported.bars) {
      const rawId = rawIds.get(captureHash(item.source, item.row));
      if (!rawId) throw new MarketImportError('PERSISTENCE');
      let cursor: string | undefined, latest: StoredRevision<MarketBar> | undefined;
      do {
        const page = await repo.barHistory(
          item.bar.id,
          cursor
            ? { includeArchived: true, limit: 500, cursor }
            : { includeArchived: true, limit: 500 },
        );
        latest = page.items.at(-1) ?? latest;
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      const saved = await repo.appendMarketBar(item.bar, {
        sourceRawIds: [rawId],
        knownAt: batchKnownAt,
        previousVersionId: latest?.versionId ?? null,
      });
      newVersions += Number(saved.created);
      refs.push({
        kind: 'MARKET_BAR',
        id: saved.record.versionId,
        contentHash: saved.record.contentHash,
      });
    }
    if (refs.length === 0) throw new MarketImportError('PERSISTENCE');
    const logicalAt = imported.sources
      .map((source) => source.capturedAt)
      .sort()
      .at(-1);
    if (!logicalAt) throw new MarketImportError('PERSISTENCE');
    const reference = MarketSnapshotReferenceSchema.parse({
      schemaVersion: 'market-snapshot-reference.v1',
      snapshotId: snapshot.manifest.id,
      uri: `snapshot://${snapshot.manifest.id}/manifest.json`,
      metadataHash: snapshot.metadataHash,
      datasetHash: snapshot.manifest.datasetHash,
      parquetHash: snapshot.manifest.parquetHash,
      codeVersion,
    });
    const receipt = await repo.ingestRaw({
      sourceRawId: null,
      envelope: EventEnvelopeSchema.parse({
        schemaVersion: 'event-envelope.v1',
        id: deterministicId('snapshot-receipt', reference),
        kind: 'market-import-snapshot',
        provider: 'market-import',
        occurredAt: null,
        observedAt: logicalAt,
        availableAt: logicalAt,
        ingestedAt: logicalAt,
        availabilityBasis: 'OBSERVED',
        researchUse: 'DESCRIPTIVE_ONLY',
        payload: reference,
        rawHash: canonicalHash(reference),
        qualityFlags: imported.request.provider === 'fixture' ? ['SYNTHETIC'] : [],
        provenance: {
          origin: 'DERIVED',
          sourceIds: ['market-import'],
          parentIds: [...rawIds.values()].sort(),
          sourceVersion: imported.normalizationVersion,
          capturedAt: logicalAt,
          rawTimestamp: null,
        },
      }),
    });
    newRaw += Number(receipt.created);
    refs.push({
      kind: 'RAW_EVENT',
      id: receipt.record.id,
      contentHash: receipt.record.contentHash,
    });
    const run = ResearchRunSchema.parse({
      schemaVersion: 'research-run.v1',
      id: deterministicId('market-import-run', { snapshotId: snapshot.manifest.id, codeVersion }),
      purpose: imported.request.provider === 'fixture' ? 'FIXTURE_IMPORT' : 'DESCRIPTIVE_STUDY',
      execution: 'SIMULATED',
      experimentId: null,
      startedAt: logicalAt,
      completedAt: logicalAt,
      status: 'SUCCEEDED',
      reproducibility: {
        datasetHashes: [...new Set(refs.map((ref) => ref.contentHash))].sort(),
        configHash: snapshot.manifest.configHash,
        codeVersion,
        modelVersion: imported.normalizationVersion,
        randomSeed: 0,
        randomAlgorithm: 'mulberry32.v1',
        clockSemantics: 'utc-nanoseconds.v1',
        generatedAt: logicalAt,
        feeAssumptionsHash: canonicalHash({ execution: 'NONE', fees: 'NOT_APPLICABLE_TO_IMPORT' }),
      },
    });
    const saved = await repo.recordRun(run, refs);
    return {
      schemaVersion: 'market-persistence-report.v1',
      newRaw,
      newVersions,
      newRun: saved.created,
      runId: run.id,
      runHash: saved.record.contentHash,
      snapshotRecordId: receipt.record.id,
      audit: await repo.verifyAuditChain(),
    };
  });
}
