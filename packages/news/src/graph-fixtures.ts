import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { NewsSourceSchema } from '@crypto/contracts';
import { MockClock, utc } from '@crypto/core';
import { byteHash, newsFixtureRegistry } from '@crypto/connectors';
import { NewsIngestStore } from './store.js';
import { NewsReviewService } from './review.js';
import {
  NewsClaimExtractor,
  DeterministicNewsClaimAdapter,
  defaultNewsExtractionConfig,
} from './extractor.js';

export async function newsGraphFixtures() {
  const fixture = z
    .strictObject({
      schemaVersion: z.literal('synthetic-news-graph-cases.v1'),
      cases: z
        .array(
          z.strictObject({
            id: z.string().regex(/^[a-z-]+$/),
            source: z.string().regex(/^[a-z-]+$/),
            publicationType: NewsSourceSchema.shape.publicationType,
            group: z.string().min(1),
            minute: z.number().int().min(1).max(59),
            path: z.string().regex(/^[a-z-]+$/),
            text: z.string().min(1).max(500),
          }),
        )
        .max(100),
    })
    .parse(
      JSON.parse(
        await readFile(
          new URL('../../../tests/fixtures/news/graph-cases.json', import.meta.url),
          'utf8',
        ),
      ),
    );
  const registry = await newsFixtureRegistry(),
    template = registry.sources[0]!,
    sources = [
      ...new Map(
        fixture.cases.map((c) => [
          c.source,
          {
            ...template,
            id: `fixture:graph:${c.source}`,
            owner: `Synthetic ${c.source}`,
            providerId: 'fixture-news',
            publicationType: c.publicationType,
            independenceGroup: c.group,
            feedUrl: `https://${c.source}.example.invalid/feed.xml`,
            articleOrigins: [`https://${c.source}.example.invalid`],
            format: 'RSS2',
            languages: ['en'],
            licensing: {
              ...template.licensing,
              policy: 'SYNTHETIC',
              permitsSnippet: true,
              maxSnippetChars: 500,
              permitsRawStorage: true,
              approvedForLive: false,
            },
            allowedFields: [
              'id',
              'url',
              'title',
              'language',
              'publishedAt',
              'updatedAt',
              'snippet',
            ],
          },
        ]),
      ).values(),
    ],
    store = new NewsIngestStore({ ...registry, sources }),
    clock = new MockClock('2026-01-01T09:00:00Z'),
    extractor = new NewsClaimExtractor(
      new DeterministicNewsClaimAdapter(),
      defaultNewsExtractionConfig(),
      clock,
      'synthetic-news-graph.v1',
    ),
    escape = (s: string) =>
      s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const rows = [];
  for (const item of fixture.cases) {
    const at = `2026-01-01T09:${String(item.minute).padStart(2, '0')}:00Z`,
      processedAt = at.replace(':00Z', ':01Z'),
      source = store.registry.source(`fixture:graph:${item.source}`, utc(at)),
      raw = `<rss version="2.0"><channel><title>Synthetic graph evidence</title><language>en</language><item><guid>synthetic-graph-${item.id}</guid><link>https://${item.source}.example.invalid/articles/${item.path}</link><title>${escape(item.text)}</title></item></channel></rss>`;
    store.ingest({
      schemaVersion: 'news-capture.v1',
      sourceId: source.id,
      sourceVersion: source.version,
      feedUrl: source.feedUrl,
      origin: 'FIXTURE',
      observedAt: at,
      processedAt,
      availabilityEvidence: 'OBSERVED',
      raw,
      rawHash: byteHash(raw),
      rawRetention: 'RETAINED',
    });
    clock.advanceTo(processedAt);
    const review = new NewsReviewService(store, [], clock, 'synthetic-news-graph.v1'),
      article = review
        .articles({ decisionAt: clock.now() })
        .articles.find((v) => v.version.providerItemId === `synthetic-graph-${item.id}`)!;
    clock.advanceBy(1n, 'seconds');
    const result = await extractor.extract({
      schemaVersion: 'news-extraction-input.v1',
      article,
      source,
      field: 'TITLE',
      dataCutoff: processedAt,
    });
    rows.push({ id: item.id, result, recordedAt: utc(at.replace(':00Z', ':03Z')) });
  }
  return rows;
}
