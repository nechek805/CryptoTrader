import { open, readFile, readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { PaperEventSchema, UtcTimestampSchema } from '@crypto/contracts';
import { canonicalHash } from '@crypto/core';
import {
  parseExperimentYaml,
  experimentYaml,
  experimentProtocolFixture,
  freezeExperiment,
  verifyExperimentManifest,
  assertExperimentLaunch,
  experimentExercise,
  writeTrialBundle,
  verifyTrialBundle,
  publishTrialJson,
  readTrialJson,
  loadTrialStore,
  submitTrialEvent,
  runRegisteredExperiment,
  processTrialReceipt,
} from '@crypto/evaluation';
import { workingTreeVersion } from './database-fixtures.js';

async function main(args: string[]) {
  const command = args[0],
    opts = new Map<string, string>(),
    allowed: Record<string, string[]> = {
      template: ['--output'],
      freeze: ['--protocol', '--directory'],
      'dry-run': ['--manifest'],
      exercise: ['--output'],
      verify: ['--directory'],
      report: ['--directory', '--output'],
      status: ['--directory'],
      submit: ['--directory', '--event', '--news-snapshot'],
      launch: ['--directory', '--manifest', '--inbox', '--bindings', '--resume'],
    };
  if (!command || !allowed[command]) throw new Error('Invalid experiment command');
  for (let i = 1; i < args.length; i += 2) {
    const key = args[i]!,
      value = args[i + 1];
    if (!allowed[command].includes(key) || opts.has(key) || !value || value.startsWith('--'))
      throw new Error('Invalid experiment argument');
    opts.set(key, value);
  }
  const need = (key: string) => {
    const value = opts.get(key);
    if (!value) throw new Error('Missing experiment option');
    return value;
  };
  if (command === 'template') {
    const text = experimentYaml(experimentProtocolFixture(await workingTreeVersion())),
      file = await open(need('--output'), 'wx', 0o600);
    try {
      await file.writeFile(text);
      await file.sync();
    } finally {
      await file.close();
    }
    process.stdout.write(
      'Wrote SYNTHETIC protocol template; not eligible for a public forward launch.\n',
    );
    return;
  }
  if (command === 'freeze') {
    const path = need('--protocol');
    if ((await lstat(path)).size > 1024 * 1024) throw new Error('Protocol byte limit');
    const m = freezeExperiment(parseExperimentYaml(await readFile(path, 'utf8')));
    if (m.protocol.codeVersion !== (await workingTreeVersion()))
      throw new Error('Code changed since protocol preparation');
    await publishTrialJson(need('--directory'), 'manifest.json', m);
    process.stdout.write(
      `${JSON.stringify({ id: m.manifest.id, hash: m.hash, origin: m.protocol.origin })}\n`,
    );
    return;
  }
  if (command === 'dry-run') {
    const m = verifyExperimentManifest(await readTrialJson(need('--manifest'), 1024 * 1024)),
      code = await workingTreeVersion();
    let launchEligible = false;
    try {
      assertExperimentLaunch(m, code, new Date().toISOString());
      launchEligible = true;
    } catch {
      /* Reasons remain bounded, no provider content echoed. */
    }
    process.stdout.write(
      `${JSON.stringify({ valid: true, immutableHash: m.hash, id: m.manifest.id, execution: 'SIMULATED', origin: m.protocol.origin, codeUnchanged: code === m.protocol.codeVersion, launchEligible, checks: ['HASHED_PROTOCOL', 'FOUR_VERSIONED_MODELS', 'ADAPTER_AND_RIGHTS_EVIDENCE', 'UTC_30_DAY_CALENDAR', 'FROZEN_RISK_AND_COSTS', 'POINT_IN_TIME_GATES'], limitation: 'Eligibility includes current start window and public rights; synthetic recipes cannot launch a real forward study' })}\n`,
    );
    return;
  }
  if (command === 'exercise') {
    const result = await writeTrialBundle(
      experimentExercise(await workingTreeVersion()),
      need('--output'),
    );
    process.stdout.write(
      `${JSON.stringify({ directory: result.directory, hash: result.assessment.hash, recommendation: result.assessment.recommendation, origin: 'SYNTHETIC', actualElapsed30Days: false, events: result.run.paper.log.length, fills: result.run.paper.fills.length, ledgerReconciled: result.run.paper.ledgerReconciled })}\n`,
    );
    return;
  }
  if (command === 'verify') {
    const r = await verifyTrialBundle(need('--directory'));
    process.stdout.write(
      `${JSON.stringify({ valid: true, hash: r.assessment.hash, recommendation: r.assessment.recommendation })}\n`,
    );
    return;
  }
  if (command === 'report') {
    const r = await writeTrialBundle(await loadTrialStore(need('--directory')), need('--output'));
    process.stdout.write(
      `${JSON.stringify({ directory: r.directory, hash: r.assessment.hash })}\n`,
    );
    return;
  }
  if (command === 'status') {
    const r = await loadTrialStore(need('--directory'));
    process.stdout.write(
      `${JSON.stringify({ manifestHash: r.manifest.hash, origin: r.manifest.protocol.origin, asOf: r.paper.now, status: r.paper.status, logHead: r.paper.logHead, annotations: r.annotations.length, ledgerReconciled: r.paper.ledgerReconciled })}\n`,
    );
    return;
  }
  if (command === 'submit') {
    const result = await submitTrialEvent(
      need('--directory'),
      await readTrialJson(need('--event'), 2 * 1024 * 1024),
      new Date().toISOString(),
      opts.has('--news-snapshot')
        ? await readTrialJson(need('--news-snapshot'), 16 * 1024 * 1024)
        : undefined,
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  const m = verifyExperimentManifest(await readTrialJson(need('--manifest'), 1024 * 1024)),
    inbox = need('--inbox'),
    bindings = await readTrialJson(need('--bindings'), 65536);
  if (!Array.isArray(bindings) || !['true', 'false', undefined].includes(opts.get('--resume')))
    throw new Error('Invalid runtime bindings or resume');
  const controller = new AbortController(),
    abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    while (Date.now() < Date.parse(m.protocol.paper.startAt)) {
      if (controller.signal.aborted) return;
      await delay(Math.min(1000, Date.parse(m.protocol.paper.startAt) - Date.now()), undefined, {
        signal: controller.signal,
      }).catch(() => {});
    }
    const result = await runRegisteredExperiment(
      need('--directory'),
      m,
      await workingTreeVersion(),
      {
        now: () => new Date().toISOString(),
        sourceBindings: bindings,
        source: async function* () {
          const seen = new Set<string>();
          let lastTick = 0;
          while (!controller.signal.aborted) {
            const now = UtcTimestampSchema.parse(new Date().toISOString());
            if (now >= m.protocol.paper.endAt) {
              yield PaperEventSchema.parse({
                kind: 'CONTROL',
                id: `scheduled-end:${randomUUID()}`,
                at: m.protocol.paper.endAt,
                action: 'STOP',
                actor: 'experiment:supervisor',
                reason: 'Frozen UTC study end',
              });
              return;
            }
            const names = (await readdir(inbox)).filter((n) => !n.startsWith('.')).sort();
            if (names.length > 200000) throw new Error('Source inbox budget');
            const batch = [];
            for (const name of names) {
              if (seen.has(name)) continue;
              if (!/^[a-f0-9]{64}\.json$/.test(name)) throw new Error('Invalid source inbox name');
              const raw = await readTrialJson(join(inbox, name), 2 * 1024 * 1024);
              if (name !== `${canonicalHash(raw).slice(7)}.json`)
                throw new Error('Source inbox integrity');
              const event = PaperEventSchema.parse(raw);
              if (event.kind === 'CONTROL' || event.kind === 'CANCEL')
                throw new Error('Source inbox cannot issue operator controls');
              batch.push(event);
              seen.add(name);
            }
            for (const event of batch.sort((a, b) => a.at.localeCompare(b.at)))
              yield processTrialReceipt(event, new Date().toISOString(), m);
            if (Date.now() - lastTick >= m.protocol.schedule.heartbeatSeconds * 1000) {
              lastTick = Date.now();
              yield PaperEventSchema.parse({
                kind: 'TICK',
                id: `supervisor:${randomUUID()}`,
                at: UtcTimestampSchema.parse(new Date().toISOString()),
              });
            }
            await delay(1000, undefined, { signal: controller.signal }).catch(() => {});
          }
        },
      },
      opts.get('--resume') === 'true',
    );
    process.stdout.write(
      `${JSON.stringify({ status: result.paper.status, logHead: result.paper.logHead, execution: 'SIMULATED' })}\n`,
    );
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  }
}
main(process.argv.slice(2)).catch(() => {
  process.stderr.write(
    'Experiment operation refused: frozen protocol, runtime eligibility, point-in-time receipt, source identity, or immutable evidence check failed.\n',
  );
  process.exitCode = 1;
});
