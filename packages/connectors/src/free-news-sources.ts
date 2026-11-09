import { z } from 'zod';
import { MARKET_ASSETS } from '../../contracts/src/market-tests.js';
import { LiveNewsSourceSchema } from '../../contracts/src/live-news.js';
import type { LiveNewsSource } from '../../contracts/src/live-news.js';
import type { LiveFeedItem } from './live-news-feed.js';
import { liveNewsHash, newsPlainText } from './live-news-feed.js';
import { fetchLiveNewsBytes } from './live-news-fetch.js';

export const GDELT_FREE_URL =
  'https://api.gdeltproject.org/api/v2/doc/doc?query=%28bitcoin%20OR%20ethereum%20OR%20solana%20OR%20XRP%20OR%20dogecoin%20OR%20cardano%20OR%20chainlink%20OR%20avalanche%20OR%20BNB%20OR%20TRON%29&mode=artlist&format=json&maxrecords=250&timespan=1d';
export const XRPL_AMENDMENTS_INDEX =
  '7DB0788C020F02780A673DC74757F23823FA3014C1866E72CC4CD8B226CD6EF4';
/** Exact known exchange symbols, kept separate from unmodified publisher evidence. */
export const exchangeHeadlineSymbols = (text: string) =>
  MARKET_ASSETS.filter((asset) => new RegExp('\\b' + asset + 'USDT\\b', 'i').test(text));
