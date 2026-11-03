import sax from 'sax';
import { z } from 'zod';
import {
  NewsCaptureSchema,
  NewsParseResultSchema,
  NewsParseResultV2Schema,
  ParsedNewsItemSchema,
} from '@crypto/contracts';
import type { NewsCapture, NewsSource, ParsedNewsItem } from '@crypto/contracts';
import { canonicalHash } from '@crypto/core';
import { allowedNewsArticle, NewsIngestError } from './news-policy.js';
import { parseNewsTimestamp } from './news-dates.js';
import { byteHash } from './market-common.js';

type Node = {
  name: string;
  uri: string;
  attrs: Record<string, string>;
  text: string;
  children: Node[];
};
const atom = 'http://www.w3.org/2005/Atom',
  dc = 'http://purl.org/dc/elements/1.1/';
function xmlRoot(raw: string, keepSnippet = true): Node {
  if (/<!\s*(?:DOCTYPE|ENTITY)/i.test(raw)) throw new NewsIngestError('FORMAT');
  const options = { xmlns: true, strictEntities: true };
  const parser = sax.parser(true, options);
  const stack: Node[] = [];
  let root: Node | undefined,
    count = 0;
  parser.ondoctype = () => {
    throw new NewsIngestError('FORMAT');
  };
  parser.onprocessinginstruction = (instruction) => {
    if (instruction.name !== 'xml') throw new NewsIngestError('FORMAT');
  };
  parser.onerror = () => {
    throw new NewsIngestError('FORMAT');
  };
  parser.onopentag = (tag) => {
    if (
      ++count > 3000 ||
      stack.length >= 16 ||
      Object.keys(tag.attributes).length > 16 ||
      tag.name.length > 100
    )
      throw new NewsIngestError('LIMIT');
    const attrs: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [key, attribute] of Object.entries(tag.attributes)) {
      const candidate: unknown = attribute;
      const value =
        typeof candidate === 'string'
          ? candidate
          : typeof candidate === 'object' &&
              candidate !== null &&
              'value' in candidate &&
              typeof candidate.value === 'string'
            ? candidate.value
            : '';
      if (value.length > 2000) throw new NewsIngestError('LIMIT');
      attrs[key] = value;
    }
    const node: Node = {
      name: 'local' in tag ? tag.local : tag.name,
      uri: 'uri' in tag ? tag.uri : '',
      attrs,
      text: '',
      children: [],
    };
    if (stack.length) stack.at(-1)!.children.push(node);
    else if (root) throw new NewsIngestError('FORMAT');
    else root = node;
    stack.push(node);
  };
  const text = (value: string) => {
    if (!stack.length) {
      if (value.trim()) throw new NewsIngestError('FORMAT');
      return;
    }
    const node = stack.at(-1)!;
    if (!keepSnippet && stack.some((n) => ['description', 'summary', 'content'].includes(n.name)))
      return;
    node.text += value;
    if (node.text.length > 16384) throw new NewsIngestError('LIMIT');
  };
  parser.ontext = text;
  parser.oncdata = text;
  parser.onclosetag = () => {
    stack.pop();
  };
  parser.write(raw).close();
  if (!root || stack.length) throw new NewsIngestError('FORMAT');
  return root;
}
const children = (node: Node, name: string) =>
  node.children.filter(
    (v) => v.name === name && (v.uri === node.uri || (name === 'language' && v.uri === dc)),
  );
function field(node: Node, name: string): string | undefined {
  const values = children(node, name);
  if (values.length > 1 || values[0]?.children.length) throw new Error('Ambiguous field');
  return values[0]?.text.trim() || undefined;
}
const ItemSchema = z.object({
  id: z.string().min(1).max(500),
  url: z.string().max(2000),
  title: z.string().min(1).max(500),
  language: z.string().max(20).optional(),
  published: z.string().max(100).optional(),
  updated: z.string().max(100).optional(),
  snippet: z.string().max(16384).optional(),
});

