import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { newsHttpsUrl, isPublicNewsAddress } from './news-policy.js';

export class LiveNewsFetchError extends Error {
  constructor(
    readonly code: 'NETWORK' | 'URL_POLICY' | 'HTTP' | 'SIZE' | 'FORMAT',
    readonly status: number | null = null,
    readonly retryAfterMs = 0,
  ) {
    super(status === null ? code : `${code}_${status}`);
  }
  get retryable() {
    return (
      this.code === 'NETWORK' ||
      this.status === 429 ||
      this.status === 408 ||
      (this.status !== null && this.status >= 500)
    );
  }
}
export async function resolveNewsAddress(host: string) {
  const answers = await lookup(host, { all: true, verbatim: true });
  if (
    !answers.length ||
    answers.length > 16 ||
    answers.some((a) => !isPublicNewsAddress(a.address))
  )
    throw new LiveNewsFetchError('URL_POLICY');
  return answers[0]!;
}
/** Each request pins a validated public address. No redirects or provider error bodies. */
export async function fetchLiveNewsBytes(
  input: string,
  options: {
    method?: 'GET' | 'POST';
    headers?: Record<string, string>;
    body?: string;
    maxBytes?: number;
    timeoutMs?: number;
    mime?: readonly string[];
  } = {},
  resolver: typeof resolveNewsAddress = resolveNewsAddress,
): Promise<{ bytes: Buffer; status: number }> {
  const url = newsHttpsUrl(input),
    timeout = options.timeoutMs ?? 10000,
    maximum = options.maxBytes ?? 2097152;
  let dnsTimer: ReturnType<typeof setTimeout> | undefined;
  const target = await Promise.race([
    resolver(url.hostname),
    new Promise<never>((_, reject) => {
      dnsTimer = setTimeout(() => reject(new LiveNewsFetchError('NETWORK')), timeout);
    }),
  ]).finally(() => {
    if (dnsTimer) clearTimeout(dnsTimer);
  });
  if (!isPublicNewsAddress(target.address)) throw new LiveNewsFetchError('URL_POLICY');
  return new Promise((resolve, reject) => {
    let done = false;
    const fail = (error: LiveNewsFetchError) => {
      if (!done) {
        done = true;
        reject(error);
      }
    };
    const req = request(
      url,
      {
        method: options.method ?? 'GET',
        agent: false,
        servername: url.hostname,
        rejectUnauthorized: true,
        headers: {
          'user-agent': 'CryptoResearch/0.1 (+https://crypto-trader.nechek805.org) read-only',
          'accept-encoding': 'identity',
          ...options.headers,
        },
        lookup: (_host, opts, cb) => {
          if (opts.all) cb(null, [target]);
          else cb(null, target.address, target.family);
        },
      },
      (res) => {
        const status = res.statusCode ?? 500;
        if (status !== 200) {
          const value = res.headers['retry-after'];
          const retry = value
            ? /^\d+$/.test(value)
              ? Number(value) * 1000
              : Date.parse(value) - Date.now()
            : 0;
          fail(
            new LiveNewsFetchError(
              'HTTP',
              status,
              Number.isFinite(retry) ? Math.max(0, Math.min(retry, 604800000)) : 60000,
            ),
          );
          res.destroy();
          req.destroy();
          return;
        }
        const mime = res.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
        if (
          (options.mime && (!mime || !options.mime.includes(mime))) ||
          (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity')
        ) {
          fail(new LiveNewsFetchError('FORMAT'));
          res.destroy();
          req.destroy();
          return;
        }
        if (Number(res.headers['content-length'] ?? 0) > maximum) {
          fail(new LiveNewsFetchError('SIZE'));
          res.destroy();
          req.destroy();
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maximum) {
            fail(new LiveNewsFetchError('SIZE'));
            res.destroy();
            req.destroy();
          } else chunks.push(chunk);
        });
        res.on('aborted', () => fail(new LiveNewsFetchError('NETWORK')));
        res.on('error', () => fail(new LiveNewsFetchError('NETWORK')));
        res.on('end', () => {
          if (!done) {
            done = true;
            resolve({ bytes: Buffer.concat(chunks), status });
          }
        });
      },
    );
    const timer = setTimeout(() => {
      fail(new LiveNewsFetchError('NETWORK'));
      req.destroy();
    }, timeout);
    req.on('close', () => clearTimeout(timer));
    req.on('error', () => fail(new LiveNewsFetchError('NETWORK')));
    req.end(options.body);
  });
}
