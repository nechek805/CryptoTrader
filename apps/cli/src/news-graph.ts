import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { NewsGraphBatchInputSchema, NewsGraphReviewQueueSchema } from '@crypto/contracts';
import { MockClock } from '@crypto/core';
import { newsWallTime } from '@crypto/connectors';
import { ResearchDatabase } from '@crypto/db';
import {
  defaultNewsGraphConfig,
  NewsGraphJournal,
  NewsGraphService,
  newsGraphFixtures,
  persistNewsGraph,
} from '@crypto/news';
import { workingTreeVersion } from './database-fixtures.js';

async function jsonFile(path: string, limit: number) {
  const info = await lstat(path);
  if (!info.isFile() || info.size > limit) throw new Error('Graph input limit');
  const body = await readFile(path, 'utf8');
  if (Buffer.byteLength(body) > limit) throw new Error('Graph input limit');
  return JSON.parse(body) as unknown;
}
export async function newsGraphCommand(args: string[]) {
  const command = args[0],
    common = ['--provider', '--graph-dir'],
    allowed =
      command === 'graph'
        ? [...common, '--batch', '--at']
        : command === 'graph-review'
          ? [...common, '--at']
          : command === 'graph-decide'
            ? [...common, '--request']
            : command === 'graph-persist'
              ? common
              : [];
  const flags = new Map<string, string>();
  for (let i = 1; i < args.length; i += 2) {
    const key = args[i],
      value = args[i + 1];
    if (!key || !value || !allowed.includes(key) || flags.has(key) || value.startsWith('--'))
      throw new Error('Invalid graph flags');
    flags.set(key, value);
  }
  if (flags.has('--batch') && flags.has('--provider')) throw new Error('Choose graph input');
  const provider = flags.get('--provider') ?? (flags.has('--batch') ? 'local' : 'fixture');
  if (!['fixture', 'local'].includes(provider)) throw new Error('Unknown graph provider');
  const config = defaultNewsGraphConfig(),
    codeVersion = await workingTreeVersion(),
    journal = await NewsGraphJournal.acquire(
      resolve(flags.get('--graph-dir') ?? `data/news-graph-${provider}`),
      config,
    );
  try {
    if (provider === 'fixture') {
      const clock = new MockClock(journal.records.at(-1)?.recordedAt ?? '2026-01-01T09:00:00Z'),
        fixture = new NewsGraphService(config, journal.records, clock, codeVersion, journal),
        rows = await newsGraphFixtures();
      for (const row of rows) {
        if (row.recordedAt > clock.now()) clock.advanceTo(row.recordedAt);
        await fixture.observe(row.result);
      }
      const wire = rows.find((r) => r.id === 'wire')!.result.claims[0]!.id;
      if (
        !fixture
          .records()
          .some(
            (r) =>
              r.action.kind === 'REVIEW' &&
              r.action.operator === 'synthetic:scenario' &&
              r.action.decision.kind === 'RETRACT' &&
              r.action.decision.claimId === wire,
          )
      ) {
        if (clock.now() < '2026-01-01T09:20:00.000000000Z') clock.advanceTo('2026-01-01T09:20:00Z');
        await fixture.decide({
          schemaVersion: 'news-graph-decision-request.v1',
          expectedHeadHash: fixture.headHash(),
          operator: 'synthetic:scenario',
          reason: 'Synthetic scenario: original wire assertion withdrawn; retain prior evidence.',
          action: { kind: 'RETRACT', claimId: wire },
        });
      }
    }
    const service = new NewsGraphService(
      config,
      journal.records,
      { now: newsWallTime },
      codeVersion,
      journal,
    );
    if (flags.has('--batch')) {
      const batch = NewsGraphBatchInputSchema.parse(
        await jsonFile(resolve(flags.get('--batch')!), 64 * 1024 * 1024),
      );
      for (const extraction of batch.results) await service.observe(extraction);
    }
    let output: unknown;
    if (command === 'graph-decide') {
      if (!flags.has('--request')) throw new Error('Graph request required');
      output = await service.decide(await jsonFile(resolve(flags.get('--request')!), 16384));
    } else if (command === 'graph-persist') {
      const connectionString = process.env.DATABASE_URL;
      if (!connectionString) throw new Error('Database required');
      const db = new ResearchDatabase({
        connectionString,
        schema: process.env.DATABASE_SCHEMA ?? 'crypto_research',
      });
      try {
        output = await persistNewsGraph(db, service);
      } finally {
        await db.close();
      }
    } else {
      const view = service.query({ decisionAt: flags.get('--at') ?? newsWallTime() });
      output =
        command === 'graph-review'
          ? NewsGraphReviewQueueSchema.parse({
              schemaVersion: 'news-graph-review-queue.v1',
              decisionAt: view.decisionAt,
              journalHeadHash: view.journalHeadHash,
              items: view.review,
            })
          : view;
    }
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } finally {
    await journal.close();
  }
}
