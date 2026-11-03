import { lstat, readFile } from 'node:fs/promises';
import {
  newsAuditFixture,
  writeNewsAudit,
  verifyNewsAudit,
  newsAuditMarkdown,
} from '@crypto/backtest';
import { workingTreeVersion } from './database-fixtures.js';
async function json(path: string) {
  const s = await lstat(path);
  if (!s.isFile() || s.size > 64 * 1024 * 1024) throw new Error('News audit input limit');
  const b = await readFile(path);
  if (b.length > 64 * 1024 * 1024) throw new Error('News audit input limit');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(b)) as unknown;
}
async function main(args: string[]) {
  const command = args[0],
    allowed =
      command === 'fixture'
        ? ['--out']
        : command === 'run'
          ? ['--input', '--out']
          : command === 'reproduce'
            ? ['--directory', '--out']
            : command === 'verify' || command === 'report'
              ? ['--directory']
              : null;
  if (!allowed) throw new Error('Invalid news audit command');
  const opts = new Map<string, string>();
  for (let i = 1; i < args.length; i += 2) {
    const k = args[i]!,
      v = args[i + 1];
    if (!allowed.includes(k) || opts.has(k) || !v || v.startsWith('--'))
      throw new Error('Invalid news audit option');
    opts.set(k, v);
  }
  const required = (k: string) => {
    const v = opts.get(k);
    if (!v) throw new Error('Required news audit option');
    return v;
  };
  if (command === 'verify' || command === 'report') {
    const v = await verifyNewsAudit(required('--directory'));
    process.stdout.write(
      command === 'report'
        ? newsAuditMarkdown(v.report)
        : `${JSON.stringify({ valid: true, hash: v.hash, assessment: v.report.evaluation.assessment, falsePositives: v.report.evaluation.falsePositives.length, missedEvents: v.report.evaluation.missedEvents.length })}\n`,
    );
    return;
  }
  const old = command === 'reproduce' ? await verifyNewsAudit(required('--directory')) : null,
    code = old?.report.codeVersion ?? (await workingTreeVersion()),
    input =
      old?.input ??
      (command === 'fixture' ? await newsAuditFixture(code) : await json(required('--input'))),
    v = await writeNewsAudit(input, opts.get('--out') ?? 'data/news-audit', code);
  process.stdout.write(
    `${JSON.stringify({ directory: v.directory, hash: v.hash, execution: v.report.execution, frames: v.report.frames.length, opportunities: v.report.evaluation.opportunityCount, measured: v.report.evaluation.measuredCount, units: v.report.evaluation.independentUnits, falsePositives: v.report.evaluation.falsePositives.length, missedEvents: v.report.evaluation.missedEvents.length, assessment: v.report.evaluation.assessment, logHead: v.report.logHead }, null, 2)}\n`,
  );
}
main(process.argv.slice(2)).catch(() => {
  process.stderr.write(
    'News audit failed: invalid source, TEST chronology, opportunity binding, explanation or artifact integrity.\n',
  );
  process.exitCode = 1;
});
