import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NewsEdgeInferenceRequestSchema } from '@crypto/contracts';
import { canonicalJson } from '@crypto/core';
import { newsEdgeFixture } from '@crypto/backtest';
import {
  writeNewsEdgeModel,
  verifyNewsEdgeModel,
  EstimatedNewsSignalProvider,
  newsEdgeMarkdown,
} from '@crypto/strategies';
import { workingTreeVersion } from './database-fixtures.js';
async function json(path: string) {
  const s = await lstat(path);
  if (!s.isFile() || s.size > 32 * 1024 * 1024) throw new Error('Invalid news edge input');
  const b = await readFile(path);
  if (b.length > 32 * 1024 * 1024) throw new Error('News edge input byte limit');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(b)) as unknown;
}
async function main(args: string[]) {
  const command = args[0],
    allowed =
      command === 'fixture'
        ? ['--out']
        : command === 'train'
          ? ['--input', '--out']
          : command === 'reproduce'
            ? ['--model', '--out']
            : command === 'infer'
              ? ['--model', '--request']
              : command === 'verify' || command === 'report'
                ? ['--model']
                : null;
  if (!allowed) throw new Error('Invalid news edge command');
  const opts = new Map<string, string>();
  for (let i = 1; i < args.length; i += 2) {
    const k = args[i]!,
      v = args[i + 1];
    if (!allowed.includes(k) || opts.has(k) || !v || v.startsWith('--'))
      throw new Error('Invalid news edge option');
    opts.set(k, v);
  }
  const required = (k: string) => {
    const v = opts.get(k);
    if (!v) throw new Error('Required news edge option');
    return v;
  };
  if (command === 'verify' || command === 'report' || command === 'infer') {
    const v = await verifyNewsEdgeModel(required('--model'));
    if (command === 'report') {
      process.stdout.write(newsEdgeMarkdown(v.model));
      return;
    }
    if (command === 'infer') {
      const r = NewsEdgeInferenceRequestSchema.parse(await json(required('--request'))),
        p = new EstimatedNewsSignalProvider(v.model, r.hypothesisId, r.snapshot);
      process.stdout.write(
        `${canonicalJson(p.evaluate(r.query, r.state ?? p.initialState(), r.roundTripCostBps))}\n`,
      );
      return;
    }
    process.stdout.write(
      `${JSON.stringify({ valid: true, hash: v.hash, dataVintage: v.model.dataVintage, availableAt: v.model.availableAt, fits: v.model.fits.length })}\n`,
    );
    return;
  }
  const root = opts.get('--out') ?? 'data/news-edge';
  if (command === 'fixture') {
    const f = await newsEdgeFixture(),
      v = await writeNewsEdgeModel(f.input, root, await workingTreeVersion());
    await mkdir(root, { recursive: true });
    for (const [i, request] of f.queries.entries())
      await writeFile(join(root, `fixture-query-${i + 1}.json`), `${canonicalJson(request)}\n`);
    process.stdout.write(
      `${JSON.stringify({ path: v.path, hash: v.hash, synthetic: v.model.synthetic, fits: v.model.fits.length, selected: v.model.fits.filter((f) => f.selectedOnTraining).map((f) => ({ hypothesisId: f.hypothesisId, side: f.side, horizon: f.horizonSeconds, trainingUnits: f.training.independentUnits, validationUnits: f.validation.independentUnits, reasons: f.reasons })) }, null, 2)}\n`,
    );
    return;
  }
  const old = command === 'reproduce' ? await verifyNewsEdgeModel(required('--model')) : null;
  const v = await writeNewsEdgeModel(
    old?.model.input ?? (await json(required('--input'))),
    root,
    old?.model.codeVersion ?? (await workingTreeVersion()),
  );
  process.stdout.write(
    `${JSON.stringify({ path: v.path, hash: v.hash, execution: v.model.execution })}\n`,
  );
}
main(process.argv.slice(2)).catch(() => {
  process.stderr.write(
    'News edge research failed: invalid chronology, evidence, statistical bounds, inference scope or artifact integrity.\n',
  );
  process.exitCode = 1;
});
