import { randomBytes } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { buildNewsReviewApp } from '@crypto/api';
import { newsWallTime } from '@crypto/connectors';
import { ResearchDatabase } from '@crypto/db';
import {
  NewsCorrectionJournal,
  NewsReviewService,
  persistNewsCorrections,
  verifyNewsSnapshot,
  writeNewsSnapshot,
} from '@crypto/news';
import { workingTreeVersion } from './database-fixtures.js';
import { loadNewsReviewStore } from './news-input.js';

async function boundedFile(path: string, limit: number) {
  const info = await lstat(path);
  if (!info.isFile() || info.size > limit) throw new Error('Invalid review input');
  const value = await readFile(path, 'utf8');
  if (Buffer.byteLength(value) > limit) throw new Error('Review input limit');
  return value;
}
export async function newsReviewCommand(args: string[]) {
  const command = args[0],
    common = ['--provider', '--journal', '--review-dir'],
    allowed =
      command === 'verify-snapshot'
        ? ['--artifact']
        : command === 'review-correct'
          ? [...common, '--request']
          : command === 'review-persist'
            ? common
            : command === 'serve-review'
              ? [...common, '--port']
              : command === 'snapshot'
                ? [...common, '--at', '--mode', '--allow-estimated', '--out']
                : command === 'review' || command === 'coverage'
                  ? [...common, '--at']
                  : [];
  const flags = new Map<string, string | boolean>();
  for (let i = 1; i < args.length; i++) {
    const key = args[i];
    if (!key || !allowed.includes(key) || flags.has(key)) throw new Error('Invalid review flags');
    if (key === '--allow-estimated') {
      flags.set(key, true);
      continue;
    }
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error('Invalid review flag value');
    flags.set(key, value);
  }
  const text = (key: string, fallback?: string) => {
    const value = flags.get(key) ?? fallback;
    if (typeof value !== 'string' || !value) throw new Error('Missing review flag');
    return value;
  };
  const print = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  if (command === 'verify-snapshot') {
    const result = await verifyNewsSnapshot(resolve(text('--artifact')));
    print({
      schemaVersion: 'news-snapshot-verification.v1',
      verified: true,
      hash: result.hash,
      inputHash: result.artifact.inputHash,
      articles: result.artifact.result.articles.length,
    });
    return;
  }
  const provider = text('--provider', 'fixture');
  if (!['fixture', 'live'].includes(provider)) throw new Error('Unknown provider');
  if (provider === 'fixture' && flags.has('--journal'))
    throw new Error('Fixture does not use a live journal');
  const codeVersion = await workingTreeVersion(),
    store = await loadNewsReviewStore(
      provider,
      resolve(text('--journal', 'data/news-live')),
      codeVersion,
    ),
    root = resolve(text('--review-dir', `data/news-review-${provider}`)),
    journal = await NewsCorrectionJournal.acquire(root);
  let handedOff = false;
  try {
    const service = new NewsReviewService(
        store,
        journal.records,
        { now: newsWallTime },
        codeVersion,
        journal,
      ),
      decisionAt = text('--at', newsWallTime());
    if (command === 'serve-review') {
      const port = text('--port', '3002');
      if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)
        throw new Error('Invalid port');
      const tokenPath = join(root, 'review-token.txt');
      try {
        await writeFile(tokenPath, `${randomBytes(32).toString('hex')}\n`, {
          flag: 'wx',
          mode: 0o600,
        });
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      }
      const token = (await boundedFile(tokenPath, 100)).trim(),
        app = buildNewsReviewApp(service, token);
      app.addHook('onClose', async () => {
        await journal.close();
      });
      await app.listen({ host: '127.0.0.1', port: Number(port) });
      const close = () => {
        void app.close();
      };
      process.once('SIGINT', close);
      process.once('SIGTERM', close);
      handedOff = true;
      print({
        schemaVersion: 'news-review-service.v1',
        origin: provider === 'fixture' ? 'SYNTHETIC' : 'PUBLIC_READ_ONLY',
        execution: 'DISABLED',
        url: `http://127.0.0.1:${port}`,
        tokenPath,
        correctionHeadHash: service.headHash(),
      });
    } else if (command === 'review-correct') {
      print(
        await service.correct(JSON.parse(await boundedFile(resolve(text('--request')), 16384))),
      );
    } else if (command === 'review-persist') {
      const connectionString = process.env.DATABASE_URL;
      if (!connectionString) throw new Error('Database required');
      const db = new ResearchDatabase({
        connectionString,
        schema: process.env.DATABASE_SCHEMA ?? 'crypto_research',
      });
      try {
        print(await persistNewsCorrections(db, service));
      } finally {
        await db.close();
      }
    } else if (command === 'snapshot') {
      const result = await writeNewsSnapshot(
        store,
        service.records(),
        {
          decisionAt,
          generatedAt: newsWallTime(),
          mode: text('--mode', 'RESEARCH'),
          allowEstimated: !!flags.get('--allow-estimated'),
        },
        resolve(text('--out', 'data/news-snapshots')),
        codeVersion,
      );
      print({
        schemaVersion: 'news-snapshot-export.v1',
        execution: 'DISABLED',
        path: result.path,
        hash: result.hash,
        inputHash: result.artifact.inputHash,
        articles: result.artifact.result.articles.length,
        coverage: result.artifact.coverage,
      });
    } else if (command === 'review') print(service.queue({ decisionAt }));
    else if (command === 'coverage') print(service.coverage({ decisionAt }));
    else throw new Error('Invalid review command');
  } finally {
    if (!handedOff) await journal.close();
  }
}
