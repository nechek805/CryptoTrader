import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { canonicalHash, utc } from '@crypto/core';
import { PaperConfigSchema, PaperEventSchema } from '@crypto/contracts';
import { publicPaperFeed } from '@crypto/connectors';
import {
  initializePaperStore,
  loadPaperStore,
  enqueuePaperEvent,
  appendPaperEvent,
  runPaperSession,
  paperSoakFixture,
  savePaperSnapshot,
  exportPaperTransactions,
  recoverPaperWriter,
  backupPaperStore,
} from '@crypto/paper';
import { workingTreeVersion } from './database-fixtures.js';

async function main(args: string[]) {
  const command = args[0],
    valid = [
      'start',
      'status',
      'stop',
      'pause',
      'resume',
      'kill',
      'replay',
      'snapshot',
      'export',
      'recover',
      'backup',
    ];
  if (!valid.includes(command ?? '')) throw new Error('Invalid paper command');
  const allowed =
    command === 'start'
      ? ['--directory', '--manifest', '--feed', '--resume']
      : command === 'backup'
        ? ['--directory', '--destination']
        : ['--directory'];
  const opts = new Map<string, string>();
  for (let i = 1; i < args.length; i += 2) {
    const k = args[i]!,
      v = args[i + 1];
    if (!allowed.includes(k) || opts.has(k) || !v || v.startsWith('--'))
      throw new Error('Invalid paper option');
    opts.set(k, v);
  }
  const directory = opts.get('--directory');
  if (!directory) throw new Error('Paper directory required');
  if (command === 'backup') {
    if (!opts.has('--destination')) throw new Error('Backup destination required');
    process.stdout.write(
      `${JSON.stringify(await backupPaperStore(directory, opts.get('--destination')!))}\n`,
    );
    return;
  }
  if (command === 'start') {
    const initialize = async (config: unknown) => {
      if (!opts.has('--resume')) {
        await initializePaperStore(directory, config);
        return;
      }
      if (opts.get('--resume') !== 'true') throw new Error('Resume must be explicit true');
      const old = (await loadPaperStore(directory)).report();
      if (
        old.configHash !== canonicalHash(config) ||
        old.status === 'KILLED' ||
        old.status === 'STOPPED'
      )
        throw new Error('Cannot resume changed or terminal paper manifest');
    };
    const feed = opts.get('--feed') ?? 'synthetic';
    if (feed === 'synthetic') {
      if (opts.has('--manifest'))
        throw new Error('Synthetic recipe cannot silently replace a supplied manifest');
      const f = paperSoakFixture(await workingTreeVersion());
      await initialize(f.config);
      const report = await runPaperSession(directory, () => f.events);
      process.stdout.write(
        `${JSON.stringify({
          execution: report.execution,
          origin: report.config.origin,
          status: report.status,
          virtualHours: 24,
          events: report.log.length,
          fills: report.fills.length,
          logHead: report.logHead,
          ledgerReconciled: report.ledgerReconciled,
        })}\n`,
      );
      return;
    }
    if (feed !== 'public' || !opts.has('--manifest'))
      throw new Error('Explicit public manifest required');
    const bytes = await readFile(opts.get('--manifest')!);
    if (bytes.length > 131072) throw new Error('Paper manifest too large');
    const config = PaperConfigSchema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    );
    if (config.origin !== 'PUBLIC_READ_ONLY') throw new Error('Public feed origin mismatch');
    if (config.codeVersion !== (await workingTreeVersion()))
      throw new Error('Code changed since public paper freeze');
    await initialize(config);
    const controller = new AbortController(),
      abort = () => controller.abort();
    process.once('SIGINT', abort);
    process.once('SIGTERM', abort);
    try {
      const r = await runPaperSession(directory, (b) =>
        publicPaperFeed(config, controller.signal, () => b.executionInterest()),
      );
      process.stdout.write(
        `${JSON.stringify({ status: r.status, logHead: r.logHead, execution: r.execution, liveExecution: r.liveExecution })}\n`,
      );
    } finally {
      process.removeListener('SIGINT', abort);
      process.removeListener('SIGTERM', abort);
    }
    return;
  }
  if (command === 'recover') {
    await recoverPaperWriter(directory);
    process.stdout.write('Paper writer lock recovered.\n');
    return;
  }
  if (command === 'snapshot') {
    process.stdout.write(`${await savePaperSnapshot(directory)}\n`);
    return;
  }
  if (command === 'export') {
    process.stdout.write(`${JSON.stringify(await exportPaperTransactions(directory))}\n`);
    return;
  }
  const report = (await loadPaperStore(directory)).report();
  if (['stop', 'pause', 'resume', 'kill'].includes(command!)) {
    if (report.status === 'STOPPED') {
      process.stdout.write('{"status":"STOPPED"}\n');
      return;
    }
    const event = PaperEventSchema.parse({
      kind: 'CONTROL',
      id: `operator:${randomUUID()}`,
      at: report.now,
      requestedAt: utc(new Date().toISOString()),
      actor: 'local:operator',
      reason: `Explicit paper ${command}`,
      action: (
        { stop: 'STOP', pause: 'PAUSE', resume: 'RESUME', kill: 'KILL' } as Record<string, string>
      )[command!],
    });
    try {
      const r = await appendPaperEvent(directory, event);
      process.stdout.write(`${JSON.stringify({ status: r.status })}\n`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      process.stdout.write(
        `${JSON.stringify({ queued: await enqueuePaperEvent(directory, event) })}\n`,
      );
    }
    return;
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        execution: report.execution,
        liveExecution: report.liveExecution,
        origin: report.config.origin,
        status: report.status,
        now: report.now,
        events: report.log.length,
        fills: report.fills.length,
        alerts: report.alerts.length,
        balances: report.balances,
        ledgerReconciled: report.ledgerReconciled,
        logHead: report.logHead,
        reportHash: canonicalHash(report),
      },
      null,
      2,
    )}\n`,
  );
}
main(process.argv.slice(2)).catch(() => {
  process.stderr.write(
    'Paper operation failed: configuration, eligibility, time, writer lock or journal integrity.\n',
  );
  process.exitCode = 1;
});
