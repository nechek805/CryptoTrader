import { lstat, readFile } from 'node:fs/promises';
import { backtestFixture, writeBacktest, verifyBacktest, backtestMarkdown } from '@crypto/backtest';
import { workingTreeVersion } from './database-fixtures.js';
import { marketBaselinesCli } from './market-baselines.js';
async function json(path: string) {
  const s = await lstat(path);
  if (!s.isFile() || s.size > 64 * 1024 * 1024) throw new Error('Invalid backtest manifest');
  const b = await readFile(path);
  if (b.length > 64 * 1024 * 1024) throw new Error('Manifest limit');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(b)) as unknown;
}
async function main(args: string[]) {
  if (args[0]?.startsWith('market-')) return marketBaselinesCli(args);
  const command = args[0],
    allowed =
      command === 'fixture'
        ? ['--out']
        : command === 'run'
          ? ['--manifest', '--out']
          : command === 'reproduce'
            ? ['--directory', '--out']
            : command === 'verify' || command === 'report'
              ? ['--directory']
              : null,
    options = new Map<string, string>();
  if (!allowed) throw new Error('Invalid backtest command');
  for (let i = 1; i < args.length; i += 2) {
    const k = args[i]!,
      v = args[i + 1];
    if (!allowed.includes(k) || options.has(k) || !v || v.startsWith('--'))
      throw new Error('Invalid backtest option');
    options.set(k, v);
  }
  const required = (k: string) => {
    const v = options.get(k);
    if (!v) throw new Error('Required backtest option missing');
    return v;
  };
  if (command === 'verify' || command === 'report') {
    const v = await verifyBacktest(required('--directory'));
    process.stdout.write(
      command === 'report'
        ? backtestMarkdown(v.report)
        : `${JSON.stringify({ valid: true, hash: v.hash, runId: v.report.runId })}\n`,
    );
    return;
  }
  const manifest =
      command === 'fixture'
        ? backtestFixture()
        : command === 'reproduce'
          ? (await verifyBacktest(required('--directory'))).report.manifest
          : await json(required('--manifest')),
    v = await writeBacktest(
      manifest,
      options.get('--out') ?? 'data/backtests',
      await workingTreeVersion(),
    );
  const summary = {
    directory: v.directory,
    hash: v.hash,
    execution: 'SIMULATED',
    liveExecution: 'DISABLED',
    cases: v.report.cases.map((c) => ({
      id: c.id,
      feeCheck: c.feeCheck,
      strategy: c.outcomes[0]!.metrics,
      cash: c.outcomes[1]!.metrics.netReturn,
      buyAndHold: c.outcomes[2]!.metrics.netReturn,
    })),
    synthetic:
      v.report.manifest.input.market.sources.every((s) => s.origin === 'SYNTHETIC') &&
      [...v.report.manifest.input.replay.bars, ...v.report.manifest.input.replay.news].every(
        (r) => r.provenance.origin === 'FIXTURE',
      ),
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}
main(process.argv.slice(2)).catch(() => {
  process.stderr.write(
    'Backtest failed: invalid manifest, unavailable input, causal access or report integrity violation.\n',
  );
  process.exitCode = 1;
});
