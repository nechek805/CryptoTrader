import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalHash, MockClock, utc } from '@crypto/core';
import {
  defaultNewsGraphConfig,
  NewsGraphService,
  NewsGraphJournal,
  newsGraphFixtures,
  evidenceIndependenceScore,
  NewsClaimExtractor,
  DeterministicNewsClaimAdapter,
  defaultNewsExtractionConfig,
  newsExtractionFixtures,
} from '@crypto/news';
import type {
  NewsGraphRecord,
  NewsExtractionInput,
  NewsGraphDecisionRequestSchema,
} from '@crypto/contracts';

const corpus = newsGraphFixtures(),
  paths: string[] = [],
  journals: NewsGraphJournal[] = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'crypto-news-graph-'));
  paths.push(path);
  return path;
}
afterEach(async () => {
  for (const journal of journals.splice(0)) await journal.close();
  for (const path of paths.splice(0)) {
    if (
      dirname(resolve(path)) !== resolve(tmpdir()) ||
      !basename(path).startsWith('crypto-news-graph-')
    )
      throw new Error('Unsafe cleanup');
    await rm(path, { recursive: true, force: true });
  }
});
async function setup(ids?: string[], config = defaultNewsGraphConfig()) {
  const rows = (await corpus).filter((r) => ids === undefined || ids.includes(r.id)),
    path = await directory(),
    journal = await NewsGraphJournal.acquire(path, config);
  journals.push(journal);
  const clock = new MockClock('2026-01-01T09:00:00Z'),
    service = new NewsGraphService(config, [], clock, 'synthetic-graph-test.v1', journal);
  for (const row of rows) {
    clock.advanceTo(row.recordedAt);
    await service.observe(row.result);
  }
  const claim = (id: string) =>
    (rows.find((r) => r.id === id) ?? (null as never)).result.claims[0]!.id;
  const cluster = (id: string, at = clock.now()) => {
    const view = service.query({ decisionAt: at }),
      node = view.nodes.find((n) => n.id === claim(id))!;
    return view.clusters.find((c) => c.id === node.clusterId)!;
  };
  const decide = (
    action: ReturnType<typeof NewsGraphDecisionRequestSchema.parse>['action'],
    patch: object = {},
  ) =>
    service.decide({
      schemaVersion: 'news-graph-decision-request.v1',
      expectedHeadHash: service.headHash(),
      operator: 'synthetic:reviewer',
      reason: 'Synthetic graph review decision',
      action,
      ...patch,
    });
  return { rows, path, journal, clock, service, claim, cluster, decide };
}
async function changedResult(
  input: NewsExtractionInput,
  text: string,
  at: string,
  canonicalUrl?: string,
) {
  // Locally authored synthetic metadata; never claimed to be a public provider response.
  const value = structuredClone(input);
  value.article.version.document.title = text;
  if (canonicalUrl) value.article.version.document.canonicalUrl = canonicalUrl;
  value.article.version.contentHash = canonicalHash({ syntheticText: text });
  value.article.version.document.contentHash = value.article.version.contentHash;
  value.article.version.versionId = `synthetic-version-${canonicalHash({ text, at }).slice(7)}`;
  value.article.version.processedAt = utc(at);
  value.article.version.document.availableAt = utc(at);
  value.article.version.revision += 1;
  value.article.version.previousVersionId = input.article.version.versionId;
  value.article.effectiveAvailableAt = utc(at);
  value.dataCutoff = utc(at);
  value.article.versionHash = canonicalHash(value.article.version);
  const clock = new MockClock(at);
  return new NewsClaimExtractor(
    new DeterministicNewsClaimAdapter(),
    defaultNewsExtractionConfig(),
    clock,
    'synthetic-graph-test.v1',
  ).extract(value);
}
describe('source independence and conservative event grouping', () => {
  it('counts three wire rewrites as one origin while preserving occurrences and attributed links', async () => {
    const { cluster, service, clock } = await setup(['wire', 'copy-one', 'copy-two', 'copy-three']),
      event = cluster('wire'),
      view = service.query({ decisionAt: clock.now() });
    expect(event.claimIds).toHaveLength(4);
    expect(event.status).toBe('UNVERIFIED');
    expect(event.independence).toMatchObject({
      independentAffirmativeOrigins: 1,
      affirmativeArticleOccurrences: 4,
      valueBps: 2500,
      interpretation: 'ORIGIN_FRACTION_NOT_PROBABILITY',
    });
    expect(new Set(view.edges.map((e) => e.relationship))).toEqual(
      new Set(['WIRE_REPRINT', 'REWRITE', 'CITES', 'SAME_ORIGIN_GROUP']),
    );
    expect(new Set(view.nodes.map((n) => n.articleId)).size).toBe(4);
  });
  it('recognizes two separately asserted original reports as corroboration without changing canonical claims', async () => {
    const { cluster, rows } = await setup(['independent-one', 'independent-two']),
      event = cluster('independent-one');
    expect(event.status).toBe('CORROBORATED');
    expect(event.independence.independentAffirmativeOrigins).toBe(2);
    expect(event.independence.valueBps).toBe(10000);
    expect(
      rows.every((r) => r.result.claims.every((c) => c.canonical.verifiedStatus === 'UNVERIFIED')),
    ).toBe(true);
  });
  it('disputes affirmative/negative reports and retains a contradiction group and review item', async () => {
    const { cluster, service, clock, claim } = await setup([
        'independent-one',
        'independent-two',
        'denial',
      ]),
      event = cluster('independent-one');
    expect(event.status).toBe('DISPUTED');
    expect(event.contradictions[0]).toMatchObject({ active: true, negated: [claim('denial')] });
    expect(
      service.query({ decisionAt: clock.now() }).review.some((r) => r.category === 'CONTRADICTION'),
    ).toBe(true);
  });
  it('keeps different incident anchors and currency details separate', async () => {
    const { service, clock, cluster } = await setup([
      'independent-one',
      'distinct',
      'currency-detail',
    ]);
    expect(
      new Set(['independent-one', 'distinct', 'currency-detail'].map((id) => cluster(id).id)).size,
    ).toBe(3);
    expect(
      service
        .query({ decisionAt: clock.now() })
        .review.some((r) => r.category === 'DETAIL_CONFLICT'),
    ).toBe(true);
  });
  it('keeps unanchored matching fields provisional instead of guessing an incident merge', async () => {
    const { cluster, service, clock } = await setup([
      'independent-one',
      'independent-two',
      'unanchored',
    ]);
    expect(cluster('unanchored').identity).toBe('PROVISIONAL');
    expect(cluster('unanchored').id).not.toBe(cluster('independent-one').id);
    expect(
      service
        .query({ decisionAt: clock.now() })
        .review.some((r) => r.category === 'POSSIBLE_MATCH'),
    ).toBe(true);
  });
  it('collapses high-overlap alleged original reporting into a possible syndicated origin', async () => {
    const { cluster, service, clock } = await setup(['wire', 'inferred-copy']);
    expect(cluster('wire').independence.independentAffirmativeOrigins).toBe(1);
    expect(
      service
        .query({ decisionAt: clock.now() })
        .edges.some((e) => e.relationship === 'INFERRED_SYNDICATION'),
    ).toBe(true);
  });
  it('does not invent an official statement from a quote whose source has not yet arrived', async () => {
    const { service, cluster, clock } = await setup(['quote', 'official']);
    const before = service.query({ decisionAt: '2026-01-01T09:07:03Z' });
    expect(before.clusters[0]?.status).toBe('UNVERIFIED');
    expect(before.edges).toHaveLength(0);
    expect(before.review.some((r) => r.category === 'UNRESOLVED_ATTRIBUTION')).toBe(true);
    expect(cluster('quote').status).toBe('OFFICIALLY_STATED');
    expect(service.query({ decisionAt: clock.now() }).edges[0]?.relationship).toBe(
      'QUOTED_OFFICIAL',
    );
    expect(cluster('quote').independence.independentAffirmativeOrigins).toBe(1);
  });
  it('exposes exact attribution and primary-reporting spans relative to retained evidence fields', async () => {
    const { service, clock } = await setup(),
      view = service.query({ decisionAt: clock.now() });
    for (const edge of view.edges)
      if (edge.evidence) {
        const node = view.nodes.find((n) => n.id === edge.from)!;
        expect(node.text.slice(edge.evidence.start, edge.evidence.end)).toBe(edge.evidence.text);
      }
    for (const node of view.nodes)
      for (const evidence of [node.anchor, node.basisEvidence])
        if (evidence) expect(node.text.slice(evidence.start, evidence.end)).toBe(evidence.text);
  });
  it('never increases origin count from repeated extraction of the same article', async () => {
    const { service, clock, rows, cluster } = await setup(['wire']);
    expect((await service.observe(rows[0]!.result)).created).toBe(false);
    clock.advanceBy(1n, 'seconds');
    const next = await new NewsClaimExtractor(
      new DeterministicNewsClaimAdapter(),
      defaultNewsExtractionConfig(),
      clock,
      'synthetic.v1',
    ).extract(rows[0]!.result.input);
    await service.observe(next);
    expect(cluster('wire').independence.independentAffirmativeOrigins).toBe(1);
    expect(cluster('wire').independence.affirmativeArticleOccurrences).toBe(1);
  });
  it('enforces score input contracts and collapses shared origin metadata even without optional edges', async () => {
    const { service, clock } = await setup(['wire', 'copy-one']),
      nodes = service.query({ decisionAt: clock.now() }).nodes;
    expect(evidenceIndependenceScore(nodes, []).groups).toHaveLength(1);
    expect(() => evidenceIndependenceScore([nodes[0], nodes[0]], [])).toThrow();
    expect(() => evidenceIndependenceScore(nodes, [{ from: 'unknown' }])).toThrow();
  });
});
describe('prospective review, withdrawals and evidence timeline', () => {
  it('retains original beliefs and old decision views after the origin is retracted', async () => {
    const { service, clock, claim, cluster, decide } = await setup([
        'wire',
        'copy-one',
        'copy-two',
        'copy-three',
        'inferred-copy',
      ]),
      past = clock.now(),
      before = canonicalHash(service.query({ decisionAt: past }));
    clock.advanceBy(1n, 'seconds');
    const record = await decide({ kind: 'RETRACT', claimId: claim('wire') });
    expect(cluster('wire').status).toBe('RETRACTED');
    expect(cluster('wire').claimIds).toHaveLength(5);
    expect(cluster('wire').independence.independentAffirmativeOrigins).toBe(0);
    expect(canonicalHash(service.query({ decisionAt: past }))).toBe(before);
    expect(service.query({ decisionAt: clock.now() }).timeline.at(-1)).toMatchObject({
      kind: 'RETRACT',
      operator: 'synthetic:reviewer',
      reason: 'Synthetic graph review decision',
    });
    expect(record.recordedAt).toBe(clock.now());
    expect(
      service.query({ decisionAt: clock.now() }).nodes.find((n) => n.id === claim('wire'))
        ?.firstObservedAt,
    ).toBe(utc('2026-01-01T09:01:00Z'));
  });
  it('restores a withdrawn assertion prospectively without erasing the withdrawal interval', async () => {
    const { clock, claim, cluster, decide } = await setup(['wire']);
    clock.advanceBy(1n, 'seconds');
    await decide({ kind: 'RETRACT', claimId: claim('wire') });
    const withdrawn = clock.now();
    clock.advanceBy(1n, 'seconds');
    await decide({ kind: 'RESTORE', claimId: claim('wire') });
    expect(cluster('wire').status).toBe('UNVERIFIED');
    expect(cluster('wire', withdrawn).status).toBe('RETRACTED');
  });
  it('keeps a withdrawn denial in contradiction history while allowing later corroboration', async () => {
    const { clock, claim, cluster, decide } = await setup([
      'independent-one',
      'independent-two',
      'denial',
    ]);
    const disputed = clock.now();
    clock.advanceBy(1n, 'seconds');
    await decide({ kind: 'RETRACT', claimId: claim('denial') });
    expect(cluster('independent-one').status).toBe('CORROBORATED');
    expect(cluster('independent-one').contradictions[0]?.active).toBe(false);
    expect(cluster('independent-one', disputed).status).toBe('DISPUTED');
  });
  it('acknowledges review without changing independence or asserting truth', async () => {
    const { service, clock, cluster, decide } = await setup(['wire', 'inferred-copy']),
      before = cluster('wire').independence,
      item = service
        .query({ decisionAt: clock.now() })
        .review.find((r) => r.category === 'INFERRED_SYNDICATION')!;
    clock.advanceBy(1n, 'seconds');
    await decide({ kind: 'ACKNOWLEDGE', reviewId: item.id });
    expect(
      service.query({ decisionAt: clock.now() }).review.find((r) => r.id === item.id)?.status,
    ).toBe('ACKNOWLEDGED');
    expect(cluster('wire').independence).toEqual(before);
    expect(cluster('wire').status).toBe('UNVERIFIED');
  });
  it('adds an operator dependency prospectively and rejects cycles or cross-event links', async () => {
    const { service, clock, claim, cluster, decide } = await setup([
        'independent-one',
        'independent-two',
        'distinct',
      ]),
      past = clock.now();
    clock.advanceBy(1n, 'seconds');
    await decide({
      kind: 'LINK',
      from: claim('independent-two'),
      to: claim('independent-one'),
      relationship: 'ATTRIBUTION',
    });
    expect(cluster('independent-one').independence.independentAffirmativeOrigins).toBe(1);
    expect(cluster('independent-one', past).status).toBe('CORROBORATED');
    await expect(
      decide({
        kind: 'LINK',
        from: claim('independent-one'),
        to: claim('independent-two'),
        relationship: 'CITES',
      }),
    ).rejects.toThrow();
    await expect(
      decide({
        kind: 'LINK',
        from: claim('distinct'),
        to: claim('independent-one'),
        relationship: 'REWRITE',
      }),
    ).rejects.toThrow();
    expect(service.records()).toHaveLength(4);
  });
  it('requires operator/reason/head and refuses client-supplied time or unknown targets', async () => {
    const { service, clock, claim, decide } = await setup(['wire']);
    for (const patch of [
      { operator: '' },
      { reason: ' ' },
      { recordedAt: clock.now() },
      { expectedHeadHash: canonicalHash('stale') },
    ])
      await expect(decide({ kind: 'RETRACT', claimId: claim('wire') }, patch)).rejects.toThrow();
    await expect(decide({ kind: 'RETRACT', claimId: 'unknown' })).rejects.toThrow();
    expect(service.records()).toHaveLength(1);
  });
  it('serializes concurrent decisions and rejects a stale losing head', async () => {
    const { service, claim, decide } = await setup(['wire']);
    const result = await Promise.allSettled([
      decide({ kind: 'RETRACT', claimId: claim('wire') }),
      decide({ kind: 'RESTORE', claimId: claim('wire') }),
    ]);
    expect(result.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect(service.records()).toHaveLength(2);
  });
});
describe('graph boundaries, recovery and conservative failures', () => {
  it('rejects immutable source and article-version metadata equivocation before journal publication', async () => {
    const { service, clock, rows } = await setup(['wire']);
    clock.advanceBy(1n, 'seconds');
    const altered = structuredClone(rows[0]!.result.input);
    altered.source.owner = 'Synthetic conflicting owner';
    altered.article.version.sourceHash = canonicalHash(altered.source);
    altered.article.versionHash = canonicalHash(altered.article.version);
    const extractor = new NewsClaimExtractor(
      new DeterministicNewsClaimAdapter(),
      defaultNewsExtractionConfig(),
      clock,
      'synthetic.v1',
    );
    await expect(service.observe(await extractor.extract(altered))).rejects.toThrow();
    expect(service.records()).toHaveLength(1);
  });
  it('keeps incoming evidence unknown before graph receipt and rejects future queries/observations', async () => {
    const { service, clock, rows } = await setup(['wire']);
    expect(service.query({ decisionAt: '2026-01-01T09:01:02Z' }).nodes).toHaveLength(0);
    expect(() => service.query({ decisionAt: '2027-01-01T00:00:00Z' })).toThrow();
    const future = await changedResult(
      rows[0]!.result.input,
      rows[0]!.result.input.article.version.document.title,
      '2026-01-01T10:00:00Z',
    );
    await expect(service.observe(future)).rejects.toThrow();
    expect(service.query({ decisionAt: clock.now() }).nodes).toHaveLength(1);
  });
  it('restarts with identical views, exclusive ownership and immutable policy binding', async () => {
    const { service, journal, path, clock, claim, decide } = await setup(['wire']);
    await decide({ kind: 'RETRACT', claimId: claim('wire') });
    const before = canonicalHash(service.query({ decisionAt: clock.now() }));
    await expect(NewsGraphJournal.acquire(path, defaultNewsGraphConfig())).rejects.toThrow();
    await journal.close();
    const reopened = await NewsGraphJournal.acquire(path, defaultNewsGraphConfig());
    journals.push(reopened);
    expect(
      canonicalHash(
        new NewsGraphService(
          defaultNewsGraphConfig(),
          reopened.records,
          clock,
          'synthetic-graph-test.v1',
        ).query({ decisionAt: clock.now() }),
      ),
    ).toBe(before);
    await reopened.close();
    await expect(
      NewsGraphJournal.acquire(path, {
        ...defaultNewsGraphConfig(),
        nearDuplicateThresholdBps: 9000,
      }),
    ).rejects.toThrow();
  });
  it('rejects journal tampering and incomplete writes without repairing evidence', async () => {
    const { journal, path } = await setup(['wire']);
    await journal.close();
    const file = join(path, 'graph.jsonl'),
      raw = await readFile(file, 'utf8');
    await writeFile(file, raw.replace('synthetic-graph-test.v1', 'tampered.v1'));
    await expect(NewsGraphJournal.acquire(path, defaultNewsGraphConfig())).rejects.toThrow();
    await writeFile(file, raw.slice(0, -1));
    await expect(NewsGraphJournal.acquire(path, defaultNewsGraphConfig())).rejects.toThrow();
  });
  it('rejects rehashed reviews targeting different evidence or forged pre-observation times', async () => {
    const { service, clock, claim, decide } = await setup(['wire']);
    await decide({ kind: 'RETRACT', claimId: claim('wire') });
    const records = structuredClone(service.records()) as NewsGraphRecord[],
      last = records.at(-1)!;
    if (last.action.kind === 'REVIEW') last.action.targetHash = canonicalHash('wrong-target');
    const { hash, ...payload } = last;
    expect(hash).toMatch(/^sha256:/);
    last.hash = canonicalHash(payload);
    expect(() => new NewsGraphService(defaultNewsGraphConfig(), records, clock, 'test')).toThrow();
  });
  it('does not poison a journal when an extraction exceeds the configured node budget', async () => {
    const { service, clock } = await setup(['wire'], { ...defaultNewsGraphConfig(), maxNodes: 1 });
    const extra = (await corpus).find((r) => r.id === 'copy-one')!;
    clock.advanceTo(extra.recordedAt);
    await expect(service.observe(extra.result)).rejects.toThrow();
    expect(service.records()).toHaveLength(1);
  });
  it('retains separate extraction failures in review without manufacturing nodes', async () => {
    const { service, clock } = await setup([]),
      fixtures = await newsExtractionFixtures();
    clock.advanceTo('2026-01-01T09:30:00Z');
    for (const id of ['injection', 'unsupported', 'empty-evidence']) {
      const row = fixtures.find((r) => r.id === id)!,
        extractor = new NewsClaimExtractor(
          new DeterministicNewsClaimAdapter(),
          defaultNewsExtractionConfig(),
          clock,
          'synthetic.v1',
        );
      await service.observe(await extractor.extract(row.input));
    }
    const view = service.query({ decisionAt: clock.now() });
    expect(view.nodes).toHaveLength(0);
    expect(view.review).toHaveLength(3);
  });
  it('quarantines circular source attribution rather than creating independent evidence', async () => {
    const { service, clock, rows } = await setup(['independent-one', 'independent-two']);
    const a = rows[0]!.result.input,
      b = rows[1]!.result.input;
    clock.advanceBy(1n, 'seconds');
    const first = await changedResult(
      a,
      `Synthetic Vault independently reported a security incident for case CYCLE-1 involving BTC and 10 USD on 2026-01-04; cites ${b.article.version.document.canonicalUrl}`,
      clock.now(),
    );
    await service.observe(first);
    clock.advanceBy(1n, 'seconds');
    const second = await changedResult(
      b,
      `Synthetic Vault observed first-hand a security incident for case CYCLE-1 involving BTC and 10 USD on 2026-01-04; cites ${a.article.version.document.canonicalUrl}`,
      clock.now(),
    );
    await service.observe(second);
    const view = service.query({ decisionAt: clock.now() }),
      node = view.nodes.find((n) => n.id === first.claims[0]!.id)!;
    expect(
      view.clusters.find((c) => c.id === node.clusterId)?.independence
        .independentAffirmativeOrigins,
    ).toBe(0);
    expect(view.review.some((r) => r.category === 'CIRCULAR_ATTRIBUTION')).toBe(true);
  });
  it('detects contradictory assertions even when original reporting basis is unknown', async () => {
    const { service, clock, rows } = await setup(['independent-one', 'independent-two']);
    for (const [index, negative] of [false, true].entries()) {
      clock.advanceBy(1n, 'seconds');
      const result = await changedResult(
        rows[index]!.result.input,
        `Synthetic Vault ${negative ? 'did not report' : 'reported'} a security incident for case UNKNOWN-1 involving BTC and 10 USD on 2026-01-05.`,
        clock.now(),
      );
      await service.observe(result);
    }
    expect(
      service.query({ decisionAt: clock.now() }).clusters.some((c) => c.status === 'DISPUTED'),
    ).toBe(true);
  });
});
