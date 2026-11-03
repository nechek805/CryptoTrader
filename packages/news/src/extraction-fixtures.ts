import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { NewsExtractionInputSchema } from '@crypto/contracts';
import { newsFixtureRegistry, byteHash } from '@crypto/connectors';
import { NewsIngestStore } from './store.js';
import { NewsReviewService } from './review.js';
import { utc } from '@crypto/core';

/** Purely synthetic evidence, including adversarial instruction-like text, never external stories. */
export async function newsExtractionFixtures() {
  const fixture = z
    .strictObject({
      schemaVersion: z.literal('synthetic-news-extraction-cases.v1'),
      cases: z
        .array(
          z.strictObject({
            id: z.string().regex(/^[a-z-]+$/),
            language: z.enum(['en', 'ru', 'es']),
            text: z.string().min(1).max(500),
          }),
        )
        .min(1)
        .max(100),
    })
    .parse(
      JSON.parse(
        await readFile(
          new URL('../../../tests/fixtures/news/extraction-cases.json', import.meta.url),
          'utf8',
        ),
      ),
    );
  const registry = await newsFixtureRegistry();
  registry.sources = registry.sources.map((s) =>
    s.id === 'fixture:official' ? { ...s, languages: ['en', 'ru', 'es'] } : s,
  );
  const store = new NewsIngestStore(registry),
    source = store.registry.source('fixture:official', utc('2026-01-01T00:01:00Z')),
    xml = (v: string) => v.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  for (const item of fixture.cases) {
    const raw = `<rss version="2.0"><channel><title>Synthetic extraction fixtures</title><language>${item.language}</language><item><guid>synthetic-extraction-${item.id}</guid><link>https://official.example.invalid/extraction/${item.id}</link><title>${xml(item.text)}</title><description>${xml(item.text)}</description></item></channel></rss>`;
    store.ingest({
      schemaVersion: 'news-capture.v1',
      sourceId: source.id,
      sourceVersion: source.version,
      feedUrl: source.feedUrl,
      origin: 'FIXTURE',
      observedAt: '2026-01-01T00:01:00Z',
      processedAt: '2026-01-01T00:01:01Z',
      availabilityEvidence: 'OBSERVED',
      raw,
      rawHash: byteHash(raw),
      rawRetention: 'RETAINED',
    });
  }
  const dataCutoff = utc('2026-01-01T00:02:00Z'),
    review = new NewsReviewService(
      store,
      [],
      { now: () => dataCutoff },
      'synthetic-extraction-fixtures.v1',
    );
  return review.articles({ decisionAt: dataCutoff }).articles.map((article) => ({
    id: article.version.providerItemId.replace('synthetic-extraction-', ''),
    input: NewsExtractionInputSchema.parse({
      schemaVersion: 'news-extraction-input.v1',
      source,
      article,
      field: 'TITLE',
      dataCutoff,
    }),
  }));
}
