import type { LiveNewsSource } from '../../contracts/src/live-news.js';
import { liveNewsHash, newsPlainText } from './live-news-feed.js';
import type { LiveFeedItem } from './live-news-feed.js';

/** Only the MIT-licensed XRPL blog index; never executes JS or fetches article bodies. */
export function parseXrplBlog(bytes: Buffer, source: LiveNewsSource) {
  if (
    source.adapter !== 'XRPL_BLOG' ||
    source.feedUrl !== 'https://xrpl.org/blog' ||
    source.articleOrigins.length !== 1 ||
    source.articleOrigins[0] !== 'https://xrpl.org'
  )
    throw new Error('XRPL_SOURCE_POLICY');
  if (bytes.length > 2097152) throw new Error('FEED_SIZE');
  const html = new TextDecoder('utf-8', { fatal: true })
    .decode(bytes)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  const items = new Map<string, LiveFeedItem>();
  let headings = 0,
    rejected = 0;
  for (const heading of html.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi)) {
    if (++headings > 1000) throw new Error('FEED_ITEM_LIMIT');
    for (const anchor of heading[2]!.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
      const href = /\bhref\s*=\s*(["'])(.*?)\1/i.exec(anchor[1]!)?.[2];
      if (!href) continue;
      try {
        const url = new URL(href.replaceAll('&amp;', '&'), 'https://xrpl.org');
        if (
          url.origin !== 'https://xrpl.org' ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          !/^\/blog\/\d{4}\/[a-zA-Z0-9_-]+\/?$/.test(url.pathname)
        )
          continue;
        const title = newsPlainText(anchor[2]!, 500);
        if (!title) throw new Error('TITLE');
        items.set(url.href, {
          providerItemId: url.href,
          url: url.href,
          title,
          excerpt: '',
          language: source.language,
          // Listing dates have no timezone or time of day. Do not invent an instant.
          publishedAt: null,
          publisherUpdatedAt: null,
          timestampStatus: 'MISSING',
        });
      } catch {
        rejected++;
      }
    }
  }
  // A layout change is an operator-visible error, not a successful empty news feed.
  if (!items.size) throw new Error('XRPL_LISTING_FORMAT');
  return { items: [...items.values()], rejected, feedHash: liveNewsHash(bytes) };
}
