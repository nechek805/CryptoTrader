import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  robustnessFixture,
  writeMarketRobustness,
  verifyMarketRobustness,
  robustnessMarkdown,
} from '@crypto/backtest';
import { marketMlFixture, writeMarketModel } from '@crypto/strategies';
import { writeDatasetPanel } from '@crypto/research';
import { workingTreeVersion } from './database-fixtures.js';
import { MarketRobustnessReportSchema } from '@crypto/contracts';
import { canonicalHash } from '@crypto/core';
async function json(path: string) {
  const s = await lstat(path);
  if (!s.isFile() || s.size > 8 * 1024 * 1024) throw new Error('Invalid robustness plan');
  const b = await readFile(path);
  if (b.length > 8 * 1024 * 1024) throw new Error('Robustness plan limit');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(b)) as unknown;
}
async function main(args: string[]) {
  const command = args[0],
    allowed =
      command === 'fixture'
        ? ['--out', '--parent']
        : command === 'run'
          ? ['--plan', '--parent', '--out']
          : command === 'reproduce'
            ? ['--directory', '--parent', '--out']
            : command === 'verify' || command === 'report'
              ? ['--directory']
              : null;
  if (!allowed) throw new Error('Invalid robustness command');
  const options = new Map<string, string>();
  for (let i = 1; i < args.length; i += 2) {
    const k = args[i]!,
      v = args[i + 1];
    if (!allowed.includes(k) || options.has(k) || !v || v.startsWith('--'))
      throw new Error('Invalid robustness option');
    options.set(k, v);
  }
  const required = (k: string) => {
    const v = options.get(k);
    if (!v) throw new Error('Required robustness option');
    return v;
  };
  if (command === 'verify' || command === 'report') {
    const v = await verifyMarketRobustness(required('--directory'));
    process.stdout.write(
      command === 'report'
        ? robustnessMarkdown(v.report)
        : `${JSON.stringify({ valid: true, hash: v.hash, attemptCount: v.report.attemptCount, familySize: v.report.familySize, journalHead: v.report.journalHead })}\n`,
    );
    return;
  }
  const root = options.get('--out') ?? 'data/market-robustness';
  let plan: unknown, code: string;
  if (command === 'reproduce') {
    const v = await verifyMarketRobustness(required('--directory'));
    plan = v.report.plan;
    code = v.report.codeVersion;
  } else if (command === 'run') {
    plan = await json(required('--plan'));
    code = await workingTreeVersion();
  } else {
    const f = marketMlFixture();
    code = await workingTreeVersion();
    const original = await writeDatasetPanel(
        f.input,
        f.request,
        join(root, 'panels'),
        'synthetic:market-ml-source.v1',
      ),
      forward = await writeDatasetPanel(
        f.input,
        { ...f.request, horizonsBars: [2, 3] },
        join(root, 'panels'),
        'synthetic:market-ml-source.v1',
      );
    const h3 = { ...f.config, horizonBars: 3, abstentionReturnBps: '125' },
      models = [];
    for (const [panel, config] of [
      [original.directory, f.config],
      [forward.directory, h3],
      [
        forward.directory,
        { ...h3, featureColumns: ['technical.return_1', 'technical.relative_volume'] },
      ],
      [forward.directory, { ...h3, l2: 0.02 }],
    ] as const) {
      const v = await writeMarketModel(panel, config, join(root, 'models'), code);
      models.push(v.report.model);
      process.stderr.write(`Frozen model ${models.length}/4: ${v.report.model.id}\n`);
    }
    const initialPlan = robustnessFixture(models);
    plan = initialPlan;
    if (options.has('--parent')) {
      const previous = MarketRobustnessReportSchema.parse(
        await json(join(required('--parent'), 'report.json')),
      );
      plan = {
        ...initialPlan,
        parentReportHash: canonicalHash(previous),
        priorTrialCount: previous.familySize,
        priorDisclosure: `Continuation of ${canonicalHash(previous)}. All declared parent/current/imported attempts remain in the family; infrastructure refinements do not reset the observed trial history.`,
        experimentVersion: `${previous.plan.experimentVersion}/next`,
      };
    }
  }
  const v = await writeMarketRobustness(plan, root, code, options.get('--parent'));
  process.stdout.write(
    `${JSON.stringify({ directory: v.directory, hash: v.hash, synthetic: v.report.synthetic, attemptCount: v.report.attemptCount, familySize: v.report.familySize, failed: v.report.attempts.filter((a) => a.status === 'FAILED').length, rankings: v.report.rankings, selection: v.report.selection }, null, 2)}\n`,
  );
}
main(process.argv.slice(2)).catch(() => {
  process.stderr.write(
    'Robustness failed: invalid plan, lineage, causal execution or integrity violation. Interrupted .robustness-stage-* directories retain synced plan/attempt/evidence files for explicit review.\n',
  );
  process.exitCode = 1;
});
