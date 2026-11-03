import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { NewsSourceSchema, UtcTimestampSchema, DecimalStringSchema } from '@crypto/contracts';
import type { NewsEventRecord, NewsGraphRecord } from '@crypto/contracts';
import { MockClock, utc, fromEpoch, toEpoch } from '@crypto/core';
import { newsFixtureRegistry, byteHash } from '@crypto/connectors';
import { NewsIngestStore } from './store.js';
import { NewsReviewService } from './review.js';
import {
  NewsClaimExtractor,
  DeterministicNewsClaimAdapter,
  defaultNewsExtractionConfig,
} from './extractor.js';
import { NewsGraphService } from './graph.js';
import { defaultNewsGraphConfig } from './graph-projection.js';
import { NewsEventService } from './events.js';
import { defaultNewsEventConfig } from './event-projection.js';

/** Entire scenario and clock are synthetic. No external data or model is requested. */
export async function newsTemporalEventFixtures() {
  const fixture = z
    .strictObject({
      schemaVersion: z.literal('synthetic-news-temporal-cases.v1'),
      cases: z
        .array(
          z.strictObject({
            id: z.string().regex(/^[a-z-]+$/),
            publicationType: NewsSourceSchema.shape.publicationType,
            at: UtcTimestampSchema,
            publishedAt: UtcTimestampSchema,
            text: z.string().min(1).max(500),
          }),
        )
        .max(20),
    })
    .parse(
      JSON.parse(
        await readFile(
          new URL('../../../tests/fixtures/news/temporal-cases.json', import.meta.url),
          'utf8',
        ),
      ),
    );
  const registry = await newsFixtureRegistry(),
    template = registry.sources[0]!,
    sources = fixture.cases.map((c) => ({
      ...template,
      id: `fixture:temporal:${c.id}`,
      owner: `Synthetic ${c.id}`,
      providerId: 'fixture-news',
      publicationType: c.publicationType,
      independenceGroup: `synthetic:temporal:${c.id}`,
      feedUrl: `https://${c.id}.example.invalid/feed.xml`,
      articleOrigins: [`https://${c.id}.example.invalid`],
      format: 'RSS2',
      languages: ['en'],
    })),
    store = new NewsIngestStore({ ...registry, sources }),
    clock = new MockClock('2026-01-01T08:00:00Z'),
    graphConfig = defaultNewsGraphConfig(),
    config = defaultNewsEventConfig(),
    graphRecords: NewsGraphRecord[] = [],
    metadataRecords: NewsEventRecord[] = [],
    graph = new NewsGraphService(graphConfig, [], clock, 'synthetic-temporal-fixture.v1', {
      append: (r) => {
        graphRecords.push(r);
        return Promise.resolve();
      },
    }),
    metadata = () =>
      new NewsEventService(
        config,
        graphConfig,
        graphRecords,
        metadataRecords,
        clock,
        'synthetic-temporal-fixture.v1',
        {
          append: (r) => {
            metadataRecords.push(r);
            return Promise.resolve();
          },
        },
      ),
    decide = async (action: NewsEventRecord['action'], reason: string) => {
      const service = metadata();
      return service.decide({
        schemaVersion: 'news-event-decision.v1',
        expectedGraphHeadHash: service.graphHeadHash(),
        expectedHeadHash: service.headHash(),
        operator: 'synthetic:scenario',
        reason,
        action,
      });
    },
    extractor = new NewsClaimExtractor(
      new DeterministicNewsClaimAdapter(),
      defaultNewsExtractionConfig(),
      clock,
      'synthetic-temporal-fixture.v1',
    ),
    escape = (s: string) =>
      s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
    claims = new Map<string, string>();
  await decide(
    {
      kind: 'MAP_ASSET',
      subject: 'Synthetic Vault',
      eventTypes: ['SECURITY_INCIDENT'],
      symbol: 'BTC',
      relationship: 'DIRECT',
      reference: 'fixture://synthetic-direct-exposure',
    },
    'Synthetic direct exposure declaration.',
  );
  clock.advanceBy(1n, 'seconds');
  await decide(
    {
      kind: 'MAP_ASSET',
      subject: 'Synthetic Vault',
      eventTypes: ['SECURITY_INCIDENT'],
      symbol: 'ETH',
      relationship: 'SECOND_ORDER',
      reference: 'fixture://synthetic-counterparty',
    },
    'Synthetic counterparty exposure declaration; not real market data.',
  );
  clock.advanceBy(1n, 'seconds');
  await decide(
    {
      kind: 'EXPECT',
      anchorKey: 'timed-1',
      subject: 'Synthetic Vault',
      eventType: 'SECURITY_INCIDENT',
      amounts: [{ value: DecimalStringSchema.parse('10'), unit: 'USD' }],
      reference: 'fixture://synthetic-prior-expectation',
    },
    'Synthetic scheduled-value expectation, recorded before first article receipt.',
  );
  const observe = async (item: (typeof fixture.cases)[number]) => {
    clock.advanceTo(item.at);
    const processedAt = fromEpoch(toEpoch(item.at, 'nanoseconds') + 1000000000n, 'nanoseconds'),
      source = store.registry.source(`fixture:temporal:${item.id}`, item.at),
      raw = `<rss version="2.0"><channel><title>Synthetic temporal event</title><language>en</language><item><guid>synthetic-temporal-${item.id}</guid><link>https://${item.id}.example.invalid/timed</link><title>${escape(item.text)}</title><pubDate>${item.publishedAt}</pubDate></item></channel></rss>`;
    store.ingest({
      schemaVersion: 'news-capture.v1',
      sourceId: source.id,
      sourceVersion: source.version,
      feedUrl: source.feedUrl,
      origin: 'FIXTURE',
      observedAt: item.at,
      processedAt,
      availabilityEvidence: 'OBSERVED',
      raw,
      rawHash: byteHash(raw),
      rawRetention: 'RETAINED',
    });
    clock.advanceTo(processedAt);
    const article = new NewsReviewService(store, [], clock, 'synthetic-temporal-fixture.v1')
      .articles({ decisionAt: clock.now() })
      .articles.find((a) => a.version.providerItemId === `synthetic-temporal-${item.id}`)!;
    clock.advanceBy(1n, 'seconds');
    const result = await extractor.extract({
      schemaVersion: 'news-extraction-input.v1',
      source,
      article,
      field: 'TITLE',
      dataCutoff: processedAt,
    });
    claims.set(item.id, result.claims[0]!.id);
    clock.advanceBy(1n, 'seconds');
    await graph.observe(result);
  };
  for (const item of fixture.cases.filter((c) => c.id !== 'late-report')) await observe(item);
  clock.advanceTo('2026-01-01T10:30:00Z');
  await graph.decide({
    schemaVersion: 'news-graph-decision-request.v1',
    expectedHeadHash: graph.headHash(),
    operator: 'synthetic:scenario',
    reason: 'Synthetic denial withdrawn; retain dispute interval.',
    action: { kind: 'RETRACT', claimId: claims.get('denial')! },
  });
  clock.advanceTo('2026-01-01T10:40:00Z');
  await graph.decide({
    schemaVersion: 'news-graph-decision-request.v1',
    expectedHeadHash: graph.headHash(),
    operator: 'synthetic:scenario',
    reason: 'Synthetic earlier reporter correction.',
    action: { kind: 'RETRACT', claimId: claims.get('first-report')! },
  });
  const baseId = metadata().query({ decisionAt: clock.now() }).events[0]!.identity.id;
  clock.advanceTo('2026-01-01T10:45:00Z');
  const split = await decide(
    {
      kind: 'SPLIT',
      eventId: baseId,
      partitions: [
        {
          label: 'early reports',
          claimIds: ['rumor', 'repost', 'first-report'].map((id) => claims.get(id)!),
        },
        {
          label: 'later reports',
          claimIds: ['confirmation', 'official', 'denial'].map((id) => claims.get(id)!),
        },
      ],
    },
    'Synthetic curator partition; retain original event identity.',
  );
  clock.advanceTo('2026-01-01T10:46:00Z');
  await decide(
    {
      kind: 'MERGE',
      eventIds: split.resolution.children.map((c) => c.id),
      label: 'reviewed reports',
    },
    'Synthetic recombination; retain both split IDs and original parent.',
  );
  await observe(fixture.cases.find((c) => c.id === 'late-report')!);
  return {
    config,
    graphConfig,
    graphRecords,
    metadataRecords,
    claimIds: Object.fromEntries(claims),
    baseId,
    splitIds: split.resolution.children.map((c) => c.id),
    now: utc('2026-01-01T11:01:00Z'),
  };
}
