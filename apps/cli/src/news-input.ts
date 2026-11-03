import {
  FixtureNewsProvider,
  liveNewsConfig,
  newsFixtureRegistry,
  PublicNewsProvider,
  newsWallTime,
  newsReviewFixtureCaptures,
} from '@crypto/connectors';
import { NewsIngestStore, NewsPollJournal, NewsPoller } from '@crypto/news';

/** Offline restoration only, including for the explicitly selected public capture journal. */
export async function loadNewsReviewStore(
  provider: string,
  directory: string,
  codeVersion: string,
) {
  if (provider === 'live') {
    const journal = await NewsPollJournal.acquire(directory, liveNewsConfig(), codeVersion);
    try {
      return new NewsPoller(journal, new PublicNewsProvider(), { now: newsWallTime }).store;
    } finally {
      await journal.close();
    }
  }
  if (provider !== 'fixture') throw new Error('Unknown news input');
  const store = new NewsIngestStore(await newsFixtureRegistry()),
    source = new FixtureNewsProvider();
  for (const entry of await source.list())
    store.ingest(
      await source.read({
        fixtureId: entry.id,
        source: store.registry.source(entry.sourceId, entry.observedAt),
      }),
    );
  for (const row of await newsReviewFixtureCaptures()) store.ingestParsed(row.capture, row.parsed);
  return store;
}
