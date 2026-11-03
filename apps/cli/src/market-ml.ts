import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  marketMlFixture,
  writeMarketModel,
  verifyMarketModel,
  marketMlMarkdown,
  inferMarketModel,
} from '@crypto/strategies';
import { writeDatasetPanel } from '@crypto/research';
import { workingTreeVersion } from './database-fixtures.js';
async function json(path: string) {
  const s = await lstat(path);
  if (!s.isFile() || s.size > 65536) throw new Error('Invalid ML request');
  const b = await readFile(path);
  if (b.length > 65536) throw new Error('ML request limit');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(b)) as unknown;
}
async function main(args: string[]) {
  const command = args[0],
    allowed =
      command === 'fixture'
        ? ['--out']
        : command === 'train'
          ? ['--panel', '--config', '--out']
          : command === 'reproduce'
            ? ['--directory', '--panel', '--out']
            : command === 'verify' || command === 'report'
              ? ['--directory', '--panel']
              : command === 'infer'
                ? ['--directory', '--panel', '--request']
                : null;
  if (!allowed) throw new Error('Invalid ML command');
  const opts = new Map<string, string>();
  for (let i = 1; i < args.length; i += 2) {
    const k = args[i]!,
      v = args[i + 1];
    if (!allowed.includes(k) || opts.has(k) || !v || v.startsWith('--'))
      throw new Error('Invalid ML option');
    opts.set(k, v);
  }
  const required = (k: string) => {
      const v = opts.get(k);
      if (!v) throw new Error('Missing ML option');
      return v;
    },
    out = opts.get('--out') ?? 'data/market-ml';
  if (command === 'verify' || command === 'report' || command === 'infer') {
    const v = await verifyMarketModel(required('--directory'), required('--panel'));
    process.stdout.write(
      command === 'report'
        ? marketMlMarkdown(v.report)
        : `${JSON.stringify(command === 'infer' ? inferMarketModel(v.report.model, await json(required('--request'))) : { valid: true, hash: v.hash, modelId: v.report.model.id, predictionHash: v.report.predictionHash })}\n`,
    );
    return;
  }
  let panel: string, config: unknown, code: string;
  if (command === 'fixture') {
    const f = marketMlFixture(),
      p = await writeDatasetPanel(
        f.input,
        f.request,
        join(out, 'panels'),
        'synthetic:market-ml-source.v1',
      );
    panel = p.directory;
    config = f.config;
    code = await workingTreeVersion();
  } else if (command === 'reproduce') {
    panel = required('--panel');
    const v = await verifyMarketModel(required('--directory'), panel);
    config = v.report.model.config;
    code = v.report.model.codeVersion;
  } else {
    panel = required('--panel');
    config = await json(required('--config'));
    code = await workingTreeVersion();
  }
  const v = await writeMarketModel(panel, config, out, code);
  process.stdout.write(
    `${JSON.stringify({ directory: v.directory, hash: v.hash, panelDirectory: panel, modelId: v.report.model.id, predictionHash: v.report.predictionHash, mode: v.report.mode, execution: v.report.execution, availableAt: v.report.model.availableAt, trainRows: v.report.audit.trainRows, validationRows: v.report.audit.validationRows, testRows: v.report.audit.testRows, temperature: v.report.model.calibration.temperature, test: v.report.metrics.filter((m) => m.split === 'TEST') }, null, 2)}\n`,
  );
}
main(process.argv.slice(2)).catch(() => {
  process.stderr.write(
    'Market ML failed: invalid configuration, frozen snapshot, temporal leakage, model availability or artifact integrity violation.\n',
  );
  process.exitCode = 1;
});
