import { mkdir, readFile, writeFile, rename, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canonicalHash } from '@crypto/core';
import { NewsV4Corpus } from '../../contracts/src/news-research-v4.js';
import type { V4Corpus, FreeCoverage } from '../../contracts/src/news-research-v4.js';
import type { ResearchPlan, ResearchSnapshot } from '../../contracts/src/news-research.js';
import { NewsResearchSnapshot } from '../../contracts/src/news-research.js';
import { LiveNewsVersionSchema } from '../../contracts/src/live-news.js';
import type { LiveNewsSource } from '../../contracts/src/live-news.js';
import type { LiveFeedItem } from '../../connectors/src/live-news-feed.js';
import { newsPlainText, liveNewsHash } from '../../connectors/src/live-news-feed.js';
import { fetchLiveNewsBytes } from '../../connectors/src/live-news-fetch.js';
import {
  governmentLinks,
  parseFreeNews,
  xrplRequest,
  exchangeHeadlineSymbols,
} from '../../connectors/src/free-news-sources.js';
import { freeNewsSources } from '../../news/src/live-source-catalog.js';
import { newsHistoryClassify } from './news-history-study.js';

const Capture = z.strictObject({
  url: z.string().url(),
  requestHash: z.string(),
  receivedAt: z.number().int(),
  body: z.string().max(2097152),
  bodyHash: z.string(),
});
export const FREE_HISTORY_ENGINE_HASH = canonicalHash(
  [
    './free-news-history.ts',
    '../../connectors/src/free-news-sources.ts',
    '../../news/src/live-source-catalog.ts',
  ].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8')),
);
export function governmentPublicationAt(url: string, text: string) {
  const u = new URL(url),
    bls = /\/(?:cpi|empsit)_(\d{2})(\d{2})(\d{4})\.htm$/.exec(u.pathname),
    fed = /monetary(\d{4})(\d{2})(\d{2})a\.htm$/.exec(u.pathname);
  const year = Number(bls?.[3] ?? fed?.[1]),
    month = Number(bls?.[1] ?? fed?.[2]),
    day = Number(bls?.[2] ?? fed?.[3]);
  if (!bls && !fed) {
    const iso =
      /<meta[^>]+(?:property|name)=["'](?:article:published_time|dcterms.created)["'][^>]+content=["']([^"']+)["']/i.exec(
        text,
      )?.[1];
    return iso && /(?:Z|[+-]\d{2}:\d{2})$/.test(iso) && Number.isFinite(Date.parse(iso))
      ? Date.parse(iso)
      : null;
  }
  const plain = newsPlainText(text, 200000);
  const clock = (
    bls
      ? /embargoed until.{0,120}?(\d{1,2}):(\d{2})\s*(a\.m\.|p\.m\.)\s*\(?\s*(ET|EDT|EST)\b/i
      : /For release at\s+(\d{1,2}):(\d{2})\s*(a\.m\.|p\.m\.)\s*\(?\s*(ET|EDT|EST)\b/i
  ).exec(plain);
  if (!clock) return null;
  const noon = Date.UTC(year, month - 1, day, 12),
    localHour = Number(
      new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hour: '2-digit',
        hourCycle: 'h23',
      }).format(noon),
    );
  const offset = clock[4] === 'EDT' ? 4 : clock[4] === 'EST' ? 5 : 12 - localHour;
  const h = (Number(clock[1]) % 12) + (/p\.m\./i.test(clock[3]!) ? 12 : 0);
  const at = Date.UTC(year, month - 1, day, h + offset, Number(clock[2]));
  return at <= Date.now() ? at : null;
}
export function governmentReleaseItem(
  url: string,
  title: string,
  body: string,
  source: LiveNewsSource,
): LiveFeedItem {
  const plain = newsPlainText(body, 200000),
    publishedAt = governmentPublicationAt(url, body);
  const cpi =
    /(?:Consumer Price Index for All Urban Consumers\s*\(CPI-U\)|CPI for all items)\s+(?:increased|decreased|rose|fell|rises|falls|increases|decreases|was unchanged)[\s\S]{0,300}/i.exec(
      plain,
    )?.[0];
  const jobs =
    /Total nonfarm payroll employment\s+(?:increased|decreased|rose|fell|changed little|was essentially unchanged)[\s\S]{0,300}/i.exec(
      plain,
    )?.[0];
  const fed =
    /(?:decided to|maintain|lower|raise)[^.!?]{0,250}target range[^.!?]{0,180}percent/i.exec(
      plain,
    )?.[0];
  const relevant = cpi ?? jobs ?? fed ?? '';
  return {
    providerItemId: url,
    url,
    title: newsPlainText(title, 500),
    excerpt: newsPlainText(relevant, source.maxExcerptChars),
    language: 'en',
    publishedAt,
    publisherUpdatedAt: null,
    timestampStatus: publishedAt === null ? 'MISSING' : 'VALID',
  };
}
export function historyVersion(
  source: LiveNewsSource,
  item: LiveFeedItem,
  capture: { receivedAt: number; bodyHash: string },
) {
  const articleId = canonicalHash({ source: source.id, url: item.url }).slice(7),
    contentHash = canonicalHash(item);
  return LiveNewsVersionSchema.parse({
    ...item,
    id: canonicalHash({ articleId, contentHash }).slice(7),
    articleId,
    sourceId: source.id,
    sourceRevision: source.revision,
    revision: 1,
    publisher: source.name,
    independenceGroup: source.independenceGroup,
    firstSeenAt: capture.receivedAt,
    fetchedAt: capture.receivedAt,
    availableAt: capture.receivedAt,
    contentHash,
    feedHash: capture.bodyHash,
    duplicateGroup: canonicalHash(item.title),
    captureKind: 'INITIAL_SNAPSHOT',
    aiAllowed: source.aiAllowed,
  });
}
/** Compressed, content-checked captures are cached once; retries never silently replace an input. */
export async function collectFreeNewsHistory(
  root: string,
  plan: ResearchPlan,
  parent: ResearchSnapshot,
  progress: (s: string) => Promise<void> = async () => {},
  transport: typeof fetchLiveNewsBytes = fetchLiveNewsBytes,
  origin: 'PUBLIC_HISTORICAL' | 'SYNTHETIC' = 'PUBLIC_HISTORICAL',
): Promise<V4Corpus> {
  const directory = join(root, 'free-history');
  await mkdir(directory, { recursive: true });
  const final = join(
    directory,
    `corpus-${plan.from}-${plan.to}-${origin}-${FREE_HISTORY_ENGINE_HASH.slice(7, 19)}-${canonicalHash(parent).slice(7, 19)}.json`,
  );
  try {
    const raw = z
      .object({ hash: z.string(), corpus: NewsV4Corpus })
      .parse(JSON.parse(await readFile(final, 'utf8')) as unknown);
    if (
      canonicalHash(raw.corpus) !== raw.hash ||
      raw.corpus.from !== plan.from ||
      raw.corpus.to !== plan.to ||
      raw.corpus.origin !== origin ||
      raw.corpus.collectorHash !== FREE_HISTORY_ENGINE_HASH
    )
      throw new Error('Free corpus integrity');
    return raw.corpus;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const configured = new Map(parent.sources.map((s) => [s.id, s]));
  for (const s of freeNewsSources()) if (!configured.has(s.id)) configured.set(s.id, s);
  const sources = [...configured.values()],
    versions = [...parent.versions],
    coverage: FreeCoverage[] = [];
  let requests = 0;
  const get = async (url: string, options: Parameters<typeof fetchLiveNewsBytes>[1] = {}) => {
    const requestHash = canonicalHash({
        url,
        method: options?.method ?? 'GET',
        body: options?.body ?? '',
      }),
      path = join(directory, requestHash.slice(7) + '.json.gz');
    let capture;
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.size > 2200000) throw new Error('Archive cache size');
      capture = Capture.parse(
        JSON.parse(
          gunzipSync(await readFile(path), { maxOutputLength: 2300000 }).toString(),
        ) as unknown,
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      if (++requests > 650) throw new Error('FREE_HISTORY_REQUEST_BUDGET', { cause: e });
      const r = await transport(url, { ...options, timeoutMs: 20000, maxBytes: 2097152 });
      capture = Capture.parse({
        url,
        requestHash,
        receivedAt: Date.now(),
        body: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(r.bytes),
        bodyHash: liveNewsHash(r.bytes),
      });
      const temp = path + '.' + randomUUID() + '.tmp';
      await writeFile(temp, gzipSync(JSON.stringify(capture)));
      await rename(temp, path);
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
    }
    // Older captures decoded away a UTF-8 BOM. Restore it only when the original raw hash proves the bytes exactly.
    if (
      liveNewsHash(capture.body) !== capture.bodyHash &&
      liveNewsHash('\uFEFF' + capture.body) === capture.bodyHash
    )
      capture = { ...capture, body: '\uFEFF' + capture.body };
    if (
      capture.url !== url ||
      capture.requestHash !== requestHash ||
      liveNewsHash(capture.body) !== capture.bodyHash
    )
      throw new Error('Archive capture integrity');
    return capture;
  };
  for (const source of sources.filter((s) => freeNewsSources(0).some((x) => x.id === s.id))) {
    const c: FreeCoverage = {
      sourceId: source.id,
      status: 'COMPLETE',
      attempts: 0,
      scanned: 0,
      records: 0,
      dated: 0,
      earliest: null,
      latest: null,
      captureHashes: [],
      notes: [],
    };
    coverage.push(c);
    let truncated = false;
    const read = async (url: string, options: Parameters<typeof fetchLiveNewsBytes>[1] = {}) => {
      c.attempts++;
      const raw = await get(url, options);
      c.captureHashes.push(canonicalHash(raw));
      return raw;
    };
    const add = (items: LiveFeedItem[], raw: { receivedAt: number; bodyHash: string }) => {
      for (const it of items) {
        c.scanned++;
        if (
          source.adapter === 'BYBIT_JSON' &&
          !newsHistoryClassify(source.id, it.title).assets.length &&
          !exchangeHeadlineSymbols(it.title).length
        )
          continue;
        if (it.publishedAt !== null && (it.publishedAt < plan.from || it.publishedAt >= plan.to))
          continue;
        if (versions.length >= 19500) throw new Error('FREE_HISTORY_CORPUS_BUDGET');
        versions.push(historyVersion(source, it, raw));
        c.records++;
        if (it.publishedAt !== null) {
          c.dated++;
          c.earliest = Math.min(c.earliest ?? Infinity, it.publishedAt);
          c.latest = Math.max(c.latest ?? 0, it.publishedAt);
        }
      }
    };
    try {
      if (!source.collectionApproved || !source.enabled) {
        c.status = 'UNAVAILABLE';
        c.notes.push('Existing source settings forbid collection; not overridden.');
        continue;
      }
      await progress(source.name + ': collecting bounded public history');
      if (source.adapter === 'BYBIT_JSON') {
        const seen = new Set<string>();
        let reached = false;
        for (let page = 1; page <= 100; page++) {
          await progress(`Bybit history: page ${page}/100; ${c.records} retained metadata records`);
          const u = new URL(source.feedUrl!);
          u.searchParams.set('page', String(page));
          const raw = await read(u.href);
          const parsed = parseFreeNews(Buffer.from(raw.body), source, raw.receivedAt),
            payload = z
              .object({ result: z.object({ total: z.number(), list: z.array(z.unknown()) }) })
              .parse(JSON.parse(raw.body) as unknown);
          const key = canonicalHash(payload.result.list);
          if (seen.has(key)) {
            truncated = true;
            c.notes.push('Provider repeated a page; collection stopped.');
            break;
          }
          seen.add(key);
          add(parsed.items, raw);
          if (page * 100 >= payload.result.total || payload.result.list.length === 0) {
            reached = true;
            break;
          }
          const dates = parsed.items
            .map((v) => v.publishedAt)
            .filter((n): n is number => n !== null);
          if (
            dates.length === parsed.items.length &&
            dates.length &&
            Math.max(...dates) < plan.from
          ) {
            reached = true;
            break;
          }
        }
        if (
          !reached ||
          c.dated < c.records ||
          (c.earliest !== null && c.earliest > plan.from + 86400000)
        )
          truncated = true;
        c.notes.push(
          'Only title, URL and explicit publishTime are used; event start/dateTimestamp is not substituted. Pagination is bounded, not a guarantee of a complete archive.',
        );
      } else if (source.adapter === 'GOV_ARCHIVE') {
        const listing: LiveFeedItem[] = [];
        const pages = source.id === 'sec-crypto-history' ? 12 : 1;
        for (let page = 0; page < pages; page++) {
          const u = new URL(source.feedUrl!);
          if (pages > 1) u.searchParams.set('page', String(page));
          try {
            const raw = await read(u.href),
              links = governmentLinks(Buffer.from(raw.body), source);
            listing.push(...links);
            if (pages > 1 && links.length < 10) break;
          } catch (e) {
            if (e instanceof TypeError || e instanceof ReferenceError) throw e;
            if (!listing.length) throw e;
            truncated = true;
            c.notes.push(
              'Archive pagination stopped at an unavailable page; earlier pages are retained.',
            );
            break;
          }
        }
        const unique = [...new Map(listing.map((x) => [x.url, x])).values()]
          .filter((x) => {
            const b = /_(\d{2})(\d{2})(\d{4})\.htm$/.exec(x.url),
              f = /monetary(\d{4})(\d{2})(\d{2})a.htm$/.exec(x.url);
            const day = b
              ? Date.UTC(Number(b[3]), Number(b[1]) - 1, Number(b[2]))
              : f
                ? Date.UTC(Number(f[1]), Number(f[2]) - 1, Number(f[3]))
                : null;
            return day === null || (day + 86400000 >= plan.from && day < plan.to);
          })
          .sort((a, b) => a.url.localeCompare(b.url));
        if (unique.length > 150) truncated = true;
        for (const it of unique.slice(0, 150)) {
          await progress(
            `${source.name}: ${c.records}/${Math.min(150, unique.length)} release pages`,
          );
          try {
            const raw = await read(it.url);
            add([governmentReleaseItem(it.url, it.title, raw.body, source)], raw);
          } catch {
            truncated = true;
            c.notes.push('One or more original release pages unavailable or rejected.');
            c.notes = [...new Set(c.notes)];
          }
        }
        c.notes.push(
          'Archived text was collected today. Original release times are descriptive alignment evidence, not verified historical receipt times.',
        );
        if (source.id === 'sec-crypto-history') {
          truncated = true;
          c.notes.push(
            'Bounded SEC archive pages; records without exact publication time stay undated.',
          );
        }
      } else if (source.adapter === 'XRPL_LEDGER') {
        const raw = await read(source.feedUrl!, xrplRequest('ledger_entry'));
        const initial = z
          .object({
            result: z.object({
              validated: z.literal(true),
              node: z.object({ PreviousTxnID: z.string().regex(/^[A-Fa-f0-9]{64}$/) }),
            }),
          })
          .parse(JSON.parse(raw.body) as unknown);
        let id = initial.result.node.PreviousTxnID,
          reached = false;
        const visited = new Set<string>();
        for (let n = 0; n < 300; n++) {
          if (visited.has(id)) throw new Error('XRPL history cycle');
          visited.add(id);
          await progress(`XRPL amendment history: ${n + 1}/300 validated change transactions`);
          const tx = await read(source.feedUrl!, xrplRequest('tx', id));
          const r = z
            .object({
              result: z
                .object({
                  hash: z.string(),
                  date: z.number().int(),
                  validated: z.literal(true),
                  meta: z.object({
                    AffectedNodes: z.array(
                      z
                        .object({
                          ModifiedNode: z
                            .object({
                              LedgerEntryType: z.string(),
                              PreviousTxnID: z.string().optional(),
                            })
                            .passthrough()
                            .optional(),
                        })
                        .passthrough(),
                    ),
                  }),
                })
                .passthrough(),
            })
            .parse(JSON.parse(tx.body) as unknown);
          if (r.result.hash !== id) throw new Error('XRPL transaction identity mismatch');
          if (r.result.date * 1000 + 946684800000 < plan.from) {
            reached = true;
            break;
          }
          add(parseFreeNews(Buffer.from(tx.body), source, tx.receivedAt).items, tx);
          const previous = r.result.meta.AffectedNodes.find(
            (x) => x.ModifiedNode?.LedgerEntryType === 'Amendments',
          )?.ModifiedNode?.PreviousTxnID;
          if (!previous) {
            truncated = true;
            c.notes.push('Prior amendment state unavailable; history is partial.');
            break;
          }
          id = previous;
        }
        if (!reached) truncated = true;
        c.notes.push(
          'Validated ledger transaction dates are event times; no historical monitoring latency is invented. Voting changes are distinct from activation.',
        );
      } else {
        const raw = await read(source.feedUrl!);
        add(parseFreeNews(Buffer.from(raw.body), source, raw.receivedAt).items, raw);
        truncated = true;
        c.notes.push(
          source.adapter === 'GDELT_DOC'
            ? 'Discovery-only current metadata; not a 36-month article-text archive and excluded from model fitting.'
            : 'Public endpoint retains limited incident history; original update timestamps retained, edits use later availability proxy.',
        );
      }
      if (truncated) c.status = 'LIMITED';
    } catch (e) {
      if (e instanceof TypeError || e instanceof ReferenceError) throw e;
      c.status = c.records ? 'LIMITED' : 'UNAVAILABLE';
      c.notes.push(
        'Public source failed or reached a bounded limit; no synthetic replacement. ' +
          (e instanceof Error && /^[A-Z_0-9]+$/.test(e.message) ? e.message : 'SOURCE_UNAVAILABLE'),
      );
    }
    c.notes = [...new Set(c.notes)].slice(0, 12);
  }
  const dedup = [...new Map(versions.map((v) => [v.sourceId + '|' + v.url, v])).values()];
  const corpus = NewsV4Corpus.parse({
    version: 'free-news-corpus.v4',
    origin,
    collectorHash: FREE_HISTORY_ENGINE_HASH,
    from: plan.from,
    to: plan.to,
    snapshot: NewsResearchSnapshot.parse({
      capturedAt: Date.now(),
      total: dedup.length,
      sources,
      versions: dedup,
    }),
    coverage,
  });
  const temp = final + '.' + randomUUID() + '.tmp';
  await writeFile(temp, JSON.stringify({ hash: canonicalHash(corpus), corpus }));
  await rename(temp, final);
  return corpus;
}
