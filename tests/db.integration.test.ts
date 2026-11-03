import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { zipSync, strToU8 } from 'fflate';
import {
  FixtureMarketDataProvider,
  BinanceArchiveMarketDataProvider,
  byteHash,
} from '@crypto/connectors';
import { normalizeMarketImport, writeMarketSnapshot, persistMarketImport } from '@crypto/research';
import { MarketImportRequestSchema } from '@crypto/contracts';
import {
  EventEnvelopeSchema,
  MarketBarSchema,
  NewsDocumentSchema,
  ResearchRunSchema,
} from '@crypto/contracts';
import type { InputReference } from '@crypto/contracts';
import { canonicalHash, MockClock, utc } from '@crypto/core';
import { ResearchDatabase } from '@crypto/db';
import type { ReadRepository, RepositorySession } from '@crypto/db';
import { createDomainFixtures } from './fixtures/domain.js';
import { seedDatabase } from '../apps/cli/src/database-fixtures.js';
import { FixtureNewsProvider, newsFixtureRegistry } from '@crypto/connectors';
import {
  NewsIngestStore,
  persistNewsStore,
  NewsReviewService,
  persistNewsCorrections,
} from '@crypto/news';
import { parseLiveNewsCapture } from '@crypto/connectors';
import {
  newsTemporalEventFixtures,
  buildNewsEventSnapshot,
  persistNewsEventSnapshot,
} from '@crypto/news';
import {
  defaultNewsGraphConfig,
  NewsGraphService,
  newsGraphFixtures,
  persistNewsGraph,
} from '@crypto/news';
import {
  DeterministicNewsClaimAdapter,
  defaultNewsExtractionConfig,
  NewsClaimExtractor,
  newsExtractionFixtures,
  persistNewsExtraction,
} from '@crypto/news';

const fixtures = createDomainFixtures();
const marketDirectories: string[] = [];
async function marketDirectory() {
  const path = await mkdtemp(join(tmpdir(), 'crypto-market-db-'));
  marketDirectories.push(path);
  return path;
}
let admin: Client, db: ResearchDatabase, schema: string, connectionString: string;
const clock = new MockClock('2026-10-30T00:00:00Z');
const makeEnvelope = (index: number) =>
  EventEnvelopeSchema.parse({
    ...fixtures.eventEnvelope,
    id: `envelope:${index}`,
    payload: { fixture: index },
    rawHash: canonicalHash({ fixture: index }),
  });
const ingestBar = () =>
  db.transaction(async (repo) => {
    const raw = await repo.ingestRaw({ envelope: fixtures.eventEnvelope, sourceRawId: 'market:1' });
    return repo.appendMarketBar(fixtures.marketBar, {
      sourceRawIds: [raw.record.id],
      previousVersionId: null,
      knownAt: fixtures.marketBar.availableAt ?? '',
    });
  });

async function ingestNewsFixtures() {
  const provider = new FixtureNewsProvider(),
    store = new NewsIngestStore(await newsFixtureRegistry());
  for (const entry of await provider.list())
    store.ingest(
      await provider.read({
        fixtureId: entry.id,
        source: store.registry.source(entry.sourceId, entry.observedAt),
      }),
    );
  return store;
}

