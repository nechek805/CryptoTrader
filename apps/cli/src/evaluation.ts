import { lstat, readFile } from 'node:fs/promises';
import {
  evaluationFixture,
  misleadingProfitableFixture,
  writeEvaluationBundle,
  verifyEvaluationBundle,
  listEvaluationRuns,
  evaluationMarkdown,
} from '@crypto/evaluation';
import { workingTreeVersion } from './database-fixtures.js';
async function json(path: string) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size > 256 * 1024 * 1024) throw new Error('Invalid evaluation input');
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}
async function main(args: string[]) {
  const command = args[0],
    allowed =
      command === 'fixture' || command === 'misleading'
        ? ['--out']
        : command === 'run'
          ? ['--paper', '--plan', '--out']
          : command === 'reproduce'
            ? ['--bundle', '--out']
            : command === 'verify' || command === 'report'
              ? ['--bundle']
              : command === 'list'
                ? ['--root']
                : null;
  if (!allowed) throw new Error('Invalid evaluation command');
  const opts = new Map<string, string>();
  for (let i = 1; i < args.length; i += 2) {
    const k = args[i]!,
      v = args[i + 1];
    if (!allowed.includes(k) || opts.has(k) || !v || v.startsWith('--'))
      throw new Error('Invalid evaluation option');
    opts.set(k, v);
  }
  const required = (k: string) => {
    const v = opts.get(k);
    if (!v) throw new Error('Required evaluation option');
    return v;
  };
  if (command === 'list') {
    process.stdout.write(
      `${JSON.stringify(await listEvaluationRuns(required('--root')), null, 2)}\n`,
    );
    return;
  }
  if (command === 'verify' || command === 'report') {
    const v = await verifyEvaluationBundle(required('--bundle'));
    process.stdout.write(
      command === 'report'
        ? evaluationMarkdown(v.report)
        : `${JSON.stringify({ valid: true, hash: v.report.hash, recommendation: v.report.memo.recommendation })}\n`,
    );
    return;
  }
  let paper: unknown,
    plan: unknown,
    code = await workingTreeVersion();
  if (command === 'fixture' || command === 'misleading')
    ({ paper, plan } = command === 'fixture' ? evaluationFixture() : misleadingProfitableFixture());
  else if (command === 'reproduce') {
    const v = await verifyEvaluationBundle(required('--bundle'));
    ({ paper, plan } = v.input);
    code = v.input.codeVersion;
  } else {
    paper = await json(required('--paper'));
    plan = await json(required('--plan'));
  }
  const v = await writeEvaluationBundle(paper, plan, opts.get('--out') ?? 'data/evaluation', code);
  process.stdout.write(
    `${JSON.stringify(
      {
        directory: v.directory,
        hash: v.report.hash,
        recommendation: v.report.memo.recommendation,
        origin: v.report.origin,
        outcomes: v.report.metrics.map((m) => ({ portfolio: m.portfolio, netPnl: m.netPnl })),
        warnings: v.report.warnings,
      },
      null,
      2,
    )}\n`,
  );
}
main(process.argv.slice(2)).catch(() => {
  process.stderr.write(
    'Evaluation failed: freeze, source, cohort, dependence or artifact integrity.\n',
  );
  process.exitCode = 1;
});
