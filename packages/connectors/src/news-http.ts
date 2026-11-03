import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import type { RequestOptions } from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { NewsSourceSchema } from '@crypto/contracts';
import type { NewsSource } from '@crypto/contracts';
import { isPublicNewsAddress, newsHttpsUrl, NewsIngestError } from './news-policy.js';

export type NewsDnsLookup = (hostname: string) => Promise<{ address: string; family: number }[]>;
export type NewsHttpRequest = (
  url: URL,
  options: RequestOptions,
  callback: (response: IncomingMessage) => void,
) => ClientRequest;
export class NewsHttpError extends NewsIngestError {
  constructor(
    readonly status: number,
    readonly retryable: boolean,
    readonly retryAfterMs: number | null,
  ) {
    super(retryable ? 'NETWORK' : 'POLICY');
  }
}
export function newsRetryAfter(value: string | undefined, nowMs: number): number {
  if (value === undefined) return 60000;
  const duration = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - nowMs;
  if (!Number.isFinite(duration)) return 60000;
  if (duration > 604800000) throw new NewsIngestError('POLICY');
  return Math.max(0, Math.ceil(duration));
}
/** Prepare a pinned target; resolving all answers prevents mixed public/private DNS bypass. */
export async function newsHttpTarget(
  source: NewsSource,
  resolve: NewsDnsLookup = (host) => lookup(host, { all: true, verbatim: true }),
) {
  source = NewsSourceSchema.parse(source);
  if (source.accessMethod !== 'PUBLIC_HTTPS' || !source.licensing.approvedForLive)
    throw new NewsIngestError('POLICY');
  const url = newsHttpsUrl(source.feedUrl);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const answers = await Promise.race([
    resolve(url.hostname),
    new Promise<never>((_r, reject) => {
      timer = setTimeout(() => reject(new NewsIngestError('NETWORK')), source.limits.timeoutMs);
      timer.unref();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
  if (
    !answers.length ||
    answers.length > 16 ||
    answers.some((a) => ![4, 6].includes(a.family) || !isPublicNewsAddress(a.address))
  )
    throw new NewsIngestError('URL');
  return { url, address: answers[0]!.address, family: answers[0]!.family };
}

/** Low-level future adapter primitive. No registered live feed or polling loop exists yet. */
export async function readNewsHttps(
  source: NewsSource,
  signal?: AbortSignal,
  dependencies: { resolve?: NewsDnsLookup; request?: NewsHttpRequest } = {},
): Promise<Buffer> {
  source = NewsSourceSchema.parse(source);
  if (signal?.aborted) throw new NewsIngestError('NETWORK');
  const target = await newsHttpTarget(source, dependencies.resolve);
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (code: 'NETWORK' | 'LIMIT' | 'POLICY') => {
      if (!settled) {
        settled = true;
        reject(new NewsIngestError(code));
      }
    };
    const req = (dependencies.request ?? request)(
      target.url,
      {
        method: 'GET',
        agent: false,
        servername: target.url.hostname,
        rejectUnauthorized: true,
        headers: {
          accept:
            source.format === 'JSON_FEED_1_1'
              ? 'application/feed+json, application/json'
              : 'application/rss+xml, application/atom+xml, application/xml, text/xml',
          'accept-encoding': 'identity',
          'user-agent': 'CryptoResearch/0.1 read-only',
        },
        lookup: (_host, options, callback) => {
          if (options.all) callback(null, [{ address: target.address, family: target.family }]);
          else callback(null, target.address, target.family);
        },
        ...(signal ? { signal } : {}),
      },
      (response) => {
        if (response.statusCode !== 200) {
          const status = response.statusCode ?? 500;
          try {
            const retryable = status === 429 || status === 408 || status >= 500;
            const retry =
              status === 429 ? newsRetryAfter(response.headers['retry-after'], Date.now()) : null;
            if (!settled) {
              settled = true;
              reject(new NewsHttpError(status, retryable, retry));
            }
          } catch {
            fail('POLICY');
          }
          response.destroy();
          req.destroy();
          return;
        }
        const mime = response.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
        const allowed =
          source.format === 'JSON_FEED_1_1'
            ? ['application/json', 'application/feed+json']
            : ['application/xml', 'text/xml', 'application/rss+xml', 'application/atom+xml'];
        if (
          response.statusCode !== 200 ||
          !mime ||
          !allowed.includes(mime) ||
          (response.headers['content-encoding'] &&
            response.headers['content-encoding'] !== 'identity')
        ) {
          response.destroy();
          req.destroy();
          fail('POLICY');
          return;
        }
        const declared = response.headers['content-length'];
        if (declared && (!/^\d+$/.test(declared) || Number(declared) > source.limits.maxBytes)) {
          response.destroy();
          req.destroy();
          fail('LIMIT');
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > source.limits.maxBytes) {
            response.destroy();
            req.destroy();
            fail('LIMIT');
          } else chunks.push(chunk);
        });
        response.on('error', () => fail('NETWORK'));
        response.on('aborted', () => fail('NETWORK'));
        response.on('end', () => {
          if (!settled) {
            settled = true;
            resolve(Buffer.concat(chunks));
          }
        });
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      fail('NETWORK');
    }, source.limits.timeoutMs);
    req.on('close', () => clearTimeout(timer));
    req.on('error', () => fail('NETWORK'));
    req.end();
  });
}
