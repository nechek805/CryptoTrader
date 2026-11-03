import { lstat, readFile } from 'node:fs/promises';
import { z } from 'zod';
import {
  NewsCaptureSchema,
  NewsRegistrySchema,
  NewsSourceSchema,
  UtcTimestampSchema,
} from '@crypto/contracts';
import type { NewsCapture, NewsSource } from '@crypto/contracts';
import { byteHash } from './market-common.js';
import { NewsIngestError } from './news-policy.js';

export interface NewsProvider {
  readonly id: string;
  read(input: { fixtureId?: string; source: NewsSource }): Promise<NewsCapture>;
}
const root = new URL('../../../tests/fixtures/news/', import.meta.url);
const ManifestSchema = z.strictObject({
  schemaVersion: z.literal('news-fixture-list.v1'),
  captures: z
    .array(
      z.strictObject({
        id: z.string().regex(/^[a-z0-9-]+$/),
        file: z.string().regex(/^[a-z0-9-]+\.(?:xml|json)$/),
        sourceId: z.string().min(1),
        sourceVersion: z.number().int().positive(),
        observedAt: UtcTimestampSchema,
        processedAt: UtcTimestampSchema,
        availabilityEvidence: z.enum(['OBSERVED', 'ARCHIVED_CAPTURE', 'UNKNOWN']),
      }),
    )
    .max(30),
});
async function readFixture(name: string) {
  const path = new URL(name, root),
    info = await lstat(path);
  if (!info.isFile() || info.size > 262144) throw new NewsIngestError('LIMIT');
  const bytes = await readFile(path);
  if (bytes.length > 262144) throw new NewsIngestError('LIMIT');
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}
export async function newsFixtureRegistry() {
  return NewsRegistrySchema.parse(JSON.parse(await readFixture('registry.json')));
}
export class FixtureNewsProvider implements NewsProvider {
  readonly id = 'fixture-news';
  async list() {
    return ManifestSchema.parse(JSON.parse(await readFixture('captures.json'))).captures;
  }
  async read(input: { fixtureId?: string; source: NewsSource }): Promise<NewsCapture> {
    const request = z
      .strictObject({ fixtureId: z.string().min(1).max(100), source: NewsSourceSchema })
      .parse(input);
    const row = (await this.list()).find((v) => v.id === request.fixtureId),
      source = request.source;
    if (
      !row ||
      row.sourceId !== source.id ||
      row.sourceVersion !== source.version ||
      source.providerId !== this.id ||
      source.accessMethod !== 'FIXTURE'
    )
      throw new NewsIngestError('REGISTRY');
    const raw = await readFixture(row.file);
    return NewsCaptureSchema.parse({
      schemaVersion: 'news-capture.v1',
      sourceId: source.id,
      sourceVersion: source.version,
      feedUrl: source.feedUrl,
      origin: 'FIXTURE',
      observedAt: row.observedAt,
      processedAt: row.processedAt,
      availabilityEvidence: row.availabilityEvidence,
      raw,
      rawHash: byteHash(raw),
      rawRetention: 'RETAINED',
    });
  }
}
