import { lstat, readFile } from 'node:fs/promises';
import {
  replayFixture,
  writeReplayArtifact,
  verifyReplayArtifact,
  replayReport,
} from '@crypto/backtest';
import { workingTreeVersion } from './database-fixtures.js';
import { spotSimulationCommand } from './spot-simulation.js';
async function json(path: string, limit: number) {
  const s = await lstat(path);
  if (!s.isFile() || s.size > limit) throw new Error('Invalid replay input');
  const b = await readFile(path);
  if (b.length > limit) throw new Error('Replay input limit');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(b)) as unknown;
}
async function main(args: string[]) {
  if (args[0]?.startsWith('spot-')) {
    await spotSimulationCommand(args);
    return;
  }
  const command = args[0],
    allowed =
      command === 'fixture'
        ? ['--out']
        : command === 'run'
          ? ['--input', '--request', '--out']
          : command === 'reproduce'
            ? ['--artifact', '--out']
            : command === 'verify' || command === 'report'
              ? ['--artifact']
              : null,
    options = new Map<string, string>();
  if (!allowed) throw new Error('Expected fixture, run, reproduce, verify or report');
  for (let i = 1; i < args.length; i += 2) {
    const k = args[i]!,
      v = args[i + 1];
    if (!allowed.includes(k) || options.has(k) || !v || v.startsWith('--'))
      throw new Error('Invalid replay option');
    options.set(k, v);
  }
  const required = (k: string) => {
    const v = options.get(k);
    if (!v) throw new Error('Required replay option missing');
    return v;
  };
  if (command === 'verify' || command === 'report') {
    const v = await verifyReplayArtifact(required('--artifact'));
    process.stdout.write(
      command === 'report'
        ? replayReport(v.artifact)
        : `${JSON.stringify({ valid: true, hash: v.hash, manifest: v.artifact.manifest }, null, 2)}\n`,
    );
    return;
  }
  let input: unknown, request: unknown;
  if (command === 'fixture') ({ input, request } = replayFixture());
  else if (command === 'reproduce') {
    const v = await verifyReplayArtifact(required('--artifact'));
    ({ input, request } = v.artifact);
  } else {
    input = await json(required('--input'), 64 * 1024 * 1024);
    request = await json(required('--request'), 16384);
  }
  const v = await writeReplayArtifact(
    input,
    request,
    options.get('--out') ?? 'data/replays',
    await workingTreeVersion(),
  );
  process.stdout.write(
    `${JSON.stringify({ path: v.path, hash: v.hash, manifest: v.artifact.manifest, synthetic: [...v.artifact.input.bars, ...v.artifact.input.news].every((r) => r.provenance.origin === 'FIXTURE') }, null, 2)}\n`,
  );
}
main(process.argv.slice(2)).catch(() => {
  process.stderr.write('Replay command failed: invalid input or replay integrity violation.\n');
  process.exitCode = 1;
});
