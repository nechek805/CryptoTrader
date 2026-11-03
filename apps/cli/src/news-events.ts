import { lstat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { NewsEventInputsSchema } from '@crypto/contracts';
import { newsWallTime } from '@crypto/connectors';
import { ResearchDatabase } from '@crypto/db';
import {
  defaultNewsGraphConfig,
  defaultNewsEventConfig,
  NewsGraphJournal,
  NewsEventJournal,
  NewsEventService,
  newsTemporalEventFixtures,
  verifyNewsEventSnapshot,
  writeNewsEventSnapshot,
  newsEventResearchInputs,
  newsEventProvenanceDot,
  persistNewsEventSnapshot,
} from '@crypto/news';
import { workingTreeVersion } from './database-fixtures.js';

export async function newsEventsCommand(args: string[]) {
  const command = args[0],
    artifactCommands = ['event-verify', 'event-provenance', 'event-inputs', 'event-persist'],
    common = ['--provider', '--graph-dir', '--event-dir'],
    allowed = artifactCommands.includes(command ?? '')
      ? ['--artifact', ...(command === 'event-inputs' ? ['--at', '--purpose'] : [])]
      : command === 'event-decide'
        ? [...common, '--request']
        : [
            ...common,
            '--at',
            '--graph-head',
            '--metadata-head',
            ...(command === 'event-snapshot' ? ['--out'] : []),
          ],
    flags = new Map<string, string>();
  for (let i = 1; i < args.length; i += 2) {
    const key = args[i],
      value = args[i + 1];
    if (!key || !value || !allowed.includes(key) || flags.has(key) || value.startsWith('--'))
      throw new Error('Invalid event flags');
    flags.set(key, value);
  }
  const print = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  if (artifactCommands.includes(command ?? '')) {
    const path = flags.get('--artifact');
    if (!path) throw new Error('Artifact required');
    const result = await verifyNewsEventSnapshot(resolve(path));
    if (command === 'event-provenance') {
      process.stdout.write(`${newsEventProvenanceDot(result.artifact)}\n`);
      return;
    }
    if (command === 'event-inputs') {
      print(
        newsEventResearchInputs(
          result.artifact,
          flags.get('--at') ?? result.artifact.request.decisionAt,
          NewsEventInputsSchema.shape.purpose.parse(flags.get('--purpose') ?? 'EVENT_STUDY'),
        ),
      );
      return;
    }
    if (command === 'event-persist') {
      const connectionString = process.env.DATABASE_URL;
      if (!connectionString) throw new Error('Database required');
      const db = new ResearchDatabase({
        connectionString,
        schema: process.env.DATABASE_SCHEMA ?? 'crypto_research',
      });
      try {
        print(await persistNewsEventSnapshot(db, result.artifact));
      } finally {
        await db.close();
      }
      return;
    }
    print({
      schemaVersion: 'news-event-verification.v1',
      verified: true,
      hash: result.hash,
      inputHash: result.artifact.inputHash,
      events: result.artifact.view.events.length,
    });
    return;
  }
  const provider = flags.get('--provider') ?? 'fixture';
  if (!['fixture', 'local'].includes(provider)) throw new Error('Unknown event provider');
  const graphConfig = defaultNewsGraphConfig(),
    config = defaultNewsEventConfig(),
    root = resolve(flags.get('--graph-dir') ?? `data/news-events-${provider}`),
    graph = await NewsGraphJournal.acquire(root, graphConfig);
  try {
    const metadata = await NewsEventJournal.acquire(
      resolve(flags.get('--event-dir') ?? join(root, 'event-metadata')),
      config,
      graphConfig,
    );
    try {
      if (provider === 'fixture') {
        const fixture = await newsTemporalEventFixtures();
        for (let i = 0; i < fixture.graphRecords.length; i++) {
          if (graph.records[i]) {
            if (graph.records[i]!.hash !== fixture.graphRecords[i]!.hash)
              throw new Error('Fixture graph mismatch');
          } else await graph.append(fixture.graphRecords[i]!);
        }
        for (let i = 0; i < fixture.metadataRecords.length; i++) {
          if (metadata.records[i]) {
            if (metadata.records[i]!.hash !== fixture.metadataRecords[i]!.hash)
              throw new Error('Fixture metadata mismatch');
          } else await metadata.append(fixture.metadataRecords[i]!);
        }
      }
      const codeVersion = await workingTreeVersion(),
        service = new NewsEventService(
          config,
          graphConfig,
          graph.records,
          metadata.records,
          { now: newsWallTime },
          codeVersion,
          metadata,
        );
      if (command === 'event-decide') {
        const request = flags.get('--request');
        if (!request) throw new Error('Decision request required');
        const path = resolve(request),
          info = await lstat(path);
        if (!info.isFile() || info.size > 16384) throw new Error('Decision input limit');
        const body = await readFile(path, 'utf8');
        if (Buffer.byteLength(body) > 16384) throw new Error('Decision input limit');
        print(await service.decide(JSON.parse(body)));
        return;
      }
      const query = {
        decisionAt: flags.get('--at') ?? newsWallTime(),
        ...(flags.has('--graph-head') ? { graphHeadHash: flags.get('--graph-head') } : {}),
        ...(flags.has('--metadata-head') ? { metadataHeadHash: flags.get('--metadata-head') } : {}),
      };
      if (command === 'event-snapshot') {
        const result = await writeNewsEventSnapshot(
          graphConfig,
          graph.records,
          metadata.records,
          config,
          { ...query, generatedAt: newsWallTime() },
          resolve(flags.get('--out') ?? 'data/news-event-snapshots'),
          codeVersion,
        );
        print({
          schemaVersion: 'news-event-export.v1',
          path: result.path,
          hash: result.hash,
          inputHash: result.artifact.inputHash,
          graphHeadHash: result.artifact.view.graphHeadHash,
          metadataHeadHash: result.artifact.view.metadataHeadHash,
          events: result.artifact.view.events.length,
        });
        return;
      }
      print(service.query(query));
    } finally {
      await metadata.close();
    }
  } finally {
    await graph.close();
  }
}
