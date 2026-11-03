import { lstat, readFile } from 'node:fs/promises';
import {
  newsSignalFixture,
  writeNewsSignals,
  verifyNewsSignals,
  newsSignalMarkdown,
} from '@crypto/backtest';
import { workingTreeVersion } from './database-fixtures.js';
async function json(path: string) {
  const s = await lstat(path);
  if (!s.isFile() || s.size > 8 * 1024 * 1024) throw new Error('Invalid news signal manifest');
  const b = await readFile(path);
  if (b.length > 8 * 1024 * 1024) throw new Error('News signal manifest limit');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(b)) as unknown;
}
async function main(args: string[]) {
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
              : null;
  if (!allowed) throw new Error('Invalid news signal command');
  const opts = new Map<string, string>();
  for (let i = 1; i < args.length; i += 2) {
    const k = args[i]!,
      v = args[i + 1];
    if (!allowed.includes(k) || opts.has(k) || !v || v.startsWith('--'))
      throw new Error('Invalid news signal option');
    opts.set(k, v);
  }
  const required = (k: string) => {
    const v = opts.get(k);
    if (!v) throw new Error('Required news signal option');
    return v;
  };
  if (command === 'verify' || command === 'report') {
    const v = await verifyNewsSignals(required('--directory'));
    process.stdout.write(
      command === 'report'
        ? newsSignalMarkdown(v.report)
        : `${JSON.stringify({ valid: true, hash: v.hash, counts: v.report.counts, logHead: v.report.logHead })}\n`,
    );
    return;
  }
  let input: unknown, code: string;
  if (command === 'fixture') {
    input = await newsSignalFixture();
    code = await workingTreeVersion();
  } else if (command === 'reproduce') {
    const v = await verifyNewsSignals(required('--directory'));
    input = v.report.manifest;
    code = v.report.codeVersion;
  } else {
    input = await json(required('--manifest'));
    code = await workingTreeVersion();
  }
  const v = await writeNewsSignals(input, opts.get('--out') ?? 'data/news-signals', code);
  process.stdout.write(
    `${JSON.stringify({ directory: v.directory, hash: v.hash, execution: v.report.execution, providerHash: v.report.providerHash, counts: v.report.counts, snapshots: v.report.snapshotHashes.length, decisions: v.report.decisions.length, logHead: v.report.logHead }, null, 2)}\n`,
  );
}
main(process.argv.slice(2)).catch(() => {
  process.stderr.write(
    'News signal replay failed: invalid rule, source snapshot, chronology, safety veto or artifact integrity violation.\n',
  );
  process.exitCode = 1;
});
