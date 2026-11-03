import { lstat, readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { buildEventControlsApp } from '@crypto/api';
import {
  eventControlsFixture,
  eventControlsReport,
  SnapshotEventControls,
  verifyEventControlsArtifact,
  verifyEventStudyArtifact,
  writeEventControlsArtifact,
} from '@crypto/research';
import { workingTreeVersion } from './database-fixtures.js';

export async function eventControlsCommand(args: string[]) {
  const command = args[0],
    options = new Map<string, string>(),
    allowed =
      command === 'controls-fixture'
        ? ['--out']
        : command === 'controls'
          ? ['--artifact', '--request', '--out']
          : command === 'controls-serve'
            ? ['--artifact', '--port']
            : command === 'controls-verify' || command === 'controls-report'
              ? ['--artifact']
              : null;
  if (!allowed) throw new Error('Invalid controls command');
  for (let i = 1; i < args.length; i += 2) {
    const k = args[i]!,
      v = args[i + 1];
    if (!allowed.includes(k) || options.has(k) || !v || v.startsWith('--'))
      throw new Error('Invalid controls option');
    options.set(k, v);
  }
  const required = (k: string) => {
    const v = options.get(k);
    if (!v) throw new Error('Required option missing');
    return v;
  };
  if (
    command === 'controls-verify' ||
    command === 'controls-report' ||
    command === 'controls-serve'
  ) {
    const verified = await verifyEventControlsArtifact(required('--artifact'));
    if (command === 'controls-verify')
      process.stdout.write(`${JSON.stringify({ hash: verified.hash, valid: true })}\n`);
    else if (command === 'controls-report')
      process.stdout.write(eventControlsReport(verified.artifact.result));
    else {
      const text = options.get('--port') ?? '3011',
        port = Number(text);
      if (!/^\d{1,5}$/.test(text) || port < 1 || port > 65535) throw new Error('Invalid port');
      const app = buildEventControlsApp(new SnapshotEventControls(verified.artifact.input));
      await app.listen({ host: '127.0.0.1', port });
      for (const signal of ['SIGINT', 'SIGTERM'] as const)
        process.once(signal, () => {
          void app.close();
        });
      process.stdout.write(
        `Event controls API: http://127.0.0.1:${port}/research/event-controls (execution DISABLED)\n`,
      );
    }
    return;
  }
  let input: unknown, request: unknown;
  if (command === 'controls-fixture') ({ input, request } = await eventControlsFixture());
  else {
    const source = required('--artifact');
    input = basename(source).startsWith('event-controls_')
      ? (await verifyEventControlsArtifact(source)).artifact.input
      : (await verifyEventStudyArtifact(source)).artifact.input;
    const path = required('--request'),
      info = await lstat(path);
    if (!info.isFile() || info.size > 16384) throw new Error('Invalid controls request file');
    const bytes = await readFile(path);
    if (bytes.length > 16384) throw new Error('Controls request limit');
    request = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  }
  const result = await writeEventControlsArtifact(
    input,
    request,
    options.get('--out') ?? 'data/event-controls',
    await workingTreeVersion(),
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        path: result.path,
        hash: result.hash,
        execution: 'DISABLED',
        events: result.artifact.result.events.length,
        selectedControls: result.artifact.result.events.reduce((n, e) => n + e.controls.length, 0),
        rightCensored: result.artifact.result.events
          .flatMap((e) => e.responses)
          .filter((r) => r.recovery.status === 'RIGHT_CENSORED').length,
      },
      null,
      2,
    )}\n`,
  );
}