function rawItems(
  source: NewsSource,
  raw: string,
): { items: unknown[]; language: string | undefined } {
  if (source.format === 'JSON_FEED_1_1') {
    const feed = z
      .object({
        version: z.literal('https://jsonfeed.org/version/1.1'),
        language: z.string().max(20).optional(),
        items: z.array(z.unknown()).max(source.limits.maxItems),
      })
      .parse(JSON.parse(raw));
    return {
      language: feed.language,
      items: feed.items.map((item) => {
        const result = z
          .object({
            id: z.string(),
            url: z.string(),
            title: z.string(),
            language: z.unknown().optional(),
            date_published: z.unknown().optional(),
            date_modified: z.unknown().optional(),
            summary: z.unknown().optional(),
          })
          .safeParse(item);
        return result.success
          ? {
              id: result.data.id,
              url: result.data.url,
              title: result.data.title,
              language: source.allowedFields.includes('language')
                ? result.data.language
                : undefined,
              published: source.allowedFields.includes('publishedAt')
                ? result.data.date_published
                : undefined,
              updated: source.allowedFields.includes('updatedAt')
                ? result.data.date_modified
                : undefined,
              snippet: source.allowedFields.includes('snippet') ? result.data.summary : undefined,
            }
          : null;
      }),
    };
  }
  const root = xmlRoot(raw, source.allowedFields.includes('snippet'));
  if (source.format === 'RSS2') {
    if (
      root.name !== 'rss' ||
      root.uri !== '' ||
      root.attrs.version !== '2.0' ||
      children(root, 'channel').length !== 1
    )
      throw new NewsIngestError('FORMAT');
    const channel = children(root, 'channel')[0]!,
      entries = children(channel, 'item');
    if (entries.length > source.limits.maxItems) throw new NewsIngestError('LIMIT');
    return {
      language: field(channel, 'language'),
      items: entries.map((entry) => {
        try {
          const url = field(entry, 'link');
          return {
            id: field(entry, 'guid') ?? url,
            url,
            title: field(entry, 'title'),
            language: field(entry, 'language'),
            published: field(entry, 'pubDate'),
            updated: undefined,
            snippet: field(entry, 'description'),
          };
        } catch {
          return null;
        }
      }),
    };
  }
  if (root.name !== 'feed' || root.uri !== atom) throw new NewsIngestError('FORMAT');
  const entries = children(root, 'entry');
  if (entries.length > source.limits.maxItems) throw new NewsIngestError('LIMIT');
  return {
    language: root.attrs['xml:lang'],
    items: entries.map((entry) => {
      try {
        const links = children(entry, 'link').filter(
          (l) => !l.attrs.rel || l.attrs.rel === 'alternate',
        );
        return {
          id: field(entry, 'id'),
          url: links.length === 1 ? links[0]!.attrs.href : undefined,
          title: field(entry, 'title'),
          language: entry.attrs['xml:lang'],
          published: field(entry, 'published'),
          updated: field(entry, 'updated'),
          snippet: field(entry, 'summary'),
        };
      } catch {
        return null;
      }
    }),
  };
}

