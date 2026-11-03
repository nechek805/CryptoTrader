import { lstat, readFile } from 'node:fs/promises';
import {
  spotSimulationFixture,
  verifySpotSimulationArtifact,
  writeSpotSimulationArtifact,
  spotSimulationReport,
} from '@crypto/backtest';
import { workingTreeVersion } from './database-fixtures.js';
async function json(path: string, limit: number) {
  const s = await lstat(path);
  if (!s.isFile() || s.size > limit) throw new Error('Invalid spot input');
  const b = await readFile(path);
  if (b.length > limit) throw new Error('Spot input limit');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(b)) as unknown;
}
export async function spotSimulationCommand(args: string[]) {
  const command = args[0],
    allowed =
      command === 'spot-fixture'
        ? ['--out']
        : command === 'spot-run'
          ? ['--input', '--request', '--out']
          : command === 'spot-reproduce'
            ? ['--artifact', '--out']
            : command === 'spot-verify' || command === 'spot-report'
              ? ['--artifact']
              : null,
    options = new Map<string, string>();
  if (!allowed) throw new Error('Invalid spot command');
  for (let i = 1; i < args.length; i += 2) {
    const k = args[i]!,
      v = args[i + 1];
    if (!allowed.includes(k) || options.has(k) || !v || v.startsWith('--'))
      throw new Error('Invalid spot option');
    options.set(k, v);
  }
  const required = (k: string) => {
    const v = options.get(k);
    if (!v) throw new Error('Required spot option missing');
    return v;
  };
  if (command === 'spot-verify' || command === 'spot-report') {
    const v = await verifySpotSimulationArtifact(required('--artifact'));
    process.stdout.write(
      command === 'spot-report'
        ? spotSimulationReport(v.artifact)
        : `${JSON.stringify({ valid: true, hash: v.hash, reconciliation: v.artifact.reconciliation }, null, 2)}\n`,
    );
    return;
  }
  let input: unknown, request: unknown;
  if (command === 'spot-fixture') ({ input, request } = spotSimulationFixture());
  else if (command === 'spot-reproduce') {
    const v = await verifySpotSimulationArtifact(required('--artifact'));
    ({ input, request } = v.artifact);
  } else {
    input = await json(required('--input'), 64 * 1024 * 1024);
    request = await json(required('--request'), 16384);
  }
  const v = await writeSpotSimulationArtifact(
    input,
    request,
    options.get('--out') ?? 'data/spot-simulations',
    await workingTreeVersion(),
  );
  process.stdout.write(
    `${JSON.stringify({ path: v.path, hash: v.hash, execution: 'SIMULATED', liveExecution: 'DISABLED', orders: v.artifact.orders.length, fills: v.artifact.fills.length, journalTransactions: v.artifact.journal.length, balances: v.artifact.balances, reconciliation: v.artifact.reconciliation, synthetic: v.artifact.input.market.sources.every((s) => s.origin === 'SYNTHETIC') && v.artifact.input.bars.every((b) => b.provenance.origin === 'FIXTURE') }, null, 2)}\n`,
  );
}
