import type { LiveNewsStore } from '../../db/src/live-news-store.js';
import { fetchLiveNewsBytes, LiveNewsFetchError } from '../../connectors/src/live-news-fetch.js';
import { liveFeedByteLimit, parseLiveFeed } from '../../connectors/src/live-news-feed.js';
import { parseXrplBlog } from '../../connectors/src/live-news-xrpl.js';
import { fetchFreeNews, parseFreeNews } from '../../connectors/src/free-news-sources.js';

export async function collectLiveNews(
  store: LiveNewsStore,
  sourceId: string,
  revision: number,
  transport: typeof fetchLiveNewsBytes = fetchLiveNewsBytes,
) {
  const claim = await store.claimPoll(sourceId, revision);
  if (!claim) return { skipped: true, newVersions: 0 };
  try {
    const free = !['RSS_ATOM', 'XRPL_BLOG', 'SETUP_REQUIRED'].includes(claim.source.adapter);
    const response = free
      ? await fetchFreeNews(claim.source, transport)
      : await transport(claim.source.feedUrl!, {
          maxBytes: liveFeedByteLimit(claim.source),
          mime:
            claim.source.adapter === 'XRPL_BLOG'
              ? ['text/html']
              : [
                  'application/xml',
                  'text/xml',
                  'application/rss+xml',
                  'application/atom+xml',
                  'application/rdf+xml',
                ],
        });
    const fetchedAt = Date.now(),
      parsed = free
        ? parseFreeNews(response.bytes, claim.source, fetchedAt)
        : claim.source.adapter === 'XRPL_BLOG'
          ? parseXrplBlog(response.bytes, claim.source)
          : parseLiveFeed(response.bytes, claim.source, fetchedAt);
    if (!parsed.items.length && parsed.rejected) throw new Error('FEED_ALL_ITEMS_REJECTED');
    const versions = await store.completePoll(claim, { ...parsed, fetchedAt });
    return {
      skipped: false,
      newVersions: versions.length,
      received: parsed.items.length,
      rejected: parsed.rejected,
    };
  } catch (error) {
    const known = error instanceof LiveNewsFetchError;
    const code = known ? error.message : 'FEED_PARSE_OR_STORAGE_FAILURE';
    await store.failPoll(claim, code, known ? error.status : null, known ? error.retryAfterMs : 0);
    throw new LiveNewsCollectionError(code, known && error.retryable);
  }
}
export class LiveNewsCollectionError extends Error {
  constructor(
    code: string,
    readonly retryable: boolean,
  ) {
    super(code);
  }
}
