import sax from 'sax';
import { createHash } from 'node:crypto';
import type { LiveNewsSource } from '../../contracts/src/live-news.js';
import { newsHttpsUrl } from './news-policy.js';
import { canonicalNewsUrl } from '../../news/src/dedup.js';

export type LiveFeedItem = {
  providerItemId: string;
  url: string;
  title: string;
  excerpt: string;
  language: string;
  publishedAt: number | null;
  publisherUpdatedAt: number | null;
  timestampStatus: 'VALID' | 'MISSING' | 'UNCERTAIN';
};
export const liveNewsHash = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
/** Helius publishes a large full-content Atom feed. Its body stays transient. */
export const liveFeedByteLimit = (source: LiveNewsSource) =>
  source.adapter === 'RSS_ATOM' && source.feedUrl === 'https://www.helius.dev/blog/rss.xml'
    ? 8388608
    : 2097152;
export function newsPlainText(value: string, limit: number) {
  return (
    value
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(
        /&(?:amp|lt|gt|quot|apos|nbsp);/g,
        (s) =>
          ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ' })[
            s
          ] ?? s,
      )
      // Drop non-whitespace control characters before rendering publisher text.
      .split('')
      .filter(
        (c) => (c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127) || ['\t', '\n', '\r'].includes(c),
      )
      .join('')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, limit)
  );
}
/** Bounded RSS/Atom metadata parser. Feed bodies never enter the database. */
export function parseLiveFeed(bytes: Buffer, source: LiveNewsSource, now = Date.now()) {
  if (bytes.length > liveFeedByteLimit(source)) throw new Error('FEED_SIZE');
  const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (/<!\s*(DOCTYPE|ENTITY)/i.test(raw)) throw new Error('FEED_XML_POLICY');
  const options = { xmlns: true, strictEntities: true };
  const parser = sax.parser(true, options);
  const stack: { name: string; uri: string }[] = [];
  const items: LiveFeedItem[] = [];
  let root = '',
    nodes = 0,
    seen = 0,
    rejected = 0,
    entryDepth = 0,
    current: Record<string, string> | null = null;
  const text = (value: string) => {
    if (!current || stack.length !== entryDepth + 1) return;
    const name = stack.at(-1)!.name;
    if (
      ![
        'title',
        'link',
        'guid',
        'id',
        'description',
        'summary',
        'pubDate',
        'published',
        'updated',
        'date',
        'language',
      ].includes(name)
    )
      return;
    current[name] = ((current[name] ?? '') + value).slice(0, 16000);
  };
  parser.ontext = text;
  parser.oncdata = text;
  parser.ondoctype = () => {
    throw new Error('FEED_XML_POLICY');
  };
  parser.onopentag = (tag) => {
    const name = 'local' in tag ? tag.local : tag.name;
    const uri = 'uri' in tag ? tag.uri : '';
    if (++nodes > 30000 || stack.length > 32 || Object.keys(tag.attributes).length > 30)
      throw new Error('FEED_XML_LIMIT');
    stack.push({ name, uri });
    if (stack.length === 1) root = name;
    if (
      !current &&
      ((root === 'rss' && name === 'item' && stack.length === 3) ||
        (root === 'feed' && name === 'entry' && stack.length === 2))
    ) {
      if (++seen > 1000) throw new Error('FEED_ITEM_LIMIT');
      current = {};
      entryDepth = stack.length;
    } else if (current && name === 'link' && stack.length === entryDepth + 1) {
      const attr = (key: string) => {
        const v = tag.attributes[key];
        return typeof v === 'string' ? v : v?.value;
      };
      const rel = attr('rel'),
        href = attr('href');
      if (href && (!rel || rel === 'alternate')) current.link = href;
    }
  };
  parser.onclosetag = () => {
    if (current && stack.length === entryDepth) {
      try {
        const title = newsPlainText(current.title ?? '', 500);
        const url = canonicalNewsUrl(current.link ?? '');
        if (!title || !source.articleOrigins.includes(newsHttpsUrl(url).origin))
          throw new Error('ITEM_POLICY');
        let uncertain = false;
        const date = (value: string | undefined) => {
          if (!value) return null;
          // Reject dates lacking a defensible timezone instead of assuming local time.
          if (!/(?:Z|[+-]\d{2}:?\d{2}|GMT|UTC)\s*$/i.test(value.trim())) {
            uncertain = true;
            return null;
          }
          const n = Date.parse(value);
          if (!Number.isFinite(n) || n < 0 || n > now + 300000) {
            uncertain = true;
            return null;
          }
          return n;
        };
        const publishedAt = date(current.pubDate ?? current.published ?? current.date),
          publisherUpdatedAt = date(current.updated);
        items.push({
          providerItemId: (current.guid ?? current.id ?? url).slice(0, 1000),
          url,
          title,
          excerpt: newsPlainText(
            current.summary ?? current.description ?? '',
            source.maxExcerptChars,
          ),
          language: source.language,
          publishedAt,
          publisherUpdatedAt,
          timestampStatus: uncertain ? 'UNCERTAIN' : publishedAt === null ? 'MISSING' : 'VALID',
        });
      } catch {
        rejected++;
      }
      current = null;
      entryDepth = 0;
    }
    stack.pop();
  };
  parser.write(raw).close();
  if (!['rss', 'feed'].includes(root)) throw new Error('FEED_FORMAT');
  const dedup = new Map<string, LiveFeedItem>();
  for (const item of items) dedup.set(item.url, item);
  return { items: [...dedup.values()], rejected, feedHash: liveNewsHash(bytes) };
}
