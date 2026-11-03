import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { NewsCaptureSchema, UtcTimestampSchema } from '@crypto/contracts';
import { FixtureNewsProvider, newsFixtureRegistry } from './fixture-news.js';
import { byteHash } from './market-common.js';
import { parseLiveNewsCapture, parseNewsCapture } from './news-parser.js';

/** Additional locally authored synthetic temporal cases; original fixture ledger is unchanged. */
export async function newsReviewFixtureCaptures() {
  const manifest = z
    .strictObject({
      schemaVersion: z.literal('synthetic-news-review-cases.v1'),
      cases: z
        .array(
          z.strictObject({
            id: z.string().regex(/^[a-z]+$/),
            observedAt: UtcTimestampSchema,
            processedAt: UtcTimestampSchema,
            availabilityEvidence: z.enum(['OBSERVED', 'ARCHIVED_CAPTURE', 'UNKNOWN']),
            published: z.string().min(1).max(100),
            liveParser: z.boolean(),
          }),
        )
        .min(1)
        .max(10),
    })
    .parse(
      JSON.parse(
        await readFile(
          new URL('../../../tests/fixtures/news/review-cases.json', import.meta.url),
          'utf8',
        ),
      ),
    );
  const registry = await newsFixtureRegistry(),
    source = registry.sources.find((s) => s.id === 'fixture:official')!,
    original = await new FixtureNewsProvider().read({ fixtureId: 'official-v1', source });
  return manifest.cases.map((item) => {
    const raw = original.raw
      .replaceAll('security-1', `synthetic-review-${item.id}`)
      .replaceAll('/notices/1', `/notices/synthetic-${item.id}`)
      .replace('Synthetic security maintenance scheduled', `Synthetic review ${item.id} article`)
      .replace(/<pubDate>[^<]+<\/pubDate>/, `<pubDate>${item.published}</pubDate>`);
    const capture = NewsCaptureSchema.parse({
      ...original,
      raw,
      rawHash: byteHash(raw),
      observedAt: item.observedAt,
      processedAt: item.processedAt,
      availabilityEvidence: item.availabilityEvidence,
    });
    return {
      capture,
      parsed: item.liveParser
        ? parseLiveNewsCapture(source, capture)
        : parseNewsCapture(source, capture),
    };
  });
}
