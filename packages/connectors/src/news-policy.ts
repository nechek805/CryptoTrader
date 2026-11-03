import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import type { NewsSource } from '@crypto/contracts';

export class NewsIngestError extends Error {
  constructor(
    readonly code:
      'REGISTRY' | 'URL' | 'NETWORK' | 'LIMIT' | 'FORMAT' | 'POLICY' | 'CONFLICT' | 'INTEGRITY',
  ) {
    super(`News ingestion: ${code}`);
  }
}
/** No credentials, nonstandard ports, IP literals, encoded path tricks or redirects. */
export function newsHttpsUrl(value: string): URL {
  if (
    typeof value !== 'string' ||
    value.length > 2000 ||
    /[\s\\]/u.test(value) ||
    [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
    /%(?:2e|2f|5c|00|25)/i.test(value)
  )
    throw new NewsIngestError('URL');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new NewsIngestError('URL');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    isIP(url.hostname.replace(/^\[|\]$/g, '')) ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(url.hostname) ||
    !url.hostname.includes('.') ||
    url.hostname.endsWith('.') ||
    url.hostname.endsWith('.localhost') ||
    /%(?:2e|2f|5c|00|25)/i.test(url.pathname)
  )
    throw new NewsIngestError('URL');
  return url;
}
export function allowedNewsArticle(value: string, source: NewsSource): string {
  const url = newsHttpsUrl(value);
  if (!source.articleOrigins.includes(url.origin)) throw new NewsIngestError('URL');
  return url.href;
}
export function validateNewsSourceUrls(source: NewsSource): void {
  newsHttpsUrl(source.feedUrl);
  for (const origin of source.articleOrigins)
    if (newsHttpsUrl(origin).origin !== origin) throw new NewsIngestError('URL');
}
export function isPublicNewsAddress(value: string): boolean {
  if (!ipaddr.isValid(value)) return false;
  const address = ipaddr.parse(value);
  // Reject mapped/translation/tunnel ranges as well as private, local, reserved and multicast.
  return (
    address.range() === 'unicast' &&
    (address.kind() === 'ipv4' || address.match(ipaddr.parse('2000::'), 3))
  );
}
