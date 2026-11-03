import { lstat, readFile } from 'node:fs/promises';
import {
  crossFeatureFixture,
  crossFeatureCatalog,
  crossFeatureReport,
  verifyCrossFeatureArtifact,
  writeCrossFeatureArtifact,
} from '@crypto/research';
import { workingTreeVersion } from './database-fixtures.js';

async function localJson(path: string, limit: number) {
  const info = await lstat(path);
  if (!info.isFile() || info.size > limit) throw new Error('Invalid cross-feature input');
  const b = await readFile(path);
  if (b.length > limit) throw new Error('Cross-feature limit');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(b)) as unknown;
}
export async function crossFeaturesCommand(args: string[]) {
  const command = args[0],
    options = new Map<string, string>(),
    allowed =
      command === 'cross-fixture'
        ? ['--out']
        : command === 'cross-build'
          ? ['--input', '--request', '--out']
          : command === 'cross-run'
            ? ['--artifact', '--request', '--out']
            : command === 'cross-verify' || command === 'cross-report'
              ? ['--artifact']
              : command === 'cross-catalog'
                ? []
                : null;
  if (!allowed) throw new Error('Invalid cross-feature command');
  for (let i = 1; i < args.length; i += 2) {
    const k = args[i]!,
      v = args[i + 1];
    if (!allowed.includes(k) || options.has(k) || !v || v.startsWith('--'))
      throw new Error('Invalid option');
    options.set(k, v);
  }
  const required = (k: string) => {
    const v = options.get(k);
    if (!v) throw new Error('Required option missing');
    return v;
  };
  if (command === 'cross-catalog') {
    process.stdout.write(`${JSON.stringify(crossFeatureCatalog(), null, 2)}\n`);
    return;
  }
  if (command === 'cross-verify' || command === 'cross-report') {
    const v = await verifyCrossFeatureArtifact(required('--artifact'));
    process.stdout.write(
      command === 'cross-verify'
        ? `${JSON.stringify({ hash: v.hash, valid: true })}\n`
        : crossFeatureReport(v.artifact),
    );
    return;
  }
  let input: unknown, request: unknown;
  if (command === 'cross-fixture') ({ input, request } = crossFeatureFixture());
  else {
    input =
      command === 'cross-run'
        ? (await verifyCrossFeatureArtifact(required('--artifact'))).artifact.input
        : await localJson(required('--input'), 64 * 1024 * 1024);
    request = await localJson(required('--request'), 16384);
  }
  const v = await writeCrossFeatureArtifact(
    input,
    request,
    options.get('--out') ?? 'data/cross-features',
    await workingTreeVersion(),
  );
  process.stdout.write(
    `${JSON.stringify({ path: v.path, hash: v.hash, execution: 'DISABLED', rows: v.artifact.rows.length, synthetic: v.artifact.input.technical.bars.every((b) => b.provenance.origin === 'FIXTURE') && v.artifact.input.market.sources.every((s) => s.origin === 'SYNTHETIC') && v.artifact.input.derivatives.every((d) => d.provenance.origin === 'FIXTURE') }, null, 2)}\n`,
  );
}
