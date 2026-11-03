import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildNewsReviewApp } from '@crypto/api';
import { canonicalHash, MockClock, utc } from '@crypto/core';
import {
  buildNewsSnapshot,
  NewsCorrectionJournal,
  NewsReviewService,
  newsCorrectionGenesis,
  verifyNewsSnapshot,
  writeNewsSnapshot,
  NewsIngestStore,
} from '@crypto/news';
import type { NewsCorrectionRecord } from '@crypto/contracts';
import { newsReviewFixtureCaptures, newsFixtureRegistry } from '@crypto/connectors';
import { loadNewsReviewStore } from '../apps/cli/src/news-input.js';

const directories: string[] = [],
  journals: NewsCorrectionJournal[] = [];
async function temporary() {
  const path = await mkdtemp(join(tmpdir(), 'crypto-news-review-'));
  directories.push(path);
  return path;
}
afterEach(async () => {
  for (const journal of journals.splice(0)) await journal.close();
  for (const path of directories.splice(0)) {
    if (
      dirname(resolve(path)) !== resolve(tmpdir()) ||
      !basename(path).startsWith('crypto-news-review-')
    )
      throw new Error('Unsafe cleanup');
    await rm(path, { recursive: true, force: true });
  }
});
async function setup(directory?: string) {
  const store = await loadNewsReviewStore('fixture', 'unused', 'synthetic-review-test.v1'),
    clock = new MockClock('2026-01-01T00:20:00Z'),
    path = directory ?? (await temporary()),
    journal = await NewsCorrectionJournal.acquire(path);
  journals.push(journal);
  const service = new NewsReviewService(
    store,
    journal.records,
    clock,
    'synthetic-review-test.v1',
    journal,
  );
  const version = (name: string) =>
    store.state().documents.find((v) => v.providerItemId === `synthetic-review-${name}`)!;
  const request = (name: string, action: NewsCorrectionRecord['action']) => ({
    schemaVersion: 'news-correction-request.v1',
    target: { kind: 'DOCUMENT', versionId: version(name).versionId },
    operator: 'synthetic:analyst',
    reason: 'Synthetic analyst test decision',
    expectedHeadHash: service.headHash(),
    action,
  });
  return { store, clock, path, journal, service, version, request };
}
describe('news historical review and corrections', () => {
  it('classifies actual receipt, archived estimates and unknown availability independently of publication', async () => {
    const { service, version, clock } = await setup(),
      rows = service.articles({ decisionAt: clock.now() }).articles;
    expect(
      rows.find((r) => r.version.versionId === version('verified').versionId)?.temporalClass,
    ).toBe('POINT_IN_TIME_VERIFIED');
    expect(
      rows.find((r) => r.version.versionId === version('archived').versionId)?.temporalClass,
    ).toBe('POINT_IN_TIME_ESTIMATED');
    expect(rows.find((r) => r.version.versionId === version('unknown').versionId)).toMatchObject({
      temporalClass: 'DESCRIPTIVE_ONLY',
      effectiveAvailableAt: null,
      replayEligible: false,
    });
    const replay = service.articles({
      decisionAt: clock.now(),
      mode: 'REPLAY',
      allowEstimated: true,
    });
    expect(replay.articles.some((r) => r.temporalClass === 'DESCRIPTIVE_ONLY')).toBe(false);
    expect(replay.articles.some((r) => r.temporalClass === 'POINT_IN_TIME_ESTIMATED')).toBe(true);
    expect(
      service.articles({ decisionAt: '2020-01-01T00:00:00Z', mode: 'REPLAY' }).articles,
    ).toHaveLength(0);
  });
  it('cannot promote fabricated publication metadata or a publication correction into historical replay', async () => {
    const { service, version, request, clock } = await setup();
    const old = canonicalHash(service.articles({ decisionAt: '2026-01-01T00:15:00Z' }));
    await service.correct(
      request('unknown', {
        kind: 'SET_PUBLICATION_TIME',
        publishedAt: utc('2020-01-01T00:00:00Z'),
      }),
    );
    expect(canonicalHash(service.articles({ decisionAt: '2026-01-01T00:15:00Z' }))).toBe(old);
    expect(
      service
        .articles({ decisionAt: clock.now(), mode: 'REPLAY', allowEstimated: true })
        .articles.some((r) => r.version.versionId === version('unknown').versionId),
    ).toBe(false);
    expect(
      service
        .articles({ decisionAt: clock.now() })
        .articles.find((r) => r.version.versionId === version('unknown').versionId)?.temporalClass,
    ).toBe('DESCRIPTIVE_ONLY');
  });
  it('records manual operator, reason, server time and evidence hash; estimates become known only at override time', async () => {
    const { service, request, version, clock } = await setup(),
      past = '2026-01-01T00:15:00Z';
    const old = canonicalHash(service.articles({ decisionAt: past }));
    const record = await service.correct(
      request('unknown', {
        kind: 'ESTIMATE_AVAILABILITY',
        estimatedAvailableAt: utc('2020-01-01T00:00:00Z'),
        evidenceReferences: ['fixture://synthetic-estimate'],
      }),
    );
    expect(record).toMatchObject({
      operator: 'synthetic:analyst',
      reason: 'Synthetic analyst test decision',
      recordedAt: clock.now(),
      targetHash: canonicalHash(version('unknown')),
      previousHash: newsCorrectionGenesis,
    });
    expect(canonicalHash(service.articles({ decisionAt: past }))).toBe(old);
    const row = service
      .articles({ decisionAt: clock.now(), allowEstimated: true })
      .articles.find((r) => r.version.versionId === version('unknown').versionId)!;
    expect(row).toMatchObject({
      temporalClass: 'POINT_IN_TIME_ESTIMATED',
      effectiveAvailableAt: clock.now(),
      replayEligible: true,
    });
    expect(
      service
        .articles({ decisionAt: clock.now(), mode: 'REPLAY' })
        .articles.some((r) => r.version.versionId === version('unknown').versionId),
    ).toBe(false);
  });
  it('excludes and resets prospectively without mutating evidence or past views', async () => {
    const { service, store, request, clock, version } = await setup(),
      stateHash = canonicalHash(store.state()),
      past = '2026-01-01T00:15:00Z';
    const old = canonicalHash(service.articles({ decisionAt: past, mode: 'REPLAY' }));
    await service.correct(request('verified', { kind: 'EXCLUDE' }));
    const excludedAt = clock.now();
    expect(
      service
        .articles({ decisionAt: excludedAt, mode: 'REPLAY' })
        .articles.some((r) => r.version.versionId === version('verified').versionId),
    ).toBe(false);
    clock.advanceBy(1n, 'seconds');
    await service.correct(request('verified', { kind: 'RESET' }));
    expect(
      service
        .articles({ decisionAt: clock.now(), mode: 'REPLAY' })
        .articles.some((r) => r.version.versionId === version('verified').versionId),
    ).toBe(true);
    expect(
      service
        .articles({ decisionAt: excludedAt, mode: 'REPLAY' })
        .articles.some((r) => r.version.versionId === version('verified').versionId),
    ).toBe(false);
    expect(canonicalHash(service.articles({ decisionAt: past, mode: 'REPLAY' }))).toBe(old);
    expect(canonicalHash(store.state())).toBe(stateHash);
  });
  it('queues unparsed feeds/items, legal restrictions and suspicious dates with provenance', async () => {
    const { service, clock } = await setup(),
      queue = service.queue({ decisionAt: clock.now() });
    expect(new Set(queue.items.map((i) => i.category))).toEqual(
      new Set(['UNPARSED', 'LEGAL_RESTRICTIONS', 'SUSPICIOUS_TIMESTAMP']),
    );
    expect(queue.items.filter((i) => i.category === 'UNPARSED')).toHaveLength(3);
    expect(queue.items.some((i) => i.target.kind === 'CAPTURE' && i.target.itemIndex === 0)).toBe(
      true,
    );
    expect(
      queue.items.every((i) => i.sourceHash.startsWith('sha256:') && i.status === 'OPEN'),
    ).toBe(true);
    expect(
      service
        .queue({ decisionAt: '2026-01-01T00:05:01Z' })
        .items.some((i) => i.category === 'UNPARSED'),
    ).toBe(false);
  });
  it('acknowledges rejected metadata without fabricating a parsed article or changing past queue state', async () => {
    const { service, clock } = await setup(),
      query = { decisionAt: clock.now() },
      queue = service.queue(query),
      target = queue.items.find((i) => i.category === 'UNPARSED')!,
      before = service.coverage(query).articles;
    await service.correct({
      schemaVersion: 'news-correction-request.v1',
      target: target.target,
      operator: 'synthetic:analyst',
      reason: 'Synthetic rejection acknowledged',
      expectedHeadHash: service.headHash(),
      action: { kind: 'ACKNOWLEDGE', category: 'UNPARSED' },
    });
    expect(service.queue(query).items.find((i) => i.id === target.id)?.status).toBe('ACKNOWLEDGED');
    expect(service.coverage(query).articles).toBe(before);
    expect(
      service.queue({ decisionAt: '2026-01-01T00:15:00Z' }).items.find((i) => i.id === target.id)
        ?.status,
    ).toBe('OPEN');
    await expect(
      service.correct({
        schemaVersion: 'news-correction-request.v1',
        target: target.target,
        operator: 'synthetic:analyst',
        reason: 'Invalid attempt to invent an article',
        expectedHeadHash: service.headHash(),
        action: {
          kind: 'ESTIMATE_AVAILABILITY',
          estimatedAvailableAt: clock.now(),
          evidenceReferences: ['fixture://test'],
        },
      }),
    ).rejects.toThrow();
  });
  it('reports latest article denominators, actual languages, declared source coverage and unparsed counts', async () => {
    const { service, clock } = await setup(),
      report = service.coverage({ decisionAt: clock.now() });
    expect(report).toMatchObject({
      articles: 9,
      verified: 7,
      estimated: 1,
      descriptive: 1,
      defensibleFirstObservedPercent: '77.78',
      replayEligible: 7,
      unparsedFeeds: 2,
      rejectedItems: 1,
    });
    expect(report.languages.find((r) => r.language === 'ru')?.articles).toBe(1);
    expect(report.sources.find((r) => r.sourceId === 'fixture:official')?.articles).toBe(5);
    expect(service.coverage({ decisionAt: '2020-01-01T00:00:00Z' })).toMatchObject({
      articles: 0,
      defensibleFirstObservedPercent: null,
      sources: [],
    });
  });
  it('requires strict manual fields and rejects supplied timestamps, unknown targets and stale heads', async () => {
    const { service, request, clock } = await setup(),
      valid = request('verified', { kind: 'EXCLUDE' });
    for (const bad of [
      { ...valid, operator: '' },
      { ...valid, reason: ' ' },
      { ...valid, recordedAt: clock.now() },
      { ...valid, target: { kind: 'DOCUMENT', versionId: 'unknown' } },
      { ...valid, expectedHeadHash: canonicalHash('stale') },
    ])
      await expect(service.correct(bad)).rejects.toThrow();
    expect(service.records()).toHaveLength(0);
  });
  it('serializes concurrent overrides and rejects the losing optimistic head', async () => {
    const { service, request } = await setup(),
      requestA = request('verified', { kind: 'EXCLUDE' }),
      requestB = request('unknown', { kind: 'EXCLUDE' });
    const results = await Promise.allSettled([
      service.correct(requestA),
      service.correct(requestB),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect(service.records()).toHaveLength(1);
  });
  it('restarts the durable ledger, refuses a second writer and rejects corruption or partial records', async () => {
    const { service, journal, path, request, store, clock } = await setup();
    await expect(NewsCorrectionJournal.acquire(path)).rejects.toThrow();
    await service.correct(request('verified', { kind: 'EXCLUDE' }));
    await journal.close();
    const reopened = await NewsCorrectionJournal.acquire(path);
    journals.push(reopened);
    expect(new NewsReviewService(store, reopened.records, clock, 'test').headHash()).toBe(
      service.headHash(),
    );
    await reopened.close();
    const file = join(path, 'corrections.jsonl'),
      original = await readFile(file, 'utf8');
    await writeFile(file, original.replace('synthetic:analyst', 'synthetic:tamper'));
    await expect(NewsCorrectionJournal.acquire(path)).rejects.toThrow();
    await writeFile(file, original.slice(0, -1));
    await expect(NewsCorrectionJournal.acquire(path)).rejects.toThrow();
  });
  it('rejects a rehashed ledger targeting different evidence and future or pre-evidence operator times', async () => {
    const { service, request, store, clock } = await setup();
    const record = await service.correct(request('verified', { kind: 'EXCLUDE' }));
    const rehash = (patch: object) => {
      const { hash, ...payload } = { ...record, ...patch };
      expect(hash).toMatch(/^sha256:/);
      return { ...payload, hash: canonicalHash(payload) };
    };
    for (const bad of [
      rehash({ targetHash: canonicalHash('other-evidence') }),
      rehash({ recordedAt: utc('2026-01-01T00:01:00Z') }),
      rehash({ recordedAt: utc('2027-01-01T00:00:00Z') }),
    ])
      expect(() => new NewsReviewService(store, [bad], clock, 'test')).toThrow();
  });
  it('keeps future estimates out until due and refuses future query timestamps', async () => {
    const { service, request, version, clock } = await setup();
    await service.correct(
      request('unknown', {
        kind: 'ESTIMATE_AVAILABILITY',
        estimatedAvailableAt: utc('2026-01-01T00:30:00Z'),
        evidenceReferences: ['fixture://synthetic'],
      }),
    );
    expect(
      service
        .articles({ decisionAt: clock.now(), allowEstimated: true, mode: 'REPLAY' })
        .articles.some((r) => r.version.versionId === version('unknown').versionId),
    ).toBe(false);
    expect(() => service.queue({ decisionAt: '2027-01-01T00:00:00Z' })).toThrow();
  });
});
describe('news review API and immutable snapshots', () => {
  it('validates read responses and protects writes with a local token and origin checks', async () => {
    const { service, request, clock } = await setup(),
      token = 'a'.repeat(64),
      app = buildNewsReviewApp(service, token);
    try {
      for (const route of ['review', 'coverage', 'articles']) {
        const result = await app.inject({
          method: 'POST',
          url: `/news/${route}`,
          payload: { decisionAt: clock.now() },
        });
        expect(result.statusCode).toBe(200);
        expect(result.headers['cache-control']).toBe('no-store');
      }
      for (const headers of [
        {},
        { authorization: `Bearer ${token}`, origin: 'https://untrusted.invalid' },
      ])
        expect(
          (
            await app.inject({
              method: 'POST',
              url: '/news/corrections',
              headers,
              payload: request('verified', { kind: 'EXCLUDE' }),
            })
          ).statusCode,
        ).toBe(403);
      const payload = request('verified', { kind: 'EXCLUDE' });
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/news/corrections',
            headers: { authorization: `Bearer ${token}` },
            payload,
          })
        ).statusCode,
      ).toBe(201);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/news/corrections',
            headers: { authorization: `Bearer ${token}` },
            payload,
          })
        ).statusCode,
      ).toBe(409);
      const invalid = await app.inject({
        method: 'POST',
        url: '/news/articles',
        payload: { decisionAt: clock.now(), secret: 'should-not-echo' },
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.body).not.toContain('should-not-echo');
    } finally {
      await app.close();
    }
  });
  it('exports reproducible policy-approved evidence, source/version hashes and replay exclusions', async () => {
    const { store, service, clock } = await setup(),
      out = await temporary(),
      request = { decisionAt: clock.now(), generatedAt: clock.now(), mode: 'REPLAY' };
    const first = await writeNewsSnapshot(store, service.records(), request, out, 'synthetic.v1'),
      second = await writeNewsSnapshot(store, service.records(), request, out, 'synthetic.v1');
    expect(second.hash).toBe(first.hash);
    expect((await verifyNewsSnapshot(first.path)).hash).toBe(first.hash);
    expect(first.artifact.result.articles).toHaveLength(7);
    expect(
      first.artifact.input.captures.every(
        (r) => r.capture.raw === '' && r.capture.rawRetention === 'HASH_ONLY',
      ),
    ).toBe(true);
    expect(first.artifact.versionHashes).toHaveLength(10); // Includes original headline revision.
    expect(first.artifact.sourceHashes).toHaveLength(4);
    expect(
      first.artifact.result.articles.every((r) => r.temporalClass === 'POINT_IN_TIME_VERIFIED'),
    ).toBe(true);
  });
  it('does not leak future captures, source versions or corrections into old snapshots', async () => {
    const { store, service, request, clock } = await setup(),
      query = { decisionAt: utc('2026-01-01T00:08:01Z'), generatedAt: clock.now() },
      before = buildNewsSnapshot(store, [], query, 'synthetic.v1');
    await service.correct(request('unknown', { kind: 'EXCLUDE' }));
    const registry = store.registry.snapshot(),
      future = structuredClone(registry.sources[0]!);
    future.version = 2;
    future.knownAt = utc('2026-01-02T00:00:00Z');
    const extended = new NewsIngestStore({ ...registry, sources: [...registry.sources, future] });
    const state = store.state();
    state.captures.forEach((capture, i) => extended.ingestParsed(capture, state.parseResults[i]));
    const after = buildNewsSnapshot(extended, service.records(), query, 'synthetic.v1');
    expect(canonicalHash(after)).toBe(canonicalHash(before));
    expect(after.corrections).toHaveLength(0);
    expect(after.input.captures.every((r) => r.capture.processedAt <= query.decisionAt)).toBe(true);
  });
  it('detects forged report/source hashes even when the file is renamed to its new content hash', async () => {
    const { store, clock } = await setup(),
      out = await temporary(),
      artifact = buildNewsSnapshot(
        store,
        [],
        { decisionAt: clock.now(), generatedAt: clock.now() },
        'synthetic.v1',
      );
    for (const forged of [
      { ...artifact, sourceHashes: [] },
      { ...artifact, coverage: { ...artifact.coverage, verified: 9 } },
    ]) {
      const path = join(out, `news-snapshot_${canonicalHash(forged).slice(7)}.json`);
      await writeFile(path, JSON.stringify(forged));
      await expect(verifyNewsSnapshot(path)).rejects.toThrow();
    }
  });
  it('treats acknowledgement as review state without granting storage rights or changing temporal evidence', async () => {
    const { service, clock } = await setup(),
      queue = service.queue({ decisionAt: clock.now() }),
      item = queue.items.find((i) => i.category === 'LEGAL_RESTRICTIONS')!;
    const before = service.coverage({ decisionAt: clock.now() });
    await service.correct({
      schemaVersion: 'news-correction-request.v1',
      target: item.target,
      operator: 'synthetic:analyst',
      reason: 'Synthetic policy reviewed; original limits still apply',
      expectedHeadHash: service.headHash(),
      action: { kind: 'ACKNOWLEDGE', category: 'LEGAL_RESTRICTIONS' },
    });
    expect(
      service.queue({ decisionAt: clock.now() }).items.find((i) => i.id === item.id)?.status,
    ).toBe('ACKNOWLEDGED');
    expect(service.coverage({ decisionAt: clock.now() }).replayEligible).toBe(
      before.replayEligible,
    );
  });
  it('provides a separate labelled synthetic review package with unknown/archived/rejected date cases', async () => {
    const rows = await newsReviewFixtureCaptures(),
      registry = await newsFixtureRegistry();
    expect(rows.every((r) => r.capture.origin === 'FIXTURE')).toBe(true);
    expect(new Set(rows.map((r) => r.capture.availabilityEvidence))).toEqual(
      new Set(['OBSERVED', 'ARCHIVED_CAPTURE', 'UNKNOWN']),
    );
    expect(rows.some((r) => r.parsed.rejected.length > 0)).toBe(true);
    expect(registry.sources.every((s) => s.licensing.policy === 'SYNTHETIC')).toBe(true);
  });
});
