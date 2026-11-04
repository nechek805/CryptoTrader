import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EventEnvelopeSchema,
  ExperimentManifestSchema,
  MarketBarSchema,
  ResearchRunSchema,
} from '@crypto/contracts';
import type { InputReference } from '@crypto/contracts';
import { canonicalHash, deterministicId, utc } from '@crypto/core';
import type { ResearchDatabase } from '@crypto/db';
import { createDomainFixtures } from '../../../tests/fixtures/domain.js';

const projectRoot = new URL('../../../', import.meta.url);
export async function workingTreeVersion(): Promise<string> {
  const root = fileURLToPath(projectRoot);
  const entries: { path: string; content: string }[] = [];
  async function visit(path: string): Promise<void> {
    const children = await readdir(path, { withFileTypes: true });
    for (const child of children) {
      if (['node_modules', '.tools', '.git', '.next', 'dist', 'coverage'].includes(child.name))
        continue;
      if (child.name === 'next-env.d.ts') continue;
      const target = join(path, child.name);
      if (child.isDirectory()) await visit(target);
      else if (/\.(?:tsx?|css|sql|json|ya?ml|mjs)$/.test(child.name))
        entries.push({
          path: relative(root, target).replaceAll('\\', '/'),
          content: (await readFile(target, 'utf8')).replaceAll('\r\n', '\n'),
        });
    }
  }
  for (const folder of ['apps', 'packages', 'research_prototypes', 'tests/fixtures'])
    await visit(join(root, folder));
  for (const file of [
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'tsconfig.base.json',
    'tsconfig.json',
    'eslint.config.mjs',
  ])
    entries.push({
      path: file,
      content: (await readFile(join(root, file), 'utf8')).replaceAll('\r\n', '\n'),
    });
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return `working-tree:${canonicalHash(entries)}`;
}

/** An idempotent fixture import, not market collection or a simulated trading run. */
export async function seedDatabase(db: ResearchDatabase, codeVersion: string) {
  const fixtures = createDomainFixtures();
  const config = {
    schemaVersion: 'fixture-import.v1',
    symbols: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'],
    mode: 'fixture-only',
  };
  const configHash = canonicalHash(config);
  return db.transaction(async (repo) => {
    let newRaw = 0,
      newRevisions = 0;
    const refs: InputReference[] = [];
    for (const symbol of config.symbols) {
      const bar = MarketBarSchema.parse({
        ...fixtures.marketBar,
        id: `fixture:bar:${symbol}`,
        instrumentId: symbol,
      });
      const envelope = EventEnvelopeSchema.parse({
        ...fixtures.eventEnvelope,
        id: `fixture:envelope:${symbol}`,
        payload: bar,
        rawHash: canonicalHash(bar),
      });
      const raw = await repo.ingestRaw({ envelope, sourceRawId: `fixture:bar:${symbol}` });
      const derived = await repo.appendMarketBar(bar, {
        knownAt: bar.availableAt ?? bar.closeAt,
        sourceRawIds: [raw.record.id],
        previousVersionId: null,
      });
      newRaw += Number(raw.created);
      newRevisions += Number(derived.created);
      refs.push({
        kind: 'MARKET_BAR',
        id: derived.record.versionId,
        contentHash: derived.record.contentHash,
      });
    }
    const news = fixtures.newsDocument;
    const newsEnvelope = EventEnvelopeSchema.parse({
      ...fixtures.eventEnvelope,
      id: 'fixture:envelope:news',
      kind: 'news-document',
      provider: 'fixture:news',
      occurredAt: news.publishedAt ?? null,
      observedAt: news.firstObservedAt,
      availableAt: news.availableAt,
      ingestedAt: news.availableAt,
      processedAt: news.availableAt,
      payload: news,
      rawHash: canonicalHash(news),
      provenance: news.provenance,
    });
    const raw = await repo.ingestRaw({ envelope: newsEnvelope, sourceRawId: 'fixture:news:1' });
    const derived = await repo.appendNewsDocument(news, {
      knownAt: news.availableAt ?? news.firstObservedAt,
      sourceRawIds: [raw.record.id],
      previousVersionId: null,
    });
    newRaw += Number(raw.created);
    newRevisions += Number(derived.created);
    refs.push({
      kind: 'NEWS_DOCUMENT',
      id: derived.record.versionId,
      contentHash: derived.record.contentHash,
    });
    const hashes = refs.map((ref) => ref.contentHash);
    const experiment = ExperimentManifestSchema.parse({
      ...fixtures.experimentManifest,
      id: deterministicId('fixture-experiment', { hashes, codeVersion, configHash }),
      inputSnapshotHashes: hashes,
      codeVersion,
      configHash,
    });
    await repo.recordExperiment(experiment, refs);
    const run = ResearchRunSchema.parse({
      schemaVersion: 'research-run.v1',
      id: deterministicId('fixture-run', { hashes, codeVersion, configHash }),
      purpose: 'FIXTURE_IMPORT',
      execution: 'SIMULATED',
      experimentId: experiment.id,
      startedAt: '2026-01-02T00:00:00Z',
      completedAt: '2026-01-02T00:00:01Z',
      status: 'SUCCEEDED',
      reproducibility: {
        ...fixtures.signalCandidate.reproducibility,
        generatedAt: '2026-01-02T00:00:01Z',
        datasetHashes: hashes,
        configHash,
        codeVersion,
      },
    });
    const storedRun = await repo.recordRun(run, refs);
    return {
      schemaVersion: 'fixture-seed-report.v1',
      mode: 'fixture-only',
      newRaw,
      newRevisions,
      visibleBars: (await repo.barsAt(utc('2026-01-02T00:00:00Z'))).items.length,
      visibleNews: (await repo.newsAt(utc('2026-01-02T00:00:00Z'))).items.length,
      runId: run.id,
      runHash: storedRun.record.contentHash,
      configHash,
      codeVersion,
      audit: await repo.verifyAuditChain(),
    };
  });
}
