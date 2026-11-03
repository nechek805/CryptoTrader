import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { NewsExtractionBatchSchema, NewsOntologySchema } from '@crypto/contracts';
import { ResearchDatabase } from '@crypto/db';
import { canonicalHash } from '@crypto/core';
import { newsWallTime } from '@crypto/connectors';
import {
  defaultNewsExtractionConfig,
  DeterministicNewsClaimAdapter,
  NewsClaimExtractor,
  newsExtractionFixtures,
  persistNewsExtraction,
  verifyNewsSnapshot,
} from '@crypto/news';
import { workingTreeVersion } from './database-fixtures.js';

export async function newsExtractCommand(args: string[]) {
  const flags = new Map<string, string | boolean>(),
    allowed = ['--provider', '--snapshot', '--ontology', '--field', '--persist'];
  for (let i = 1; i < args.length; i++) {
    const key = args[i];
    if (!key || !allowed.includes(key) || flags.has(key))
      throw new Error('Invalid extraction flags');
    if (key === '--persist') {
      flags.set(key, true);
      continue;
    }
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error('Missing extraction value');
    flags.set(key, value);
  }
  const snapshotPath = flags.get('--snapshot'),
    provider = flags.get('--provider') ?? 'fixture',
    field = flags.get('--field') ?? 'TITLE';
  if (
    provider !== 'fixture' ||
    (snapshotPath && flags.has('--provider')) ||
    !['TITLE', 'APPROVED_SNIPPET'].includes(String(field))
  )
    throw new Error('Invalid extraction input');
  const config = defaultNewsExtractionConfig(),
    ontologyPath = flags.get('--ontology');
  if (typeof ontologyPath === 'string') {
    const path = resolve(ontologyPath),
      info = await lstat(path);
    if (!info.isFile() || info.size > 65536) throw new Error('Ontology size');
    const text = await readFile(path, 'utf8');
    if (Buffer.byteLength(text) > 65536) throw new Error('Ontology size');
    config.ontology = NewsOntologySchema.parse(JSON.parse(text));
  }
  const extractor = new NewsClaimExtractor(
    new DeterministicNewsClaimAdapter(),
    config,
    { now: newsWallTime },
    await workingTreeVersion(),
  );
  let snapshotHash: string | null = null,
    inputs: unknown[];
  if (typeof snapshotPath === 'string') {
    const { artifact, hash } = await verifyNewsSnapshot(resolve(snapshotPath));
    snapshotHash = hash;
    if (artifact.result.articles.length > 100) throw new Error('Extraction batch limit');
    inputs = artifact.result.articles.map((article) => ({
      schemaVersion: 'news-extraction-input.v1',
      article,
      field,
      dataCutoff: artifact.request.decisionAt,
      source: artifact.input.registry.sources.find(
        (s) => canonicalHash(s) === article.version.sourceHash,
      ),
    }));
  } else inputs = (await newsExtractionFixtures()).map((row) => ({ ...row.input, field }));
  const results = [];
  for (const input of inputs) results.push(await extractor.extract(input));
  const batch = NewsExtractionBatchSchema.parse({
    schemaVersion: 'news-extraction-batch.v1',
    execution: 'DISABLED',
    snapshotHash,
    results,
  });
  let persistence;
  if (flags.has('--persist')) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('Database required');
    const db = new ResearchDatabase({
      connectionString,
      schema: process.env.DATABASE_SCHEMA ?? 'crypto_research',
    });
    try {
      persistence = [];
      for (const result of results) persistence.push(await persistNewsExtraction(db, result));
    } finally {
      await db.close();
    }
  }
  process.stdout.write(
    `${JSON.stringify({ ...batch, ...(persistence ? { persistence } : {}) }, null, 2)}\n`,
  );
}
