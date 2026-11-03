import { FixtureNewsProvider, newsFixtureRegistry } from '@crypto/connectors';
import { NewsIngestStore, persistNewsStore } from '@crypto/news';
import { ResearchDatabase } from '@crypto/db';
import { canonicalHash } from '@crypto/core';
import { workingTreeVersion } from './database-fixtures.js';
import { newsPollCommand } from './news-poll.js';
import { newsReviewCommand } from './news-review.js';
import { newsExtractCommand } from './news-extract.js';
import { newsGraphCommand } from './news-graph.js';
import { newsEventsCommand } from './news-events.js';

async function main() {
  if (
    [
      'events',
      'event-snapshot',
      'event-decide',
      'event-verify',
      'event-provenance',
      'event-inputs',
      'event-persist',
    ].includes(process.argv[2] ?? '')
  )
    return newsEventsCommand(process.argv.slice(2));
  if (['graph', 'graph-review', 'graph-decide', 'graph-persist'].includes(process.argv[2] ?? ''))
    return newsGraphCommand(process.argv.slice(2));
  if (process.argv[2] === 'extract') return newsExtractCommand(process.argv.slice(2));
  if (
    [
      'review',
      'coverage',
      'review-correct',
      'review-persist',
      'snapshot',
      'verify-snapshot',
      'serve-review',
    ].includes(process.argv[2] ?? '')
  )
    return newsReviewCommand(process.argv.slice(2));
  if (['poll', 'poll-status'].includes(process.argv[2] ?? ''))
    return newsPollCommand(process.argv.slice(2));
  if (
    !['fixtures', 'registry'].includes(process.argv[2] ?? '') ||
    process.argv.slice(3).some((v) => v !== '--persist') ||
    process.argv.slice(3).length > 1 ||
    (process.argv[2] === 'registry' && process.argv.length > 3)
  )
    throw new Error('Invalid news command');
  const registry = await newsFixtureRegistry();
  if (process.argv[2] === 'registry') {
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: 'news-license-ledger.v1', origin: 'SYNTHETIC', registry }, null, 2)}\n`,
    );
    return;
  }
  const provider = new FixtureNewsProvider(),
    store = new NewsIngestStore(registry);
  for (const entry of await provider.list())
    store.ingest(
      await provider.read({
        fixtureId: entry.id,
        source: store.registry.source(entry.sourceId, entry.observedAt),
      }),
    );
  const state = store.state();
  let persistence;
  if (process.argv.includes('--persist')) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('Database required');
    const db = new ResearchDatabase({
      connectionString,
      schema: process.env.DATABASE_SCHEMA ?? 'crypto_research',
    });
    try {
      persistence = await persistNewsStore(db, store);
    } finally {
      await db.close();
    }
  }
  process.stdout.write(
    `${JSON.stringify({ schemaVersion: 'news-fixture-report.v1', origin: 'SYNTHETIC', execution: 'DISABLED', registryHash: canonicalHash(registry), stateHash: canonicalHash(state), codeVersion: await workingTreeVersion(), providers: registry.providers.length, sources: registry.sources.length, captures: state.captures.length, rejectedFeeds: state.parseResults.filter((p) => p.feedStatus === 'REJECTED').length, rejectedItems: state.parseResults.reduce((count, p) => count + p.rejected.length, 0), versions: state.documents.length, documentCount: new Set(state.documents.map((d) => d.entityId)).size, hashOnlyCaptures: state.captures.filter((c) => c.rawRetention === 'HASH_ONLY').length, versionsSummary: state.documents.map((v) => ({ sourceId: v.document.sourceId, entityId: v.entityId, revision: v.revision, language: v.document.language, title: v.document.title, contentHash: v.contentHash, firstObservedAt: v.document.firstObservedAt, availableAt: v.document.availableAt, publishedAt: v.document.publishedAt ?? null, independenceGroup: v.independenceGroup, publicationType: v.publicationType })), ...(persistence ? { persistence } : {}) }, null, 2)}\n`,
  );
}
void main().catch(() => {
  process.stderr.write(
    'News command failed. Use registry | fixtures | poll | poll-status | review | coverage | review-correct | review-persist | snapshot | verify-snapshot | serve-review | extract | graph | graph-review | graph-decide | graph-persist | events | event-snapshot | event-decide | event-verify | event-provenance | event-inputs | event-persist. Check flags, policy, journal integrity and database configuration.\n',
  );
  process.exitCode = 1;
});
