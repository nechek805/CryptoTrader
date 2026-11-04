import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, link, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  TrialRunSchema,
  TrialAnnotationSchema,
  PaperEventSchema,
  UtcTimestampSchema,
} from '@crypto/contracts';
import type { PaperEvent, TrialAnnotation } from '@crypto/contracts';
import { canonicalHash, canonicalJson } from '@crypto/core';
import { initializePaperStore, loadPaperStore, runPaperSession, PaperBroker } from '@crypto/paper';
import { enqueuePaperEvent } from '@crypto/paper';
import { validateNewsEventSnapshot } from '@crypto/news';
import {
  verifyExperimentManifest,
  experimentPaperConfig,
  assertExperimentLaunch,
} from './experiment-protocol.js';
import {
  verifyTrialRun,
  guardExperimentEvent,
  guardForwardReceipt,
  processTrialReceipt,
  TrialSourceBindingSchema,
} from './experiment-runtime.js';

export async function publishTrialJson(directory: string, name: string, value: unknown) {
  if (!/^(manifest|run|assessment|session|finish|[0-9]{8}-[a-f0-9]{64})\.json$/.test(name))
    throw new Error('Invalid trial artifact name');
  await mkdir(directory, { recursive: true });
  if ((await lstat(directory)).isSymbolicLink()) throw new Error('Symlink trial output');
  const target = join(directory, name),
    bytes = `${canonicalJson(value)}\n`;
  try {
    if ((await lstat(target)).isSymbolicLink()) throw new Error('Symlink trial artifact');
    if ((await readFile(target, 'utf8')) === bytes) return;
    throw new Error('Immutable trial artifact conflict');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const temporary = join(directory, `.trial-stage-${randomUUID()}`),
    file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await link(temporary, target);
  } finally {
    await unlink(temporary);
  }
}
export async function readTrialJson(path: string, limit = 256 * 1024 * 1024): Promise<unknown> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit)
    throw new Error('Invalid bounded trial file');
  const bytes = await readFile(path);
  if (bytes.length > limit) throw new Error('Trial byte limit');
  return JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)) as unknown;
}
export async function initializeTrialStore(directory: string, input: unknown) {
  const m = verifyExperimentManifest(input);
  await mkdir(directory, { recursive: true });
  if ((await lstat(directory)).isSymbolicLink() || (await readdir(directory)).length)
    throw new Error('Trial requires empty directory');
  await publishTrialJson(directory, 'manifest.json', m);
  await mkdir(join(directory, 'annotations'));
  await mkdir(join(directory, 'source-evidence'));
  await initializePaperStore(join(directory, 'paper'), experimentPaperConfig(m));
}
export async function appendTrialAnnotation(directory: string, input: unknown) {
  const value = TrialAnnotationSchema.parse(input),
    path = join(directory, 'annotations'),
    lockPath = join(path, '.writer.lock'),
    lock = await open(lockPath, 'wx', 0o600);
  try {
    await lock.writeFile(canonicalJson({ pid: process.pid }));
    await lock.sync();
    const names = (await readdir(path)).filter((n) => !n.startsWith('.')).sort();
    if (names.length >= 10000) throw new Error('Trial annotation budget');
    await publishTrialJson(
      path,
      `${String(names.length + 1).padStart(8, '0')}-${canonicalHash(value).slice(7)}.json`,
      value,
    );
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}
export async function readTrialAnnotations(directory: string) {
  const path = join(directory, 'annotations'),
    names = (await readdir(path)).filter((n) => !n.startsWith('.')).sort(),
    result: TrialAnnotation[] = [];
  if (names.length > 10000) throw new Error('Trial annotation budget');
  for (const [index, name] of names.entries()) {
    if (!/^[0-9]{8}-[a-f0-9]{64}\.json$/.test(name))
      throw new Error('Invalid trial annotation inventory');
    const value = TrialAnnotationSchema.parse(await readTrialJson(join(path, name), 1024 * 1024));
    if (name !== `${String(index + 1).padStart(8, '0')}-${canonicalHash(value).slice(7)}.json`)
      throw new Error('Trial annotation integrity');
    result.push(value);
  }
  return result;
}
export async function loadTrialStore(directory: string) {
  const manifest = verifyExperimentManifest(
      await readTrialJson(join(directory, 'manifest.json'), 1024 * 1024),
    ),
    paper = (await loadPaperStore(join(directory, 'paper'))).report(),
    annotations = await readTrialAnnotations(directory);
  let startedAt = null,
    finishedAt = null;
  if (manifest.protocol.origin === 'PUBLIC_READ_ONLY') {
    const session = (await readTrialJson(join(directory, 'session.json'), 1024)) as {
      wallClockStartedAt?: unknown;
    };
    startedAt = UtcTimestampSchema.parse(session.wallClockStartedAt);
    if (paper.status === 'STOPPED') {
      try {
        const finish = (await readTrialJson(join(directory, 'finish.json'), 1024)) as {
          wallClockFinishedAt?: unknown;
        };
        finishedAt = UtcTimestampSchema.parse(finish.wallClockFinishedAt);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    }
  }
  const newsSnapshots = [];
  for (const name of (await readdir(join(directory, 'source-evidence'))).filter(
    (n) => !n.startsWith('.trial-stage-'),
  )) {
    if (!/^00000000-[a-f0-9]{64}\.json$/.test(name) || newsSnapshots.length >= 1000)
      throw new Error('Trial source evidence inventory');
    const snapshot = validateNewsEventSnapshot(
      await readTrialJson(join(directory, 'source-evidence', name), 16 * 1024 * 1024),
    );
    if (name !== `00000000-${canonicalHash(snapshot).slice(7)}.json`)
      throw new Error('Trial source evidence integrity');
    newsSnapshots.push(snapshot);
  }
  return verifyTrialRun({
    schemaVersion: 'trial-run.v1',
    manifest,
    paper,
    annotations,
    newsSnapshots,
    wallClockStartedAt: startedAt,
    wallClockFinishedAt: finishedAt,
  });
}
export interface TrialSessionPorts {
  now: () => string;
  sourceBindings: unknown[];
  source: (broker: PaperBroker) => AsyncIterable<PaperEvent>;
}
/** Read-only acquisition and candidate ports; no exchange-order transport exists. */
export async function runRegisteredExperiment(
  directory: string,
  input: unknown,
  codeVersion: string,
  ports: TrialSessionPorts,
  resume = false,
) {
  const m = verifyExperimentManifest(input),
    now = UtcTimestampSchema.parse(ports.now());
  if (m.protocol.origin !== 'PUBLIC_READ_ONLY')
    throw new Error('Synthetic protocol is not a forward launch');
  const expected = m.protocol.providers
      .map((s) => ({
        sourceId: s.id,
        adapterHash: s.adapterHash,
        adapterVersion: s.adapterVersion,
      }))
      .sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
    actual = ports.sourceBindings
      .map((s) => TrialSourceBindingSchema.parse(s))
      .sort((a, b) => a.sourceId.localeCompare(b.sourceId));
  if (canonicalHash(expected) !== canonicalHash(actual) || codeVersion !== m.protocol.codeVersion)
    throw new Error('Runtime adapter or code binding mismatch');
  if (!resume) {
    assertExperimentLaunch(m, codeVersion, now);
    await initializeTrialStore(directory, m);
    await publishTrialJson(directory, 'session.json', { wallClockStartedAt: now });
  }
  const before = await loadTrialStore(directory);
  if (
    before.manifest.hash !== m.hash ||
    before.paper.status === 'KILLED' ||
    before.paper.status === 'STOPPED' ||
    now < m.protocol.paper.startAt ||
    now >= m.protocol.paper.endAt
  )
    throw new Error('Cannot resume terminal or changed trial');
  await appendTrialAnnotation(directory, {
    schemaVersion: 'trial-annotation.v1',
    id: `session:${randomUUID()}`,
    at: before.paper.now,
    kind: resume ? 'RESTART' : 'SESSION_START',
    sourceId: null,
    referenceHash: before.paper.logHead,
    intervalStart: resume ? before.paper.now : null,
    intervalEnd: resume ? before.paper.now : null,
    affectedCandidateIds: [],
    outcome: resume ? 'RECOVERED_FROM_COMMITTED_PREFIX' : 'RECORDED',
  });
  const report = await runPaperSession(
    join(directory, 'paper'),
    async function* (broker) {
      if (resume && broker.operationalStatus().status === 'PAUSED')
        yield PaperEventSchema.parse({
          kind: 'CONTROL',
          id: `resume:${randomUUID()}`,
          at: now,
          action: 'RESUME',
          actor: 'experiment:supervisor',
          reason: 'Explicit verified same-manifest restart',
        });
      for await (const event of ports.source(broker)) yield event;
      const end = UtcTimestampSchema.parse(ports.now());
      if (broker.operationalStatus().status === 'RUNNING' && end < m.protocol.paper.endAt)
        yield PaperEventSchema.parse({
          kind: 'CONTROL',
          id: `source-ended:${randomUUID()}`,
          at: end,
          requestedAt: end,
          action: 'PAUSE',
          actor: 'experiment:supervisor',
          reason: 'Input service stopped; no inferred prices',
        });
    },
    async (event, broker) => {
      guardForwardReceipt(event, ports.now(), m);
      const hash =
        event.kind === 'PROPOSE' &&
        event.decision.request.risk.candidate.side !== 'HOLD' &&
        ['NEWS_ONLY', 'FUSION'].includes(event.decision.request.risk.candidate.portfolio)
          ? event.decision.request.sourceSnapshotHash
          : null;
      const snapshot = hash
        ? await readTrialJson(
            join(directory, 'source-evidence', `00000000-${hash.slice(7)}.json`),
            16 * 1024 * 1024,
          )
        : undefined;
      guardExperimentEvent(m, event, broker, snapshot);
    },
  );
  if (report.status === 'STOPPED')
    await publishTrialJson(directory, 'finish.json', {
      wallClockFinishedAt: UtcTimestampSchema.parse(ports.now()),
    });
  return TrialRunSchema.parse({ ...(await loadTrialStore(directory)), paper: report });
}

export async function submitTrialEvent(
  directory: string,
  input: unknown,
  now: string,
  newsInput?: unknown,
) {
  const run = await loadTrialStore(directory),
    event = processTrialReceipt(input, now, run.manifest),
    broker = new PaperBroker(run.paper.config);
  for (const l of run.paper.log) broker.consume(l.event);
  guardForwardReceipt(event, now, run.manifest);
  guardExperimentEvent(run.manifest, event, broker, newsInput);
  if (newsInput !== undefined) {
    const s = validateNewsEventSnapshot(newsInput);
    await publishTrialJson(
      join(directory, 'source-evidence'),
      `00000000-${canonicalHash(s).slice(7)}.json`,
      s,
    );
  }
  return enqueuePaperEvent(join(directory, 'paper'), event);
}