export function parseNewsCapture(source: NewsSource, captureInput: NewsCapture) {
  return NewsParseResultSchema.parse(parseNewsProfile(source, captureInput, false));
}
export function parseLiveNewsCapture(source: NewsSource, captureInput: NewsCapture) {
  return NewsParseResultV2Schema.parse(parseNewsProfile(source, captureInput, true));
}
function parseNewsProfile(source: NewsSource, captureInput: NewsCapture, live: boolean) {
  const resultSchema = live ? NewsParseResultV2Schema : NewsParseResultSchema;
  const capture = NewsCaptureSchema.parse(captureInput);
  if (
    capture.sourceId !== source.id ||
    capture.sourceVersion !== source.version ||
    capture.feedUrl !== source.feedUrl ||
    capture.rawRetention !== 'RETAINED' ||
    byteHash(capture.raw) !== capture.rawHash
  )
    throw new NewsIngestError('INTEGRITY');
  const base = {
    schemaVersion: live ? 'news-parse-result.v2' : 'news-parse-result.v1',
    parserVersion: live ? 'news-feed-parser.v2' : 'news-feed-parser.v1',
    sourceId: source.id,
    rawHash: capture.rawHash,
  };
  let feed: ReturnType<typeof rawItems>;
  try {
    if (Buffer.byteLength(capture.raw) > source.limits.maxBytes) throw new NewsIngestError('LIMIT');
    feed = rawItems(source, capture.raw);
  } catch (error) {
    return resultSchema.parse({
      ...base,
      feedStatus: 'REJECTED',
      feedError: error instanceof NewsIngestError && error.code === 'LIMIT' ? 'LIMIT' : 'FORMAT',
      items: [],
      rejected: [],
    });
  }
  const items: ParsedNewsItem[] = [],
    rejected: z.infer<typeof NewsParseResultSchema>['rejected'] = [],
    ids = new Map<string, number>();
  const normalized = feed.items.map((item) => ItemSchema.safeParse(item));
  for (const result of normalized)
    if (result.success) ids.set(result.data.id, (ids.get(result.data.id) ?? 0) + 1);
  for (const [index, parsed] of normalized.entries()) {
    if (!parsed.success) {
      rejected.push({ index, reason: 'ITEM_SCHEMA' });
      continue;
    }
    const item = parsed.data;
    if (ids.get(item.id) !== 1) {
      rejected.push({ index, reason: 'DUPLICATE_ID' });
      continue;
    }
    let canonicalUrl: string;
    try {
      canonicalUrl = allowedNewsArticle(item.url, source);
    } catch {
      rejected.push({ index, reason: 'ARTICLE_URL' });
      continue;
    }
    const language = (
      source.allowedFields.includes('language')
        ? (item.language ?? feed.language ?? source.languages[0]!)
        : source.languages[0]!
    ).trim();
    if (
      !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(language) ||
      !source.languages.some((v) => v === language || v === language.split('-')[0])
    ) {
      rejected.push({ index, reason: 'LANGUAGE' });
      continue;
    }
    const rawPublishedAt = source.allowedFields.includes('publishedAt')
        ? (item.published ?? null)
        : null,
      rawUpdatedAt = source.allowedFields.includes('updatedAt') ? (item.updated ?? null) : null;
    let invalidDate = false;
    const time = (raw: string | null): ParsedNewsItem['publishedAt'] => {
      if (raw === null) return null;
      try {
        return parseNewsTimestamp(raw, live);
      } catch {
        invalidDate = true;
        return null;
      }
    };
    const publishedAt = time(rawPublishedAt),
      updatedAt = time(rawUpdatedAt);
    if (invalidDate && !live) {
      rejected.push({ index, reason: 'TIMESTAMP' });
      continue;
    }
    const title = item.title.trim();
    if (
      !title ||
      [...title].some((c) => {
        const n = c.charCodeAt(0);
        return (n < 32 && ![9, 10, 13].includes(n)) || n === 127;
      })
    ) {
      rejected.push({ index, reason: 'TEXT' });
      continue;
    }
    const approvedSnippet =
      source.allowedFields.includes('snippet') && source.licensing.permitsSnippet && item.snippet
        ? item.snippet
            .replace(/<[^>]*>/g, '')
            .trim()
            .slice(0, source.licensing.maxSnippetChars)
        : null;
    const content = {
      providerItemId: item.id,
      canonicalUrl,
      title,
      language,
      publishedAt,
      updatedAt,
      rawPublishedAt,
      rawUpdatedAt,
      approvedSnippet,
      timestampStatus: invalidDate
        ? 'UNCERTAIN'
        : publishedAt === null
          ? 'MISSING'
          : publishedAt > capture.observedAt ||
              (updatedAt !== null && updatedAt > capture.observedAt)
            ? 'UNCERTAIN'
            : 'VALID',
    };
    items.push(
      ParsedNewsItemSchema.parse({
        schemaVersion: 'parsed-news-item.v1',
        ...content,
        contentHash: canonicalHash(content),
      }),
    );
  }
  return resultSchema.parse({
    ...base,
    feedStatus: 'PARSED',
    feedError: null,
    items,
    rejected,
  });
}