describe('news provider/source/document persistence', () => {
  it('persists immutable temporal snapshots and curated lineage idempotently without changing article history', async () => {
    await persistNewsStore(db, await ingestNewsFixtures());
    const before = await db.read((repo) => repo.newsAt(utc('2026-01-01T11:01:00Z'))),
      f = await newsTemporalEventFixtures(),
      snapshot = buildNewsEventSnapshot(
        f.graphConfig,
        f.graphRecords,
        f.metadataRecords,
        f.config,
        { decisionAt: '2026-01-01T10:46:00Z', generatedAt: f.now },
        'synthetic-event-db.v1',
      ),
      first = await persistNewsEventSnapshot(db, snapshot),
      repeat = await persistNewsEventSnapshot(db, snapshot);
    expect(first.created).toBe(6);
    expect(repeat.created).toBe(0);
    expect(repeat.audit).toEqual(first.audit);
    expect(await db.read((repo) => repo.newsAt(utc('2026-01-01T11:01:00Z')))).toEqual(before);
    const hash = canonicalHash(snapshot),
      raw = await db.read((repo) => repo.findRawDelivery('local:news-events', hash));
    expect(raw?.envelope).toMatchObject({
      availableAt: f.now,
      qualityFlags: ['SYNTHETIC'],
      payload: { schemaVersion: 'news-event-snapshot.v1' },
    });
    expect(raw?.envelope.provenance.parentIds).toContain(snapshot.view.metadataHeadHash);
    const forged = structuredClone(snapshot);
    forged.view.events[0]!.identity.claimIds = [];
    await expect(persistNewsEventSnapshot(db, forged)).rejects.toThrow();
    expect((await db.read((repo) => repo.verifyAuditChain())).headHash).toBe(first.audit.headHash);
  });
  it('persists source-graph observations and retractions idempotently without rewriting historical views', async () => {
    const source = await ingestNewsFixtures();
    await persistNewsStore(db, source);
    const beforeNews = await db.read((repo) => repo.newsAt(utc('2026-01-01T10:00:00Z'))),
      graphClock = new MockClock('2026-01-01T09:00:00Z'),
      graph = new NewsGraphService(
        defaultNewsGraphConfig(),
        [],
        graphClock,
        'synthetic-graph-db.v1',
        { append: () => Promise.resolve() },
      ),
      rows = (await newsGraphFixtures()).filter((r) =>
        ['wire', 'copy-one', 'copy-two', 'copy-three'].includes(r.id),
      );
    for (const row of rows) {
      graphClock.advanceTo(row.recordedAt);
      await graph.observe(row.result);
    }
    const past = graphClock.now(),
      oldView = canonicalHash(graph.query({ decisionAt: past }));
    graphClock.advanceBy(1n, 'seconds');
    const retraction = await graph.decide({
      schemaVersion: 'news-graph-decision-request.v1',
      expectedHeadHash: graph.headHash(),
      operator: 'synthetic:analyst',
      reason: 'Synthetic origin withdrawal',
      action: { kind: 'RETRACT', claimId: rows[0]!.result.claims[0]!.id },
    });
    const first = await persistNewsGraph(db, graph),
      second = await persistNewsGraph(db, graph);
    expect(first.created).toBe(5);
    expect(second.created).toBe(0);
    expect(second.audit).toEqual(first.audit);
    expect(canonicalHash(graph.query({ decisionAt: past }))).toBe(oldView);
    expect(await db.read((repo) => repo.newsAt(utc('2026-01-01T10:00:00Z')))).toEqual(beforeNews);
    const raw = await db.read((repo) => repo.findRawDelivery('local:news-graph', retraction.hash));
    expect(raw?.envelope).toMatchObject({
      availableAt: graphClock.now(),
      qualityFlags: ['SYNTHETIC'],
      payload: { action: { operator: 'synthetic:analyst', reason: 'Synthetic origin withdrawal' } },
    });
  });
  it('persists unverified extraction provenance and currency-separated claims idempotently at extraction time', async () => {
    const row = (await newsExtractionFixtures()).find((v) => v.id === 'currencies')!,
      extractionClock = new MockClock('2026-01-01T00:03:00Z'),
      extractor = new NewsClaimExtractor(
        new DeterministicNewsClaimAdapter(),
        defaultNewsExtractionConfig(),
        extractionClock,
        'synthetic-extraction-db.v1',
      ),
      result = await extractor.extract(row.input),
      first = await persistNewsExtraction(db, result),
      repeat = await persistNewsExtraction(db, result);
    expect(first.created).toBe(true);
    expect(repeat.created).toBe(false);
    expect(repeat.audit).toEqual(first.audit);
    const raw = await db.read((repo) => repo.findRawDelivery('local:news-extractor', first.hash));
    expect(raw?.envelope).toMatchObject({
      availableAt: extractionClock.now(),
      processedAt: extractionClock.now(),
      qualityFlags: ['SYNTHETIC'],
    });
    expect(raw?.envelope.provenance.parentIds).toContain(row.input.article.versionHash);
    expect(result.claims.map((c) => c.candidate.amounts[0]?.unit)).toEqual(['USD', 'EUR']);
    expect(
      result.claims.every(
        (c) =>
          c.canonical.verifiedStatus === 'UNVERIFIED' &&
          c.canonical.firstKnownAt === extractionClock.now(),
      ),
    ).toBe(true);
    const tampered = structuredClone(result);
    tampered.claims[0]!.canonical.verifiedStatus = 'CORROBORATED';
    await expect(persistNewsExtraction(db, tampered)).rejects.toThrow();
    expect((await db.read((repo) => repo.verifyAuditChain())).count).toBe(first.audit.count);
  });
  it('persists analyst corrections idempotently without rewriting historical documents', async () => {
    const store = await ingestNewsFixtures();
    await persistNewsStore(db, store);
    const historicalAt = utc('2026-01-01T00:05:01Z'),
      before = await db.read((repo) => repo.newsAt(historicalAt)),
      manualClock = new MockClock('2026-01-01T00:20:00Z'),
      service = new NewsReviewService(store, [], manualClock, 'synthetic-correction-test.v1', {
        append: () => Promise.resolve(),
      }),
      target = store.state().documents.at(-1)!;
    const correction = await service.correct({
      schemaVersion: 'news-correction-request.v1',
      target: { kind: 'DOCUMENT', versionId: target.versionId },
      operator: 'synthetic:analyst',
      reason: 'Synthetic legal exclusion',
      expectedHeadHash: service.headHash(),
      action: { kind: 'EXCLUDE' },
    });
    const first = await persistNewsCorrections(db, service),
      second = await persistNewsCorrections(db, service);
    expect(first.created).toBe(1);
    expect(second.created).toBe(0);
    expect(second.audit).toEqual(first.audit);
    expect(await db.read((repo) => repo.newsAt(historicalAt))).toEqual(before);
    const raw = await db.read((repo) => repo.findRawDelivery('local:news-review', correction.hash));
    expect(raw?.envelope).toMatchObject({
      availableAt: manualClock.now(),
      payload: {
        operator: 'synthetic:analyst',
        reason: 'Synthetic legal exclusion',
        recordedAt: manualClock.now(),
      },
      qualityFlags: ['SYNTHETIC'],
    });
    expect(raw?.envelope.provenance.parentIds).toContain(correction.targetHash);
  });
  it('persists v2 uncertain-date receipts without manufacturing a publication timestamp', async () => {
    const registry = await newsFixtureRegistry(),
      provider = new FixtureNewsProvider(),
      store = new NewsIngestStore(registry);
    const source = store.registry.source('fixture:official', utc('2026-01-01T00:01:00Z')),
      original = await provider.read({ fixtureId: 'official-v1', source });
    const raw = original.raw.replace('+0300', '-0000'),
      capture = { ...original, raw, rawHash: byteHash(raw) },
      parsed = parseLiveNewsCapture(source, capture);
    store.ingestParsed(capture, parsed);
    await persistNewsStore(db, store);
    const rows = (await db.read((repo) => repo.newsAt(utc('2026-01-01T00:01:01Z')))).items;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.record.publishedAt).toBeUndefined();
    expect(rows[0]?.record.qualityFlags).toContain('UNCERTAIN_TIMESTAMP');
    expect((await persistNewsStore(db, store)).newVersions).toBe(0);
  });
  it('persists the registry, retained/hash-only captures, versions and metadata idempotently', async () => {
    const store = await ingestNewsFixtures();
    const first = await persistNewsStore(db, store),
      second = await persistNewsStore(db, store);
    expect(first).toMatchObject({
      newRegistryRecords: 7,
      newCaptures: 7,
      newVersions: 6,
      newReceipts: 6,
      audit: { valid: true, count: 46 },
    });
    expect(second).toMatchObject({
      newRegistryRecords: 0,
      newCaptures: 0,
      newVersions: 0,
      newReceipts: 0,
    });
    expect(second.audit).toEqual(first.audit);
    const entity = store
      .state()
      .documents.find((v) => v.publicationType === 'OFFICIAL_SECURITY')!.entityId;
    const history = await db.read((repo) => repo.newsHistory(entity));
    expect(history.items.map((v) => v.revision)).toEqual([1, 2]);
    const raws = await db.read(async (repo) =>
      Promise.all(history.items[1]!.sourceRawIds.map((id) => repo.getRaw(id))),
    );
    expect(raws.every((v) => v !== null)).toBe(true);
    expect(JSON.stringify(raws)).toContain('news-source.v1');
  });
  it('keeps updated headlines out of earlier decision views', async () => {
    const store = await ingestNewsFixtures();
    await persistNewsStore(db, store);
    expect((await db.read((repo) => repo.newsAt(utc('2026-01-01T00:01:00Z')))).items).toHaveLength(
      0,
    );
    const before = (await db.read((repo) => repo.newsAt(utc('2026-01-01T00:05:00Z')))).items.find(
      (v) => v.record.sourceId === 'fixture:official',
    );
    const after = (await db.read((repo) => repo.newsAt(utc('2026-01-01T00:05:01Z')))).items.find(
      (v) => v.record.sourceId === 'fixture:official',
    );
    expect(before?.record.title).toContain('scheduled');
    expect(after?.record.title).toContain('postponed');
    expect(after?.record.firstObservedAt).toBe(before?.record.firstObservedAt);
  });
  it('retains descriptive-only capture versions without making them eligible', async () => {
    const registry = await newsFixtureRegistry(),
      provider = new FixtureNewsProvider(),
      store = new NewsIngestStore(registry);
    const source = store.registry.source('fixture:official', utc('2026-01-01T00:01:00Z'));
    store.ingest({
      ...(await provider.read({ fixtureId: 'official-v1', source })),
      availabilityEvidence: 'UNKNOWN',
    });
    await persistNewsStore(db, store);
    expect((await db.read((repo) => repo.newsAt(utc('2026-01-01T00:10:00Z')))).items).toHaveLength(
      0,
    );
    expect(
      (await db.read((repo) => repo.newsHistory(store.state().documents[0]!.entityId))).items,
    ).toHaveLength(1);
  });
});

