import { lstat, readFile, writeFile } from 'node:fs/promises';
import { canonicalJson } from '@crypto/core';
import { fusionFixture, runFusion, verifyFusionReport } from '@crypto/strategies';
import { workingTreeVersion } from './database-fixtures.js';

async function json(path: string) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error('Invalid fusion artifact');
  const bytes = await readFile(path);
  if (bytes.length > 16 * 1024 * 1024) throw new Error('Fusion artifact too large');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
}
async function main(args: string[]) {
  const command = args[0],
    allowed =
      command === 'fixture'
        ? ['--out']
        : command === 'run'
          ? ['--input', '--out']
          : command === 'verify'
            ? ['--report']
            : null;
  if (!allowed) throw new Error('Unknown fusion command');
  const options = new Map<string, string>();
  for (let i = 1; i < args.length; i += 2) {
    const key = args[i]!,
      value = args[i + 1];
    if (!allowed.includes(key) || options.has(key) || !value || value.startsWith('--'))
      throw new Error('Invalid fusion option');
    options.set(key, value);
  }
  const required = (key: string) => {
    const value = options.get(key);
    if (!value) throw new Error('Missing fusion option');
    return value;
  };
  const report =
    command === 'verify'
      ? verifyFusionReport(await json(required('--report')))
      : runFusion(
          command === 'fixture'
            ? fusionFixture(await workingTreeVersion())
            : await json(required('--input')),
        );
  const output = options.get('--out');
  // One exclusive file is the complete versioned artifact; never replace an existing run.
  if (output) await writeFile(output, `${canonicalJson(report)}\n`, { flag: 'wx' });
  process.stdout.write(
    `${JSON.stringify(
      {
        execution: report.execution,
        assessment: report.assessment,
        ordersCreated: report.ordersCreated,
        windows: report.windows.length,
        reasons: report.windows.map((w) => w.reason),
        inputHash: report.inputHash,
        logHead: report.logHead,
        ...(output
          ? { report: output }
          : command !== 'verify'
            ? { artifact: report }
            : { valid: true }),
      },
      null,
      2,
    )}\n`,
  );
}
main(process.argv.slice(2)).catch(() => {
  process.stderr.write(
    'Fusion failed: invalid input, isolation, chronology, freeze or artifact integrity.\n',
  );
  process.exitCode = 1;
});
