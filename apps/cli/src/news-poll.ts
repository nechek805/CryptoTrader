import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import { liveNewsConfig, PublicNewsProvider, newsWallTime } from '@crypto/connectors';
import { NewsPollJournal, NewsPoller, persistNewsStore } from '@crypto/news';
import { ResearchDatabase } from '@crypto/db';
import { utcNanoseconds } from '@crypto/contracts';
import { workingTreeVersion } from './database-fixtures.js';

export async function newsPollCommand(args: string[]) {
  const command = args[0],
    flags = new Map<string, string | boolean>();
  const boolean = ['--enable-live', '--enable-aggregation', '--persist'];
  const allowed =
    command === 'poll'
      ? [...boolean, '--duration-ms', '--journal']
      : command === 'poll-status'
        ? ['--journal', '--persist']
        : [];
  for (let i = 1; i < args.length; i++) {
    const flag = args[i];
    if (!flag || !allowed.includes(flag) || flags.has(flag)) throw new Error('Invalid poll flags');
    if (boolean.includes(flag)) flags.set(flag, true);
    else {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error('Invalid poll flag value');
      flags.set(flag, value);
    }
  }
  if (command === 'poll' && !flags.get('--enable-live'))
    throw new Error('Explicit live enable flag required');
  const durationText = flags.get('--duration-ms') ?? '15000';
  if (
    typeof durationText !== 'string' ||
    !/^\d+$/.test(durationText) ||
    Number(durationText) < 100 ||
    Number(durationText) > 60000
  )
    throw new Error('Invalid poll duration');
  const config = liveNewsConfig(),
    journal = await NewsPollJournal.acquire(
      resolve(
        typeof flags.get('--journal') === 'string'
          ? String(flags.get('--journal'))
          : 'data/news-live',
      ),
      config,
      await workingTreeVersion(),
    );
  try {
    const poller = new NewsPoller(journal, new PublicNewsProvider(), { now: newsWallTime });
    if (command === 'poll') {
      const selected = config.gates
        .filter(
          (g) =>
            g.role === 'OFFICIAL' ||
            (g.role === 'AGGREGATION' && flags.get('--enable-aggregation')),
        )
        .map((g) => g.sourceId);
      const end = Date.now() + Number(durationText),
        signal = AbortSignal.timeout(Number(durationText));
      let dispatched = 0;
      while (!signal.aborted && dispatched < (flags.has('--duration-ms') ? 100 : selected.length)) {
        if (await poller.step(selected, signal)) {
          dispatched++;
          continue;
        }
        const jobs = poller
          .report()
          .jobs.filter((j) => selected.includes(j.sourceId) && j.nextAt !== null);
        const next = jobs
          .map((j) => Number(utcNanoseconds(j.nextAt!) / 1000000n))
          .sort((a, b) => a - b)[0];
        if (next === undefined || next >= end) break;
        await delay(Math.min(500, Math.max(1, next - Date.now())));
      }
    }
    let persistence;
    if (flags.get('--persist')) {
      const connectionString = process.env.DATABASE_URL;
      if (!connectionString) throw new Error('Database required');
      const db = new ResearchDatabase({
        connectionString,
        schema: process.env.DATABASE_SCHEMA ?? 'crypto_research',
      });
      try {
        persistence = await persistNewsStore(db, poller.store);
      } finally {
        await db.close();
      }
    }
    process.stdout.write(
      `${JSON.stringify({ ...poller.report(), origin: 'PUBLIC_READ_ONLY', enabledAggregation: !!flags.get('--enable-aggregation'), ...(persistence ? { persistence } : {}) }, null, 2)}\n`,
    );
  } finally {
    await journal.close();
  }
}
