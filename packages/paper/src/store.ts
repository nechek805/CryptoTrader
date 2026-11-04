import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, readdir, unlink } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import {
  PaperConfigSchema,
  PaperEventSchema,
  PaperLogSchema,
  PaperReportSchema,
} from '@crypto/contracts';
import type { PaperEvent, PaperReport } from '@crypto/contracts';
import { canonicalHash, canonicalJson } from '@crypto/core';
import { PaperBroker, verifyPaperReport } from './broker.js';

async function readJson(path: string, limit = 256 * 1024 * 1024): Promise<unknown> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit)
    throw new Error('Invalid paper journal file');
  const data = await readFile(path);
  if (data.length > limit) throw new Error('Paper file limit');
  return JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(data)) as unknown;
}
/** Sync a complete staging file, then publish by exclusive hard link. Torn/uncommitted staging is ignored. */
async function publish(directory: string, name: string, value: unknown) {
  const staging = join(directory, `.paper-stage-${randomUUID()}`),
    target = join(directory, name),
    file = await open(staging, 'wx', 0o600);
  try {
    await file.writeFile(`${canonicalJson(value)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await link(staging, target);
  } finally {
    await unlink(staging);
  }
}
export async function initializePaperStore(directory: string, configInput: unknown) {
  const config = PaperConfigSchema.parse(configInput);
  new PaperBroker(config);
  await mkdir(directory, { recursive: true });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error('Invalid paper store directory');
  if ((await readdir(directory)).length !== 0)
    throw new Error('Paper initialization requires an empty directory');
  await mkdir(join(directory, 'events'));
  await mkdir(join(directory, 'snapshots'));
  await mkdir(join(directory, 'requests'));
  await publish(directory, 'config.json', config);
  return loadPaperStore(directory);
}
export async function loadPaperStore(directory: string): Promise<PaperBroker> {
  const config = PaperConfigSchema.parse(await readJson(join(directory, 'config.json'), 131072)),
    broker = new PaperBroker(config),
    names = (await readdir(join(directory, 'events')))
      .filter((n) => !n.startsWith('.paper-stage-'))
      .sort();
  if (names.length > 200000) throw new Error('Paper event count limit');
  for (const [index, name] of names.entries()) {
    if (!/^\d{8}-[a-f0-9]{64}\.json$/.test(name)) throw new Error('Unknown paper event file');
    const saved = PaperLogSchema.parse(
        await readJson(join(directory, 'events', name), 2 * 1024 * 1024),
      ),
      rebuilt = broker.consume(saved.event);
    if (
      !rebuilt ||
      saved.sequence !== index + 1 ||
      name !== `${String(saved.sequence).padStart(8, '0')}-${saved.hash.slice(7)}.json` ||
      canonicalHash(saved) !== canonicalHash(rebuilt)
    )
      throw new Error('Paper event replay integrity');
  }
  return broker;
}
export async function appendPaperEvent(directory: string, event: unknown) {
  const lockPath = join(directory, '.writer.lock'),
    lock = await open(lockPath, 'wx', 0o600);
  try {
    await lock.writeFile(canonicalJson({ pid: process.pid }));
    await lock.sync();
    const broker = await loadPaperStore(directory),
      record = broker.consume(event);
    if (record)
      await publish(
        join(directory, 'events'),
        `${String(record.sequence).padStart(8, '0')}-${record.hash.slice(7)}.json`,
        record,
      );
    return broker.report();
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}
export async function savePaperSnapshot(directory: string) {
  const report = (await loadPaperStore(directory)).report(),
    name = `${String(report.log.length).padStart(8, '0')}-${report.logHead.slice(7)}.json`;
  await publish(join(directory, 'snapshots'), name, report);
  return join(directory, 'snapshots', name);
}
export async function restorePaperSnapshot(
  directory: string,
  snapshotPath: string,
): Promise<PaperReport> {
  const snapshot = verifyPaperReport(PaperReportSchema.parse(await readJson(snapshotPath))),
    live = (await loadPaperStore(directory)).report();
  if (
    snapshot.configHash !== live.configHash ||
    snapshot.log.length > live.log.length ||
    canonicalHash(snapshot.log) !== canonicalHash(live.log.slice(0, snapshot.log.length))
  )
    throw new Error('Snapshot is not a committed run prefix');
  return live;
}
export async function exportPaperTransactions(directory: string) {
  const report = (await loadPaperStore(directory)).report();
  return {
    schemaVersion: 'paper-transaction-export.v1',
    execution: 'SIMULATED',
    manifestHash: report.config.runManifestHash,
    configHash: report.configHash,
    logHead: report.logHead,
    fills: report.fills,
    journal: report.journal,
    balances: report.balances,
  };
}
/** Explicit operator recovery for a process crash. Never steals a lock from a live writer. */
export async function recoverPaperWriter(directory: string) {
  const lockPath = resolve(directory, '.writer.lock');
  if (
    resolve(directory) === lockPath ||
    (!lockPath.startsWith(`${resolve(directory)}\\`) &&
      !lockPath.startsWith(`${resolve(directory)}/`))
  )
    throw new Error('Invalid recovery lock path');
  // Recovery is refused unless the lock contains an attributable PID and that PID no longer exists.
  const owner = (await readJson(lockPath, 1024)) as { pid?: unknown };
  if (!Number.isInteger(owner.pid) || Number(owner.pid) <= 0)
    throw new Error('Unknown lock owner; inspect manually');
  try {
    process.kill(Number(owner.pid), 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
      throw new Error('Cannot prove paper writer stopped', { cause: error });
    await unlink(lockPath);
    return;
  }
  throw new Error('Paper writer still running');
}
export async function writePaperEventBatch(directory: string, events: PaperEvent[]) {
  // One writer owns the complete finite batch; each event is independently synced and committed.
  const lockPath = join(directory, '.writer.lock'),
    lock = await open(lockPath, 'wx', 0o600);
  try {
    await lock.writeFile(canonicalJson({ pid: process.pid }));
    await lock.sync();
    const broker = await loadPaperStore(directory);
    for (const input of events) {
      const e = PaperEventSchema.parse(input),
        record = broker.consume(e);
      if (record)
        await publish(
          join(directory, 'events'),
          `${String(record.sequence).padStart(8, '0')}-${record.hash.slice(7)}.json`,
          record,
        );
    }
    return broker.report();
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

/** Replay-verified committed prefix backup. Pending requests are deliberately not replayed. */
export async function backupPaperStore(directory: string, destination: string) {
  const source = resolve(directory).toLowerCase(),
    target = resolve(destination).toLowerCase();
  if (source === target || target.startsWith(source + sep) || source.startsWith(target + sep))
    throw new Error('Backup requires a separate empty directory');
  const original = (await loadPaperStore(directory)).report();
  await initializePaperStore(destination, original.config);
  const restored = await writePaperEventBatch(
    destination,
    original.log.map((l) => l.event),
  );
  if (canonicalHash(restored) !== canonicalHash(original))
    throw new Error('Backup replay mismatch');
  await savePaperSnapshot(destination);
  return {
    schemaVersion: 'paper-backup.v1',
    reportHash: canonicalHash(restored),
    logHead: restored.logHead,
    events: restored.log.length,
    execution: 'SIMULATED',
    pendingRequestsIncluded: false,
  };
}

export async function enqueuePaperEvent(directory: string, input: unknown) {
  const event = PaperEventSchema.parse(input);
  if (!['CONTROL', 'CANCEL', 'PROPOSE', 'HEARTBEAT'].includes(event.kind))
    throw new Error('Only operator/producer requests may be queued');
  const name = `request-${canonicalHash(event).slice(7)}.json`;
  await publish(join(directory, 'requests'), name, event);
  return { id: event.id, requestHash: canonicalHash(event) };
}
/** Persistent single-writer service. Source factory may bind a public read-only adapter or explicit synthetic inputs. */
export async function runPaperSession(
  directory: string,
  source: (broker: PaperBroker) => Iterable<PaperEvent> | AsyncIterable<PaperEvent>,
  validateEvent: (event: PaperEvent, broker: PaperBroker) => void | Promise<void> = () => {},
) {
  const lockPath = join(directory, '.writer.lock'),
    lock = await open(lockPath, 'wx', 0o600);
  try {
    await lock.writeFile(canonicalJson({ pid: process.pid }));
    await lock.sync();
    const broker = await loadPaperStore(directory),
      initial = broker.report(),
      processed = new Set(initial.log.map((l) => l.event.id));
    let day = initial.now.slice(0, 10);
    const commit = async (event: PaperEvent) => {
      await validateEvent(event, broker);
      const record = broker.consume(event);
      if (record)
        await publish(
          join(directory, 'events'),
          `${String(record.sequence).padStart(8, '0')}-${record.hash.slice(7)}.json`,
          record,
        );
    };
    for await (const e of source(broker)) {
      const names = (await readdir(join(directory, 'requests'))).sort();
      if (names.length > 10000) throw new Error('Paper request budget');
      for (const name of names) {
        if (!/^request-[a-f0-9]{64}\.json$/.test(name))
          throw new Error('Invalid paper request file');
        const queued = PaperEventSchema.parse(
          await readJson(join(directory, 'requests', name), 2 * 1024 * 1024),
        );
        if (name !== `request-${canonicalHash(queued).slice(7)}.json`)
          throw new Error('Paper request integrity');
        if (processed.has(queued.id) || queued.at > e.at) continue;
        await commit(
          PaperEventSchema.parse({
            ...queued,
            at: e.at,
            ...(queued.kind === 'CONTROL' ? { requestedAt: queued.requestedAt ?? queued.at } : {}),
          }),
        );
        processed.add(queued.id);
        if (queued.kind === 'CONTROL' && queued.action === 'STOP') return broker.report();
      }
      await commit(e);
      if (e.at.slice(0, 10) !== day && !(e.kind === 'CONTROL' && e.action === 'STOP')) {
        day = e.at.slice(0, 10);
        await commit(
          PaperEventSchema.parse({ kind: 'RECONCILE', id: `reconcile:${day}`, at: e.at }),
        );
      }
      if (e.kind === 'CONTROL' && e.action === 'STOP') break;
      const size = broker.operationalStatus();
      if (size.events >= 199900 || size.orders >= 9900 || size.fills >= 49900) {
        await commit(
          PaperEventSchema.parse({
            kind: 'CONTROL',
            id: `budget-stop:${size.events}`,
            at: size.now,
            action: 'KILL',
            actor: 'paper:supervisor',
            reason: 'Frozen work budget exhausted; new experiment required',
          }),
        );
        break;
      }
    }
    const end = broker.operationalStatus();
    if (end.status === 'RUNNING')
      await commit(
        PaperEventSchema.parse({
          kind: 'CONTROL',
          id: `source-ended:${end.events}`,
          at: end.now,
          action: 'PAUSE',
          actor: 'paper:supervisor',
          reason: 'Source ended or interrupted; no inferred prices',
        }),
      );
    return broker.report();
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}
