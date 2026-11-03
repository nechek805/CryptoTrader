import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, dirname, basename, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { DecimalStringSchema } from '@crypto/contracts';
import type { NewsEventRecord, NewsGraphRecord } from '@crypto/contracts';
import { canonicalHash, MockClock, utc } from '@crypto/core';
import { newsFixtureRegistry, byteHash } from '@crypto/connectors';
import {
  newsTemporalEventFixtures,
  NewsEventService,
  NewsEventJournal,
  buildNewsEventSnapshot,
  validateNewsEventSnapshot,
  writeNewsEventSnapshot,
  verifyNewsEventSnapshot,
  newsEventResearchInputs,
  newsEventProvenanceDot,
  defaultNewsGraphConfig,
  defaultNewsEventConfig,
  newsGraphFixtures,
  NewsGraphService,
  NewsIngestStore,
  NewsReviewService,
  NewsClaimExtractor,
  DeterministicNewsClaimAdapter,
  defaultNewsExtractionConfig,
} from '@crypto/news';

const corpus = newsTemporalEventFixtures(),
  directories: string[] = [],
  journals: NewsEventJournal[] = [];
async function temporary() {
  const path = await mkdtemp(join(tmpdir(), 'crypto-news-events-'));
  directories.push(path);
  return path;
}
afterEach(async () => {
  for (const journal of journals.splice(0)) await journal.close();
  for (const path of directories.splice(0)) {
    if (
      dirname(resolve(path)) !== resolve(tmpdir()) ||
      !basename(path).startsWith('crypto-news-events-')
    )
      throw new Error('Unsafe cleanup');
    await rm(path, { recursive: true, force: true });
  }
});
async function setup(records?: readonly NewsEventRecord[]) {
  const fixture = await corpus,
    clock = new MockClock(fixture.now),
    path = await temporary(),
    journal = await NewsEventJournal.acquire(path, fixture.config, fixture.graphConfig);
  journals.push(journal);
  for (const record of records ?? fixture.metadataRecords) await journal.append(record);
  const service = new NewsEventService(
      fixture.config,
      fixture.graphConfig,
      fixture.graphRecords,
      journal.records,
      clock,
      'synthetic-events-test.v1',
      journal,
    ),
    decide = (action: NewsEventRecord['action'], patch: object = {}) =>
      service.decide({
        schemaVersion: 'news-event-decision.v1',
        expectedGraphHeadHash: service.graphHeadHash(),
        expectedHeadHash: service.headHash(),
        operator: 'synthetic:analyst',
        reason: 'Synthetic temporal metadata decision',
        action,
        ...patch,
      }),
    snapshot = (at: string, generatedAt = fixture.now) =>
      buildNewsEventSnapshot(
        fixture.graphConfig,
        fixture.graphRecords,
        service.records(),
        fixture.config,
        { decisionAt: at, generatedAt },
        'synthetic-events-test.v1',
      );
  return { fixture, clock, path, journal, service, decide, snapshot };
}
describe('as-of event snapshots and temporal confidence', () => {
  it('cannot use the 10:00 confirmation at 09:00 or before graph receipt', async () => {
    const { service } = await setup();
    expect(service.query({ decisionAt: '2026-01-01T09:00:00Z' }).events).toHaveLength(0);
    const early = service.query({ decisionAt: '2026-01-01T09:45:00Z' });
    expect(early.events[0]?.status).toBe('UNVERIFIED');
    expect(early.events[0]?.history.firstIndependentCorroboration).toBeNull();
    expect(early.graph.nodes.some((n) => n.sourceId === 'fixture:temporal:confirmation')).toBe(
      false,
    );
    expect(
      service.query({ decisionAt: '2026-01-01T10:00:02Z' }).events[0]?.history
        .firstIndependentCorroboration,
    ).toBeNull();
    expect(
      service.query({ decisionAt: '2026-01-01T10:00:03Z' }).events[0]?.history
        .firstIndependentCorroboration?.sourceKnownAt,
    ).toBe(utc('2026-01-01T10:00:03Z'));
  });
  it('does not backdate an 08:30 publication first received at 09:10', async () => {
    const { service } = await setup();
    expect(service.query({ decisionAt: '2026-01-01T09:09:59Z' }).events).toHaveLength(0);
    const event = service.query({ decisionAt: '2026-01-01T09:10:03Z' }).events[0]!;
    expect(event.firstKnownAt).toBe(utc('2026-01-01T09:10:03Z'));
    expect(event.history.firstRumor?.sourceKnownAt).toBe(utc('2026-01-01T09:10:03Z'));
    expect(event.availableAt).toBe(utc('2026-01-01T09:10:03Z'));
  });
  it('stores rumor, separate corroboration, official statement and corrections independently', async () => {
    const { service } = await setup(),
      event = service.query({ decisionAt: '2026-01-01T10:40:00Z' }).events[0]!;
    expect(event.history.firstRumor?.sourceKnownAt).toBe(utc('2026-01-01T09:10:03Z'));
    expect(event.history.firstIndependentCorroboration?.sourceKnownAt).toBe(
      utc('2026-01-01T10:00:03Z'),
    );
    expect(event.history.firstOfficialStatement?.sourceKnownAt).toBe(utc('2026-01-01T10:10:03Z'));
    expect(event.history.corrections.map((c) => c.knownAt)).toEqual([
      utc('2026-01-01T10:30:00Z'),
      utc('2026-01-01T10:40:00Z'),
    ]);
    expect(service.query({ decisionAt: '2026-01-01T10:25:00Z' }).events[0]?.confidence.grade).toBe(
      'DISPUTED',
    );
    expect(event.history.firstIndependentCorroboration).not.toBeNull();
  });
  it('explains evidence confidence with broad origin-count bands and no invented factual probability', async () => {
    const { service } = await setup(),
      event = service.query({ decisionAt: '2026-01-01T10:05:00Z' }).events[0]!;
    expect(event.confidence.grade).toBe('MULTI_ORIGIN');
    expect(event.confidence.explanation.join(' ')).toContain('fallible');
    expect(event.confidence.uncertaintyBand).toMatchObject({
      interpretation: 'UNAUTHENTICATED_ORIGIN_COUNT_NOT_PROBABILITY',
      minimumOrigins: 0,
    });
    expect(event.confidence.uncertaintyBand.maximumOrigins).toBeGreaterThanOrEqual(2);
    expect(Object.keys(event.confidence)).not.toContain('probability');
  });
  it('retains scoped direct/second-order mapping provenance without inferring exposure from mentions', async () => {
    const { service } = await setup(),
      event = service.query({ decisionAt: '2026-01-01T09:45:00Z' }).events[0]!;
    expect(new Set(event.assets.map((a) => a.relationship))).toEqual(
      new Set(['MENTION_ONLY', 'DIRECT', 'SECOND_ORDER']),
    );
    const secondary = event.assets.find((a) => a.relationship === 'SECOND_ORDER')!;
    expect(secondary).toMatchObject({
      symbol: 'ETH',
      reference: 'fixture://synthetic-counterparty',
    });
    expect(secondary.ruleHash).toMatch(/^sha256:/);
    expect(secondary.knownAt <= utc('2026-01-01T09:45:00Z')).toBe(true);
  });
  it('uses only declared expectations predating first receipt and preserves unit comparison', async () => {
    const { service } = await setup();
    expect(service.query({ decisionAt: '2026-01-01T09:10:03Z' }).events[0]?.surprise.marker).toBe(
      'UNKNOWN',
    );
    expect(service.query({ decisionAt: '2026-01-01T09:45:00Z' }).events[0]?.surprise.marker).toBe(
      'SCHEDULED_MATCH',
    );
    const late = await setup([]);
    await late.decide({
      kind: 'EXPECT',
      anchorKey: 'timed-1',
      subject: 'Synthetic Vault',
      eventType: 'SECURITY_INCIDENT',
      amounts: [{ value: DecimalStringSchema.parse('99'), unit: 'USD' }],
      reference: 'fixture://late-expectation',
    });
    expect(late.service.query({ decisionAt: late.clock.now() }).events[0]?.surprise.marker).toBe(
      'UNKNOWN',
    );
  });
  it.each([
    ['99', 'USD', 'EXPECTATION_MISMATCH'],
    ['10', 'EUR', 'NOT_COMPARABLE'],
  ])('compares pre-receipt %s %s without currency conversion', async (value, unit, marker) => {
    const f = await corpus,
      clock = new MockClock('2026-01-01T08:00:00Z'),
      records: NewsEventRecord[] = [],
      initial = new NewsEventService(f.config, f.graphConfig, [], [], clock, 'synthetic.v1', {
        append: (r) => {
          records.push(r);
          return Promise.resolve();
        },
      });
    await initial.decide({
      schemaVersion: 'news-event-decision.v1',
      expectedGraphHeadHash: initial.graphHeadHash(),
      expectedHeadHash: initial.headHash(),
      operator: 'synthetic:analyst',
      reason: 'Synthetic prior comparison',
      action: {
        kind: 'EXPECT',
        anchorKey: 'timed-1',
        subject: 'Synthetic Vault',
        eventType: 'SECURITY_INCIDENT',
        amounts: [{ value: DecimalStringSchema.parse(value), unit }],
        reference: 'fixture://prior',
      },
    });
    clock.advanceTo(f.now);
    const service = new NewsEventService(
      f.config,
      f.graphConfig,
      f.graphRecords,
      records,
      clock,
      'synthetic.v1',
    );
    expect(service.query({ decisionAt: '2026-01-01T09:45:00Z' }).events[0]?.surprise.marker).toBe(
      marker,
    );
  });
  it('does not let later asset rules alter past snapshots or input hashes', async () => {
    const { service, clock, decide, snapshot } = await setup(),
      before = snapshot('2026-01-01T09:45:00Z');
    clock.advanceBy(1n, 'seconds');
    await decide({
      kind: 'MAP_ASSET',
      subject: 'Synthetic Vault',
      eventTypes: ['SECURITY_INCIDENT'],
      symbol: 'SOL',
      relationship: 'SECOND_ORDER',
      reference: 'fixture://new-rule',
    });
    expect(canonicalHash(snapshot('2026-01-01T09:45:00Z'))).toBe(canonicalHash(before));
    expect(
      service
        .query({ decisionAt: '2026-01-01T09:45:00Z' })
        .events[0]?.assets.some((a) => a.symbol === 'SOL'),
    ).toBe(false);
  });
  it('marks repeated corpus patterns and repost-only updates using only earlier evidence', async () => {
    const rows = await newsGraphFixtures(),
      clock = new MockClock('2026-01-01T09:00:00Z'),
      records: Parameters<NewsGraphService['observe']>[0][] = [],
      graphRecords: NewsGraphRecord[] = [],
      graph = new NewsGraphService(defaultNewsGraphConfig(), [], clock, 'synthetic-events.v1', {
        append: (r) => {
          graphRecords.push(r);
          return Promise.resolve();
        },
      });
    for (const row of rows) {
      clock.advanceTo(row.recordedAt);
      records.push(row.result);
      await graph.observe(row.result);
    }
    expect(records).toHaveLength(13);
    const view = new NewsEventService(
      defaultNewsEventConfig(),
      defaultNewsGraphConfig(),
      graphRecords,
      [],
      clock,
      'synthetic.v1',
    ).query({ decisionAt: clock.now() });
    expect(view.events.some((e) => e.novelty.pattern === 'REPEATED_PATTERN')).toBe(true);
    const alpha = view.events.find((e) => e.identity.label === 'alpha-1')!;
    expect(alpha.novelty.pattern).toBe('FIRST_SEEN_IN_CORPUS');
    expect(alpha.novelty.updateKind).toBe('REPOST_ONLY');
  });
});
describe('audited event lineage and conservative replay', () => {
  it('splits/merges preserve original IDs, retired parents, all claim members and operator reasons', async () => {
    const { service, fixture } = await setup(),
      split = service.query({ decisionAt: '2026-01-01T10:45:00Z' }),
      merged = service.query({ decisionAt: '2026-01-01T10:46:00Z' });
    expect(split.events.find((e) => e.identity.id === fixture.baseId)?.active).toBe(false);
    expect(
      split.events
        .filter((e) => e.active)
        .map((e) => e.identity.id)
        .sort(),
    ).toEqual([...fixture.splitIds].sort());
    const child = merged.events.find((e) => e.active)!;
    expect(child.identity.kind).toBe('MERGED');
    expect(child.identity.claimIds).toHaveLength(6);
    expect([...child.identity.parentIds].sort()).toEqual([...fixture.splitIds].sort());
    expect(child.firstKnownAt).toBe(utc('2026-01-01T10:46:00Z'));
    expect(merged.events.some((e) => e.identity.id === fixture.baseId)).toBe(true);
    expect(merged.events.filter((e) => e.identity.kind === 'SPLIT').every((e) => !e.active)).toBe(
      true,
    );
    expect(
      child.history.corrections.some(
        (c) => c.kind === 'MERGE' && c.operator === 'synthetic:scenario',
      ),
    ).toBe(true);
  });
  it('does not backdate child milestones or promote curated identity to factual confidence', async () => {
    const { service } = await setup(),
      event = service.query({ decisionAt: '2026-01-01T10:46:00Z' }).events.find((e) => e.active)!;
    expect(event.history.firstRumor?.sourceKnownAt).toBe(utc('2026-01-01T09:10:03Z'));
    expect(event.history.firstRumor?.eventKnownAt).toBe(utc('2026-01-01T10:46:00Z'));
    expect(event.confidence.grade).toBe('IDENTITY_REVIEW');
    expect(event.abstentionReasons).toContain('IDENTITY_REVIEW');
  });
  it('quarantines later unassigned evidence until an explicit new lineage decision', async () => {
    const { service, clock, decide } = await setup(),
      view = service.query({ decisionAt: clock.now() }),
      active = view.events.filter((e) => e.active);
    expect(active.some((e) => e.identity.kind === 'UNASSIGNED')).toBe(true);
    expect(active.every((e) => !e.replayEligible)).toBe(true);
    const old = canonicalHash(service.query({ decisionAt: '2026-01-01T10:46:00Z' }));
    clock.advanceBy(1n, 'seconds');
    await decide({
      kind: 'MERGE',
      eventIds: active.map((e) => e.identity.id),
      label: 'synthetic assignment review',
    });
    expect(
      service.query({ decisionAt: clock.now() }).events.find((e) => e.active)?.identity.claimIds,
    ).toHaveLength(7);
    expect(
      service.query({ decisionAt: clock.now() }).events.find((e) => e.active)?.replayEligible,
    ).toBe(true);
    expect(canonicalHash(service.query({ decisionAt: '2026-01-01T10:46:00Z' }))).toBe(old);
  });
  it('rejects incomplete/overlapping/future splits, inactive parents and stale graph heads', async () => {
    const { service, decide, fixture } = await setup([]),
      ids = Object.values(fixture.claimIds);
    for (const partitions of [
      [
        { label: 'one', claimIds: ids.slice(0, 1) },
        { label: 'two', claimIds: ids.slice(2) },
      ],
      [
        { label: 'one', claimIds: ids },
        { label: 'two', claimIds: [ids[0]!] },
      ],
      [
        { label: 'one', claimIds: ids },
        { label: 'two', claimIds: ['not-known'] },
      ],
    ])
      await expect(
        decide({ kind: 'SPLIT', eventId: fixture.baseId, partitions }),
      ).rejects.toThrow();
    await expect(
      decide({ kind: 'MERGE', eventIds: [fixture.baseId, fixture.baseId], label: 'duplicate' }),
    ).rejects.toThrow();
    await expect(
      decide(
        {
          kind: 'MAP_ASSET',
          subject: 'Synthetic Vault',
          eventTypes: ['SECURITY_INCIDENT'],
          symbol: 'BTC',
          relationship: 'DIRECT',
          reference: 'fixture://x',
        },
        { expectedGraphHeadHash: canonicalHash('stale') },
      ),
    ).rejects.toThrow();
    expect(service.records()).toHaveLength(0);
  });
  it('requires operator/reason and service time, serializing concurrent optimistic decisions', async () => {
    const { service, decide, clock } = await setup([]),
      action = {
        kind: 'MAP_ASSET' as const,
        subject: 'Synthetic Vault',
        eventTypes: ['SECURITY_INCIDENT' as const],
        symbol: 'BTC',
        relationship: 'DIRECT' as const,
        reference: 'fixture://review',
      };
    for (const patch of [{ operator: '' }, { reason: ' ' }, { recordedAt: clock.now() }])
      await expect(decide(action, patch)).rejects.toThrow();
    const results = await Promise.allSettled([decide(action), decide(action)]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect(service.records()[0]).toMatchObject({
      recordedAt: clock.now(),
      operator: 'synthetic:analyst',
      reason: 'Synthetic temporal metadata decision',
    });
  });
  it('excludes descriptive-only historical evidence from both downstream input interfaces', async () => {
    const f = await corpus,
      source = f.graphRecords.find((r) => r.action.kind === 'OBSERVE')!;
    if (source.action.kind !== 'OBSERVE') throw new Error('Synthetic source missing');
    const input = source.action.extraction.input,
      registry = await newsFixtureRegistry(),
      store = new NewsIngestStore({ ...registry, sources: [input.source] }),
      raw =
        '<rss version="2.0"><channel><title>Synthetic historical evidence</title><language>en</language><item><guid>synthetic-descriptive</guid><link>https://rumor.example.invalid/historical</link><title>Synthetic Vault may report a security incident for case PAST-1 involving BTC and 10 USD on 2026-01-01.</title></item></channel></rss>';
    store.ingest({
      schemaVersion: 'news-capture.v1',
      sourceId: input.source.id,
      sourceVersion: 1,
      feedUrl: input.source.feedUrl,
      origin: 'FIXTURE',
      observedAt: '2026-01-01T09:10:00Z',
      processedAt: '2026-01-01T09:10:01Z',
      availabilityEvidence: 'UNKNOWN',
      raw,
      rawHash: byteHash(raw),
      rawRetention: 'RETAINED',
    });
    const clock = new MockClock('2026-01-01T09:11:00Z'),
      article = new NewsReviewService(store, [], clock, 'synthetic.v1').articles({
        decisionAt: clock.now(),
      }).articles[0]!,
      result = await new NewsClaimExtractor(
        new DeterministicNewsClaimAdapter(),
        defaultNewsExtractionConfig(),
        clock,
        'synthetic.v1',
      ).extract({ ...input, article, dataCutoff: clock.now() }),
      records: NewsGraphRecord[] = [],
      graph = new NewsGraphService(f.graphConfig, [], clock, 'synthetic.v1', {
        append: (r) => {
          records.push(r);
          return Promise.resolve();
        },
      });
    await graph.observe(result);
    const artifact = buildNewsEventSnapshot(
      f.graphConfig,
      records,
      [],
      f.config,
      { decisionAt: clock.now(), generatedAt: clock.now() },
      'synthetic.v1',
    );
    expect(artifact.view.events).toHaveLength(1);
    expect(artifact.view.events[0]?.replayEligible).toBe(false);
    expect(newsEventResearchInputs(artifact, clock.now(), 'EVENT_STUDY').events).toHaveLength(0);
    expect(newsEventResearchInputs(artifact, clock.now(), 'NEWS_SIGNAL_INPUT').events).toHaveLength(
      0,
    );
  });
  it('supplies temporal event-study inputs and stricter non-abstaining news-engine inputs', async () => {
    const { snapshot } = await setup(),
      artifact = snapshot('2026-01-01T10:35:00Z');
    expect(newsEventResearchInputs(artifact, '2026-01-01T09:00:00Z').events).toHaveLength(0);
    expect(
      newsEventResearchInputs(artifact, '2026-01-01T09:45:00Z', 'EVENT_STUDY').events,
    ).toHaveLength(1);
    expect(
      newsEventResearchInputs(artifact, '2026-01-01T09:45:00Z', 'NEWS_SIGNAL_INPUT').events,
    ).toHaveLength(0);
    expect(
      newsEventResearchInputs(artifact, '2026-01-01T10:35:00Z', 'NEWS_SIGNAL_INPUT').events,
    ).toHaveLength(1);
    expect(() => newsEventResearchInputs(artifact, '2026-01-01T11:00:00Z')).toThrow();
  });
});
describe('immutable snapshots, prefix pinning and metadata recovery', () => {
  it('publishes immutable content-addressed artifacts and verifies reconstruction, input/config hashes and no raw bodies', async () => {
    const { fixture } = await setup(),
      out = await temporary(),
      request = { decisionAt: '2026-01-01T10:35:00Z', generatedAt: fixture.now };
    const a = await writeNewsEventSnapshot(
        fixture.graphConfig,
        fixture.graphRecords,
        fixture.metadataRecords,
        fixture.config,
        request,
        out,
        'synthetic.v1',
      ),
      b = await writeNewsEventSnapshot(
        fixture.graphConfig,
        fixture.graphRecords,
        fixture.metadataRecords,
        fixture.config,
        request,
        out,
        'synthetic.v1',
      );
    expect(a.hash).toBe(b.hash);
    expect((await verifyNewsEventSnapshot(a.path)).hash).toBe(a.hash);
    expect(a.artifact.request.graphHeadHash).toBe(a.artifact.view.graphHeadHash);
    expect(a.artifact.inputHash).toBe(canonicalHash(a.artifact.input));
    expect(JSON.stringify(a.artifact)).not.toContain('<rss');
  });
  it('excludes future graph/context/lineage records before building old snapshots', async () => {
    const { fixture, snapshot } = await setup(),
      artifact = snapshot('2026-01-01T09:45:00Z');
    expect(artifact.input.graphRecords).toHaveLength(3);
    expect(artifact.input.metadataRecords).toHaveLength(3);
    expect(artifact.view.events).toHaveLength(1);
    expect(artifact.view.events[0]?.identity.kind).toBe('BASE');
    const before = buildNewsEventSnapshot(
      fixture.graphConfig,
      fixture.graphRecords.slice(0, 3),
      fixture.metadataRecords.slice(0, 3),
      fixture.config,
      artifact.request,
      artifact.codeVersion,
    );
    expect(canonicalHash(before)).toBe(canonicalHash(artifact));
  });
  it('pins exact heads for timestamp ties and rejects metadata from a future graph prefix', async () => {
    const { fixture, snapshot } = await setup(),
      artifact = snapshot('2026-01-01T10:35:00Z');
    const previous = artifact.input.graphRecords.at(-2)!;
    const pinned = buildNewsEventSnapshot(
      fixture.graphConfig,
      fixture.graphRecords,
      fixture.metadataRecords,
      fixture.config,
      {
        decisionAt: '2026-01-01T10:35:00Z',
        generatedAt: fixture.now,
        graphHeadHash: previous.hash,
      },
      'synthetic.v1',
    );
    expect(pinned.view.events[0]?.status).toBe('DISPUTED');
    expect(() =>
      buildNewsEventSnapshot(
        fixture.graphConfig,
        fixture.graphRecords,
        fixture.metadataRecords,
        fixture.config,
        {
          decisionAt: '2026-01-01T10:46:00Z',
          generatedAt: fixture.now,
          graphHeadHash: previous.hash,
        },
        'synthetic.v1',
      ),
    ).toThrow();
    const tied = await setup(),
      action = {
        kind: 'MAP_ASSET' as const,
        subject: 'Synthetic Vault',
        eventTypes: ['SECURITY_INCIDENT' as const],
        relationship: 'SECOND_ORDER' as const,
        reference: 'fixture://tie',
      };
    const first = await tied.decide({ ...action, symbol: 'SOL' });
    await tied.decide({ ...action, symbol: 'USDC' });
    const exact = buildNewsEventSnapshot(
      fixture.graphConfig,
      fixture.graphRecords,
      tied.service.records(),
      fixture.config,
      { decisionAt: tied.clock.now(), generatedAt: tied.clock.now(), metadataHeadHash: first.hash },
      'synthetic.v1',
    );
    expect(exact.input.metadataRecords.at(-1)?.hash).toBe(first.hash);
    expect(exact.view.events.some((e) => e.assets.some((a) => a.symbol === 'SOL'))).toBe(true);
    expect(exact.view.events.some((e) => e.assets.some((a) => a.symbol === 'USDC'))).toBe(false);
  });
  it('detects forged confidence, exposure and lineage even after renaming to the new file hash', async () => {
    const { snapshot } = await setup(),
      original = snapshot('2026-01-01T10:46:00Z'),
      out = await temporary();
    for (const change of ['grade', 'asset', 'lineage']) {
      const forged = structuredClone(original);
      if (change === 'grade') forged.view.events[0]!.confidence.grade = 'MULTI_ORIGIN';
      if (change === 'asset') forged.view.events[0]!.assets[0]!.symbol = 'SOL';
      if (change === 'lineage') forged.view.events[0]!.identity.parentIds = ['invented'];
      const path = join(out, `news-event_${canonicalHash(forged).slice(7)}.json`);
      await writeFile(path, JSON.stringify(forged));
      await expect(verifyNewsEventSnapshot(path)).rejects.toThrow();
    }
  });
  it('restarts identical views and rejects conflicting owners, policy changes, corrupt or partial journals', async () => {
    const { service, journal, path, fixture, clock } = await setup(),
      before = canonicalHash(service.query({ decisionAt: clock.now() }));
    await expect(
      NewsEventJournal.acquire(path, fixture.config, fixture.graphConfig),
    ).rejects.toThrow();
    await journal.close();
    const reopened = await NewsEventJournal.acquire(path, fixture.config, fixture.graphConfig);
    journals.push(reopened);
    expect(
      canonicalHash(
        new NewsEventService(
          fixture.config,
          fixture.graphConfig,
          fixture.graphRecords,
          reopened.records,
          clock,
          'test',
        ).query({ decisionAt: clock.now() }),
      ),
    ).toBe(before);
    await reopened.close();
    await expect(
      NewsEventJournal.acquire(
        path,
        { ...fixture.config, noveltyWindowHours: 48 },
        fixture.graphConfig,
      ),
    ).rejects.toThrow();
    const file = join(path, 'events.jsonl'),
      body = await readFile(file, 'utf8');
    await writeFile(file, body.replace('synthetic:scenario', 'synthetic:tamper'));
    await expect(
      NewsEventJournal.acquire(path, fixture.config, fixture.graphConfig),
    ).rejects.toThrow();
    await writeFile(file, body.slice(0, -1));
    await expect(
      NewsEventJournal.acquire(path, fixture.config, fixture.graphConfig),
    ).rejects.toThrow();
  });
  it('rejects rehashed target or lineage-resolution forgery against original graph evidence', async () => {
    const { fixture, clock } = await setup();
    for (const field of ['targetHash', 'resolution']) {
      const records = structuredClone(fixture.metadataRecords),
        last = records.at(-1)!;
      if (field === 'targetHash') last.targetHash = canonicalHash('other-target');
      else last.resolution.children[0]!.claimIds = [];
      const { hash, ...payload } = last;
      expect(hash).toMatch(/^sha256:/);
      last.hash = canonicalHash(payload);
      expect(
        () =>
          new NewsEventService(
            fixture.config,
            fixture.graphConfig,
            fixture.graphRecords,
            records,
            clock,
            'test',
          ),
      ).toThrow();
    }
  });
  it('provides escaped offline graph provenance retaining original and child event IDs', async () => {
    const { fixture, snapshot } = await setup(),
      artifact = snapshot('2026-01-01T10:46:00Z'),
      dot = newsEventProvenanceDot(artifact);
    expect(dot).toContain('digraph provenance');
    expect(dot).toContain('LINEAGE');
    expect(dot).toContain(fixture.baseId);
    for (const id of fixture.splitIds) expect(dot).toContain(id);
    expect(() => validateNewsEventSnapshot(artifact)).not.toThrow();
  });
});