export const xrplRequest = (method: 'ledger_entry' | 'tx', transaction?: string) => ({
  method: 'POST' as const,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    method,
    params: [
      method === 'ledger_entry'
        ? { index: XRPL_AMENDMENTS_INDEX, ledger_index: 'validated', binary: false }
        : { transaction, binary: false },
    ],
  }),
});
function instant(value: unknown, now: number) {
  if (typeof value === 'number')
    return Number.isInteger(value) && value >= 0 && value <= now + 300000 ? value : null;
  if (typeof value !== 'string' || !/(Z|[+-]\d{2}:?\d{2})$/.test(value)) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) && at >= 0 && at <= now + 300000 ? at : null;
}
function item(
  source: LiveNewsSource,
  title: string,
  url: string,
  id: string,
  at: number | null,
  excerpt = '',
): LiveFeedItem {
  const u = new URL(url);
  if (
    u.protocol !== 'https:' ||
    u.username ||
    u.password ||
    !source.articleOrigins.includes(u.origin)
  )
    throw new Error('FREE_NEWS_ITEM_ORIGIN');
  return {
    providerItemId: id.slice(0, 1000),
    title: newsPlainText(title, 500),
    url: u.href,
    excerpt: newsPlainText(excerpt, source.maxExcerptChars),
    language: source.language,
    publishedAt: at,
    publisherUpdatedAt: null,
    timestampStatus: at === null ? 'MISSING' : 'VALID',
  };
}
export function governmentLinks(bytes: Buffer, source: LiveNewsSource) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    items: LiveFeedItem[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let u: URL;
    try {
      u = new URL(m[1]!.replaceAll('&amp;', '&'), source.feedUrl!);
    } catch {
      continue;
    }
    if (u.origin !== new URL(source.feedUrl!).origin || u.search || u.hash || seen.has(u.href))
      continue;
    if (
      !/^\/news\.release\/archives\/(?:cpi|empsit)_\d{8}\.htm$|^\/newsevents\/pressreleases\/monetary\d{8}a\.htm$|^\/newsroom\/press-releases\/[a-z0-9-]+$/.test(
        u.pathname,
      )
    )
      continue;
    seen.add(u.href);
    items.push(
      item(
        source,
        newsPlainText(m[2]!, 500) === 'HTML'
          ? 'Federal Reserve FOMC policy statement ' + u.pathname.match(/\d{8}/)?.[0]
          : m[2]!,
        u.href,
        u.href,
        null,
      ),
    );
    if (items.length >= 500) break;
  }
  if (!items.length) throw new Error('GOV_ARCHIVE_LAYOUT');
  return items;
}
export function parseFreeNews(bytes: Buffer, input: LiveNewsSource, now = Date.now()) {
  const source = LiveNewsSourceSchema.parse(input);
  if (bytes.length > 2097152) throw new Error('FREE_NEWS_SIZE');
  let items: LiveFeedItem[] = [],
    rejected = 0;
  const push = (fn: () => LiveFeedItem) => {
    try {
      const row = fn();
      if (!row.title) throw new Error('TITLE');
      items.push(row);
    } catch {
      rejected++;
    }
  };
  if (source.adapter === 'GOV_ARCHIVE') items = governmentLinks(bytes, source);
  else {
    const data: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (source.adapter === 'BYBIT_JSON') {
      const r = z
        .object({
          retCode: z.literal(0),
          result: z.object({
            total: z.number().int(),
            list: z
              .array(
                z.object({
                  title: z.string(),
                  url: z.string(),
                  publishTime: z.number().int().optional(),
                  dateTimestamp: z.number().int().optional(),
                }),
              )
              .max(100),
          }),
        })
        .parse(data);
      for (const v of r.result.list)
        push(() => item(source, v.title, v.url, v.url, instant(v.publishTime, now)));
    } else if (source.adapter === 'STATUSPAGE_JSON') {
      const r = z
        .object({
          incidents: z
            .array(
              z.object({
                id: z.string(),
                name: z.string(),
                shortlink: z.string(),
                incident_updates: z
                  .array(
                    z.object({
                      id: z.string(),
                      status: z.string(),
                      created_at: z.string(),
                      updated_at: z.string().optional(),
                      display_at: z.string().optional(),
                    }),
                  )
                  .max(500),
              }),
            )
            .max(100),
        })
        .parse(data);
      for (const v of r.incidents)
        for (const update of v.incident_updates)
          push(() => {
            const created = instant(update.created_at, now),
              changed = instant(update.updated_at, now),
              displayed = instant(update.display_at, now);
            // Never backdate a later edited incident update to its original creation time.
            const at =
              created === null ||
              (update.updated_at !== undefined && changed === null) ||
              (update.display_at !== undefined && displayed === null)
                ? null
                : Math.max(created, changed ?? created, displayed ?? created);
            const kind =
              update.status === 'resolved'
                ? 'resolved'
                : update.status === 'monitoring'
                  ? 'monitoring'
                  : update.status === 'identified'
                    ? 'confirmed incident'
                    : 'investigating incident';
            const u = new URL(source.feedUrl!);
            return item(
              source,
              `${source.id.startsWith('solana') ? 'Solana' : 'Coinbase Exchange'} ${kind}: ${v.name}`,
              u.origin + '/incidents/' + v.id + '?update=' + encodeURIComponent(update.id),
              v.id + ':' + update.id,
              at,
            );
          });
    } else if (source.adapter === 'GDELT_DOC') {
      const r = z
        .object({
          articles: z
            .array(
              z.object({
                url: z.string(),
                title: z.string(),
                seendate: z.string(),
                language: z.string().optional(),
              }),
            )
            .max(250),
        })
        .parse(data);
      for (const v of r.articles) push(() => item(source, v.title, v.url, v.url, null)); // seendate is not a publisher timestamp.
    } else if (source.adapter === 'XRPL_LEDGER') {
      const r = z
        .object({
          result: z.object({
            validated: z.literal(true),
            hash: z.string().regex(/^[A-Fa-f0-9]{64}$/),
            TransactionType: z.literal('EnableAmendment'),
            Amendment: z.string().regex(/^[A-Fa-f0-9]{64}$/),
            Flags: z.number().int().optional(),
            date: z.number().int(),
          }),
        })
        .parse(data);
      const v = r.result,
        flags = v.Flags ?? 0;
      if (![0, 65536, 131072].includes(flags)) throw new Error('XRPL_AMENDMENT_FLAGS');
      const stage =
        flags === 0
          ? 'activated'
          : flags === 65536
            ? 'gained voting majority'
            : 'lost voting majority';
      push(() =>
        item(
          source,
          `XRP Ledger amendment ${v.Amendment} ${stage}`,
          'https://livenet.xrpl.org/transactions/' + v.hash,
          v.hash,
          instant(v.date * 1000 + 946684800000, now),
        ),
      );
    } else throw new Error('UNSUPPORTED_FREE_NEWS_ADAPTER');
  }
  return { items, rejected, feedHash: liveNewsHash(bytes) };
}
export async function fetchFreeNews(
  source: LiveNewsSource,
  transport: typeof fetchLiveNewsBytes = fetchLiveNewsBytes,
) {
  if (source.adapter === 'XRPL_LEDGER') {
    const r = await transport(source.feedUrl!, xrplRequest('ledger_entry'));
    const value = z
      .object({
        result: z.object({
          validated: z.literal(true),
          node: z.object({ PreviousTxnID: z.string().regex(/^[A-Fa-f0-9]{64}$/) }),
        }),
      })
      .parse(JSON.parse(r.bytes.toString()) as unknown);
    return transport(source.feedUrl!, xrplRequest('tx', value.result.node.PreviousTxnID));
  }
  return transport(source.feedUrl!, {
    maxBytes: 2097152,
    mime: source.adapter === 'GOV_ARCHIVE' ? ['text/html'] : ['application/json', 'text/json'],
  });
}
