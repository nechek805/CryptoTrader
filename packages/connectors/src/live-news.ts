import { NewsCaptureSchema, NewsSourceSchema } from '@crypto/contracts';
import type { NewsCapture, NewsSource } from '@crypto/contracts';
import { byteHash } from './market-common.js';
import { readNewsHttps } from './news-http.js';
import { NewsIngestError } from './news-policy.js';
import { utc } from '@crypto/core';

export const newsWallTime = () => utc(new Date().toISOString());
export interface LiveNewsReader {
  read(source: NewsSource, signal?: AbortSignal): Promise<NewsCapture>;
}
/** RSS/Atom and optional aggregation share transport while keeping distinct source identities. */
export class PublicNewsProvider implements LiveNewsReader {
  constructor(
    private readonly readBytes: typeof readNewsHttps = readNewsHttps,
    private readonly now = newsWallTime,
  ) {}
  async read(input: NewsSource, signal?: AbortSignal) {
    const source = NewsSourceSchema.parse(input);
    if (source.accessMethod !== 'PUBLIC_HTTPS' || !source.licensing.approvedForLive)
      throw new NewsIngestError('POLICY');
    const bytes = await this.readBytes(source, signal),
      observedAt = this.now();
    let raw: string;
    try {
      raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new NewsIngestError('FORMAT');
    }
    return NewsCaptureSchema.parse({
      schemaVersion: 'news-capture.v1',
      sourceId: source.id,
      sourceVersion: source.version,
      feedUrl: source.feedUrl,
      origin: 'PUBLIC_READ_ONLY',
      observedAt,
      processedAt: observedAt,
      availabilityEvidence: 'OBSERVED',
      raw,
      rawHash: byteHash(raw),
      rawRetention: 'RETAINED',
    });
  }
}