beforeAll(async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url)
    throw new Error(
      'TEST_DATABASE_URL must point to a dedicated local test PostgreSQL instance; tests never silently skip',
    );
  connectionString = url;
  admin = new Client({ connectionString, connectionTimeoutMillis: 3000 });
  await admin.connect();
});
beforeEach(async () => {
  schema = `crypto_test_${randomUUID().replaceAll('-', '')}`;
  db = new ResearchDatabase({ connectionString, schema }, () => clock.now());
  await db.migrate();
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const path of marketDirectories.splice(0)) {
    if (
      dirname(resolve(path)) !== resolve(tmpdir()) ||
      !basename(path).startsWith('crypto-market-db-')
    )
      throw new Error('Unsafe test cleanup target');
    await rm(path, { recursive: true, force: true });
  }
  await db?.close();
  if (schema && /^crypto_test_[a-f0-9]{32}$/.test(schema))
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
});
afterAll(async () => {
  await admin?.end();
});

describe('actual PostgreSQL persistence', () => {
  it('persists a complete market import twice with no duplicate captures, versions, runs or audit entries', async () => {
    const request = MarketImportRequestSchema.parse({
      schemaVersion: 'market-import-request.v1',
      provider: 'fixture',
      symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-01T00:05:00Z',
    });
    const imported = normalizeMarketImport(
      request,
      await new FixtureMarketDataProvider().read(request),
    );
    const snapshot = await writeMarketSnapshot(
      imported,
      await marketDirectory(),
      'market-test-code.v1',
    );
    const first = await persistMarketImport(db, imported, snapshot, 'market-test-code.v1'),
      second = await persistMarketImport(db, imported, snapshot, 'market-test-code.v1');
    expect(first).toMatchObject({ newRaw: 19, newVersions: 9, newRun: true });
    expect(second).toMatchObject({
      newRaw: 0,
      newVersions: 0,
      newRun: false,
      runId: first.runId,
      runHash: first.runHash,
      audit: first.audit,
    });
    expect(first.audit.count).toBe(29);
    expect((await db.read((repo) => repo.listRaw())).items).toHaveLength(19);
    expect((await db.read((repo) => repo.barsAt(utc('2026-01-01T00:05:00Z')))).items).toHaveLength(
      0,
    );
    expect((await db.read((repo) => repo.barsAt(utc('2026-01-02T00:00:00Z')))).items).toHaveLength(
      9,
    );
    const run = await db.read((repo) => repo.getResearchRecord(first.runId));
    expect(run?.record.schemaVersion).toBe('research-run.v1');
    const receipt = await db.read((repo) => repo.getRaw(first.snapshotRecordId));
    expect(receipt?.envelope.payload).toMatchObject({
      schemaVersion: 'market-snapshot-reference.v1',
      metadataHash: snapshot.metadataHash,
    });
    expect(run?.inputs.some((ref) => ref.id === first.snapshotRecordId)).toBe(true);
    await expect(
      persistMarketImport(db, imported, snapshot, 'different-code'),
    ).rejects.toMatchObject({ code: 'MANIFEST' });
  });
  it('stores archive-format imports as descriptive versions without exposing them to historical decisions', async () => {
    const root = await marketDirectory(),
      name = 'BTCUSDT-1m-2025-01-01',
      csv = '1735689600000000,100,102,99,101,10,1735689659999999,1000,4,5,500,0\n';
    const bytes = zipSync(
        { [`${name}.csv`]: strToU8(csv) },
        { mtime: new Date('2026-01-01T00:00:00Z') },
      ),
      path = join(root, `${name}.zip`);
    await writeFile(path, bytes);
    await writeFile(`${path}.CHECKSUM`, `${byteHash(bytes).slice(7)}  ${name}.zip\n`);
    const request = MarketImportRequestSchema.parse({
      schemaVersion: 'market-import-request.v1',
      provider: 'binance-archive',
      symbols: ['BTCUSDT'],
      from: '2025-01-01T00:00:00Z',
      to: '2025-01-01T00:01:00Z',
    });
    const provider = new BinanceArchiveMarketDataProvider([
      {
        path,
        marketType: 'SPOT',
        capturedAt: '2026-01-02T00:00:00Z',
        sourceUri: `https://data.binance.vision/data/spot/daily/klines/BTCUSDT/1m/${name}.zip`,
      },
    ]);
    const imported = normalizeMarketImport(request, await provider.read(request)),
      snapshot = await writeMarketSnapshot(imported, root, 'market-test-code.v1');
    const report = await persistMarketImport(db, imported, snapshot, 'market-test-code.v1');
    expect(report).toMatchObject({ newRaw: 2, newVersions: 1, newRun: true });
    expect((await db.read((repo) => repo.barsAt(utc('2030-01-01T00:00:00Z')))).items).toHaveLength(
      0,
    );
    expect(
      (await db.read((repo) => repo.barHistory(imported.bars[0]?.bar.id ?? ''))).items[0]?.record
        .researchUse,
    ).toBe('DESCRIPTIVE_ONLY');
  });
  it('migrates a clean schema, rolls back and reproduces the same schema/checksum', async () => {
    const before = await admin.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema=$1 ORDER BY table_name`,
      [schema],
    );
    expect(await db.migrate()).toEqual(['0001_foundation']);
    await seedDatabase(db, 'migration-data-test:v1');
    expect(await db.migrate('down')).toEqual([]);
    const dropped = await admin.query(`SELECT * FROM "${schema}"._migrations`);
    expect(dropped.rows).toEqual([]);
    expect(await db.migrate()).toEqual(['0001_foundation']);
    const after = await admin.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema=$1 ORDER BY table_name`,
      [schema],
    );
    expect(after.rows).toEqual(before.rows);
  });

  it('rejects changed migration checksums without partially applying changes', async () => {
    const old = await admin.query<{ checksum: string }>(
      `SELECT checksum FROM "${schema}"._migrations`,
    );
    await admin.query(`UPDATE "${schema}"._migrations SET checksum=$1`, [
      canonicalHash('tampered'),
    ]);
    await expect(db.migrate()).rejects.toMatchObject({ code: 'MIGRATION' });
    await admin.query(`UPDATE "${schema}"._migrations SET checksum=$1`, [old.rows[0]?.checksum]);
    expect(await db.migrate()).toEqual(['0001_foundation']);
  });

  it('deduplicates repeated and concurrent deliveries by provider/raw ID and content hash', async () => {
    const input = { envelope: fixtures.eventEnvelope, sourceRawId: 'market:1' };
    const results = await Promise.all(
      Array.from({ length: 8 }, () => db.transaction((repo) => repo.ingestRaw(input))),
    );
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.record.id)).size).toBe(1);
    const alias = await db.transaction((repo) =>
      repo.ingestRaw({ ...input, sourceRawId: 'market:alias' }),
    );
    expect(alias.created).toBe(false);
    const noId = await db.transaction((repo) => repo.ingestRaw({ ...input, sourceRawId: null }));
    expect(noId.created).toBe(false);
    expect((await db.read((repo) => repo.listRaw())).items).toHaveLength(1);
    expect((await db.read((repo) => repo.findRawDelivery('fixture', 'market:alias')))?.id).toBe(
      results[0]?.record.id,
    );
    expect((await db.read((repo) => repo.verifyAuditChain())).count).toBe(3);
  });

  it('preserves the first delivery metadata and rejects conflicting immutable keys', async () => {
    const first = await db.transaction((repo) =>
      repo.ingestRaw({ envelope: fixtures.eventEnvelope, sourceRawId: 'same' }),
    );
    const later = {
      ...fixtures.eventEnvelope,
      id: 'envelope:later',
      observedAt: '2026-01-02T00:00:00Z',
      availableAt: '2026-01-02T00:00:00Z',
      ingestedAt: '2026-01-02T00:00:00Z',
      processedAt: '2026-01-02T00:00:00Z',
    };
    const repeated = await db.transaction((repo) =>
      repo.ingestRaw({ envelope: later, sourceRawId: 'same' }),
    );
    expect(repeated.record.envelope).toEqual(first.record.envelope);
    await expect(
      db.transaction((repo) => repo.ingestRaw({ envelope: makeEnvelope(2), sourceRawId: 'same' })),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      db.transaction((repo) =>
        repo.ingestRaw({
          envelope: { ...fixtures.eventEnvelope, payload: { different: true } },
          sourceRawId: null,
        }),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await db.read((repo) => repo.listRaw())).items).toHaveLength(1);
  });

  it('rolls back all raw/derived/audit changes if a transaction fails', async () => {
    await expect(
      db.transaction(async (repo) => {
        await repo.ingestRaw({ envelope: fixtures.eventEnvelope, sourceRawId: 'rollback' });
        await repo.appendMarketBar(fixtures.marketBar, {
          sourceRawIds: ['missing:raw'],
          knownAt: fixtures.marketBar.availableAt ?? '',
          previousVersionId: null,
        });
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await db.read((repo) => repo.listRaw())).items).toHaveLength(0);
    expect((await db.read((repo) => repo.verifyAuditChain())).count).toBe(0);
  });

  it('appends corrections while retaining raw originals and earlier decision views', async () => {
    const first = await ingestBar();
    const correction = MarketBarSchema.parse({
      ...fixtures.marketBar,
      close: '101',
      availableAt: '2026-01-01T00:02:00Z',
      qualityFlags: ['SYNTHETIC', 'CORRECTED'],
    });
    const second = await db.transaction((repo) =>
      repo.appendMarketBar(correction, {
        sourceRawIds: first.record.sourceRawIds,
        previousVersionId: first.record.versionId,
        knownAt: correction.availableAt ?? '',
      }),
    );
    expect(second.record.revision).toBe(2);
    expect(second.record.previousVersionId).toBe(first.record.versionId);
    expect((await db.read((repo) => repo.barHistory(fixtures.marketBar.id))).items).toHaveLength(2);
    const before = await db.read((repo) => repo.barsAt(utc('2026-01-01T00:01:59.999999999Z')));
    const after = await db.read((repo) => repo.barsAt(utc('2026-01-01T00:02:00Z')));
    expect(before.items[0]?.record.close).toBe('100');
    expect(after.items[0]?.record.close).toBe('101');
    expect(
      (await db.read((repo) => repo.getRaw(first.record.sourceRawIds[0] ?? '')))?.envelope.payload,
    ).toEqual(fixtures.marketBar);
    expect(
      (
        await db.transaction((repo) =>
          repo.appendMarketBar(correction, {
            sourceRawIds: first.record.sourceRawIds,
            previousVersionId: first.record.versionId,
            knownAt: correction.availableAt ?? '',
          }),
        )
      ).created,
    ).toBe(false);
    await expect(
      db.transaction((repo) =>
        repo.appendMarketBar(
          { ...correction, close: '99' },
          {
            sourceRawIds: first.record.sourceRawIds,
            previousVersionId: first.record.versionId,
            knownAt: '2026-01-01T00:03:00Z',
          },
        ),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('does not fall back to obsolete eligible news after a descriptive correction', async () => {
    const news = fixtures.newsDocument;
    const envelope = EventEnvelopeSchema.parse({
      ...fixtures.eventEnvelope,
      kind: 'news-document',
      payload: news,
      observedAt: news.firstObservedAt,
      availableAt: news.availableAt,
      ingestedAt: news.availableAt,
      processedAt: news.availableAt,
      rawHash: canonicalHash(news),
    });
    const initial = await db.transaction(async (repo) => {
      const raw = await repo.ingestRaw({ envelope, sourceRawId: 'news:1' });
      return repo.appendNewsDocument(news, {
        sourceRawIds: [raw.record.id],
        previousVersionId: null,
        knownAt: news.availableAt ?? '',
      });
    });
    const corrected = NewsDocumentSchema.parse({
      ...news,
      title: 'Retracted availability evidence',
      researchUse: 'DESCRIPTIVE_ONLY',
      availabilityBasis: 'UNKNOWN',
      availableAt: null,
    });
    await db.transaction((repo) =>
      repo.appendNewsDocument(corrected, {
        sourceRawIds: initial.record.sourceRawIds,
        previousVersionId: initial.record.versionId,
        knownAt: '2026-01-01T00:02:00Z',
      }),
    );
    expect((await db.read((repo) => repo.newsAt(utc('2026-01-01T00:01:59Z')))).items).toHaveLength(
      1,
    );
    expect((await db.read((repo) => repo.newsAt(utc('2026-01-01T00:02:00Z')))).items).toHaveLength(
      0,
    );
    expect((await db.read((repo) => repo.newsHistory(news.id))).items).toHaveLength(2);
  });

  it('enforces correction parent, revision time, natural identity and source causality', async () => {
    const first = await ingestBar();
    const options = {
      sourceRawIds: first.record.sourceRawIds,
      previousVersionId: null,
      knownAt: '2026-01-01T00:02:00Z',
    };
    const updated = { ...fixtures.marketBar, availableAt: '2026-01-01T00:02:00Z', close: '101' };
    await expect(
      db.transaction((repo) => repo.appendMarketBar(updated, options)),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      db.transaction((repo) =>
        repo.appendMarketBar(
          { ...fixtures.marketBar, id: 'other:logical:id' },
          { ...options, knownAt: fixtures.marketBar.availableAt ?? '' },
        ),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const descriptive = EventEnvelopeSchema.parse({
      ...makeEnvelope(9),
      researchUse: 'DESCRIPTIVE_ONLY',
      availabilityBasis: 'UNKNOWN',
      availableAt: null,
    });
    const raw = await db.transaction((repo) =>
      repo.ingestRaw({ envelope: descriptive, sourceRawId: null }),
    );
    await expect(
      db.transaction((repo) =>
        repo.appendMarketBar(
          { ...fixtures.marketBar, id: 'unbacked:bar' },
          { ...options, sourceRawIds: [raw.record.id] },
        ),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('round-trips nanosecond instants beyond int64 epoch range and decimal quantities', async () => {
    const bar = MarketBarSchema.parse({
      ...fixtures.marketBar,
      id: 'bar:far-future',
      openAt: '2500-01-01T00:00:00.000000001Z',
      closeAt: '2500-01-01T00:01:00.000000001Z',
      availableAt: '2500-01-01T00:01:00.000000002Z',
      volume: '9007199254740993.000000000000000001',
    });
    const result = await db.transaction(async (repo) => {
      const raw = await repo.ingestRaw({ envelope: fixtures.eventEnvelope, sourceRawId: null });
      return repo.appendMarketBar(bar, {
        sourceRawIds: [raw.record.id],
        previousVersionId: null,
        knownAt: bar.availableAt ?? '',
      });
    });
    expect(result.record.record.volume).toBe(bar.volume);
    expect(
      (await db.read((repo) => repo.barsAt(utc('2500-01-01T00:01:00.000000001Z')))).items,
    ).toHaveLength(0);
    expect(
      (await db.read((repo) => repo.barsAt(utc('2500-01-01T00:01:00.000000002Z')))).items[0]
        ?.record,
    ).toEqual(bar);
  });

  it('paginates without overlaps and refuses malformed or cross-query cursors', async () => {
    await db.transaction(async (repo) => {
      for (let i = 0; i < 5; i++)
        await repo.ingestRaw({ envelope: makeEnvelope(i), sourceRawId: null });
    });
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await db.read((repo) =>
        repo.listRaw(cursor ? { limit: 2, cursor } : { limit: 2 }),
      );
      ids.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
    const first = await db.read((repo) => repo.listRaw({ limit: 1 }));
    await expect(
      db.read((repo) => repo.listAudit({ cursor: first.nextCursor ?? '' })),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(db.read((repo) => repo.listRaw({ cursor: 'not-a-cursor' }))).rejects.toMatchObject(
      { code: 'VALIDATION' },
    );
    await expect(db.read((repo) => repo.listRaw({ limit: 501 }))).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });

  it('previews retention, archives a bounded batch and preserves bytes/audit for replay', async () => {
    const first = await ingestBar();
    const request = { kind: 'RAW_EVENT' as const, before: '2026-10-31T00:00:00Z', limit: 1 };
    const preview = await db.transaction((repo) => repo.archiveBefore(request));
    expect(preview.dryRun).toBe(true);
    expect(preview.ids).toEqual(first.record.sourceRawIds);
    expect((await db.read((repo) => repo.listRaw())).items).toHaveLength(1);
    await db.transaction((repo) => repo.archiveBefore({ ...request, dryRun: false }));
    expect((await db.read((repo) => repo.listRaw())).items).toHaveLength(0);
    expect((await db.read((repo) => repo.listRaw({ includeArchived: true }))).items).toHaveLength(
      1,
    );
    expect(
      (await db.read((repo) => repo.getBarVersion(first.record.versionId)))?.sourceRawIds,
    ).toEqual(first.record.sourceRawIds);
    expect((await db.read((repo) => repo.verifyAuditChain())).valid).toBe(true);
  });

  it('persists verified input references and code/config/dataset hashes in run manifests', async () => {
    const bar = await ingestBar();
    const refs: InputReference[] = [
      { kind: 'MARKET_BAR', id: bar.record.versionId, contentHash: bar.record.contentHash },
    ];
    const run = ResearchRunSchema.parse({
      schemaVersion: 'research-run.v1',
      id: 'run:1',
      purpose: 'FIXTURE_IMPORT',
      execution: 'SIMULATED',
      experimentId: null,
      startedAt: '2026-01-02T00:00:00Z',
      completedAt: '2026-01-02T00:00:01Z',
      status: 'SUCCEEDED',
      reproducibility: {
        ...fixtures.signalCandidate.reproducibility,
        generatedAt: '2026-01-02T00:00:01Z',
        datasetHashes: [bar.record.contentHash],
      },
    });
    const first = await db.transaction((repo) => repo.recordRun(run, refs));
    expect(first.record.record).toEqual(run);
    expect((await db.transaction((repo) => repo.recordRun(run, refs))).created).toBe(false);
    expect((await db.read((repo) => repo.listResearchRecords('RUN'))).items).toHaveLength(1);
    await expect(
      db.transaction((repo) =>
        repo.recordRun({ ...run, id: 'bad:run' }, [
          { ...refs[0]!, contentHash: canonicalHash('wrong') },
        ]),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('seeds twice with exactly four raw records, four versions, one experiment and one run', async () => {
    const first = await seedDatabase(db, 'test-source:v1'),
      second = await seedDatabase(db, 'test-source:v1');
    expect(first.newRaw).toBe(4);
    expect(first.newRevisions).toBe(4);
    expect(second.newRaw).toBe(0);
    expect(second.newRevisions).toBe(0);
    expect(second.runId).toBe(first.runId);
    expect(second.runHash).toBe(first.runHash);
    expect(second.audit).toEqual(first.audit);
    expect((await db.read((repo) => repo.listRaw())).items).toHaveLength(4);
    expect((await db.read((repo) => repo.listResearchRecords('RUN'))).items).toHaveLength(1);
    expect((await db.read((repo) => repo.listResearchRecords('EXPERIMENT'))).items).toHaveLength(1);
    expect(first.visibleBars).toBe(3);
    expect(first.visibleNews).toBe(1);
  });

  it('database triggers reject updates, deletes and truncation of immutable/audit history', async () => {
    await ingestBar();
    for (const [table, column] of [
      ['raw_events', 'provider'],
      ['raw_delivery_keys', 'provider'],
      ['derived_records', 'entity_id'],
      ['derived_sources', 'raw_event_id'],
      ['research_records', 'kind'],
      ['research_inputs', 'kind'],
      ['retention_marks', 'kind'],
      ['audit_entries', 'action'],
    ]) {
      await expect(
        admin.query(`UPDATE "${schema}".${table} SET ${column}=${column}`),
      ).rejects.toMatchObject({ code: '55000' });
      await expect(admin.query(`DELETE FROM "${schema}".${table}`)).rejects.toMatchObject({
        code: '55000',
      });
    }
    await expect(admin.query(`TRUNCATE "${schema}".audit_entries`)).rejects.toMatchObject({
      code: '55000',
    });
    expect((await db.read((repo) => repo.verifyAuditChain())).valid).toBe(true);
  });

  it('detects audit corruption when an administrative actor bypasses the mutation trigger', async () => {
    await ingestBar();
    await admin.query(`ALTER TABLE "${schema}".audit_entries DISABLE TRIGGER USER`);
    try {
      await admin.query(`UPDATE "${schema}".audit_entries SET content_hash=$1 WHERE sequence=1`, [
        canonicalHash('changed'),
      ]);
    } finally {
      await admin.query(`ALTER TABLE "${schema}".audit_entries ENABLE TRIGGER USER`);
    }
    await expect(db.read((repo) => repo.verifyAuditChain())).rejects.toMatchObject({
      code: 'CORRUPT',
    });
  });

  it('keeps article body content out of audit and errors and never logs driver parameters', async () => {
    const secret = 'SYNTHETIC_LICENSED_ARTICLE_BODY_SENTINEL';
    const log = vi.spyOn(console, 'log').mockImplementation(() => {}),
      error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await db.transaction((repo) =>
      repo.ingestRaw({
        envelope: { ...makeEnvelope(30), payload: { fullText: secret } },
        sourceRawId: null,
      }),
    );
    const audit = await db.read((repo) => repo.listAudit());
    expect(JSON.stringify(audit)).not.toContain(secret);
    let caught: unknown;
    try {
      await db.transaction(() => Promise.reject(new Error(secret)));
    } catch (failure) {
      caught = failure;
    }
    expect(caught).toMatchObject({ code: 'STORAGE' });
    expect(String(caught)).not.toContain(secret);
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('closes transaction sessions and rejects accidental use of the fixture reset on normal schemas', async () => {
    let escaped: ReadRepository | undefined;
    await db.read(async (repo) => {
      escaped = repo;
      await repo.listRaw();
    });
    if (!escaped) throw new Error('Missing session');
    await expect(escaped.listRaw()).rejects.toMatchObject({ code: 'CLOSED' });
    await expect(db.resetFixtures()).rejects.toMatchObject({ code: 'VALIDATION' });
  });
  it('blocks mutation in a read transaction even when a JavaScript caller bypasses its TypeScript interface', async () => {
    await expect(
      db.read((repo) => {
        return (repo as RepositorySession).ingestRaw({
          envelope: fixtures.eventEnvelope,
          sourceRawId: null,
        });
      }),
    ).rejects.toMatchObject({ code: 'READ_ONLY' });
    expect((await db.read((repo) => repo.listRaw())).items).toHaveLength(0);
  });
});
