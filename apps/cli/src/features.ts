import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  technicalFeatureFixture,
  technicalFeatureCatalog,
  technicalFeatureReport,
  verifyTechnicalFeatureArtifact,
  writeTechnicalFeatureArtifact,
  verifyMarketSnapshot,
  readMarketParquet,
} from '@crypto/research';
import { workingTreeVersion } from './database-fixtures.js';
import { crossFeaturesCommand } from './cross-features.js';
import { datasetPanelCommand } from './dataset-panel.js';

async function localJson(path: string) {
  const info = await lstat(path);
  if (!info.isFile() || info.size > 16384) throw new Error('Invalid feature request file');
  const bytes = await readFile(path);
  if (bytes.length > 16384) throw new Error('Feature request limit');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
}
async function main(args: string[]) {
  if (args[0]?.startsWith('dataset-')) {
    await datasetPanelCommand(args);
    return;
  }
  if (args[0]?.startsWith('cross-')) {
    await crossFeaturesCommand(args);
    return;
  }
  const command = args[0],
    options = new Map<string, string>(),
    allowed =
      command === 'fixture'
        ? ['--out']
        : command === 'run'
          ? ['--snapshot', '--artifact', '--request', '--out']
          : command === 'verify' || command === 'report'
            ? ['--artifact']
            : command === 'catalog'
              ? ['--config']
              : null;
  if (!allowed) throw new Error('Expected fixture, run, verify, report or catalog');
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
  if (command === 'catalog') {
    process.stdout.write(
      `${JSON.stringify(technicalFeatureCatalog(options.has('--config') ? await localJson(required('--config')) : technicalFeatureFixture().request.config), null, 2)}\n`,
    );
    return;
  }
  if (command === 'verify' || command === 'report') {
    const verified = await verifyTechnicalFeatureArtifact(required('--artifact'));
    process.stdout.write(
      command === 'verify'
        ? `${JSON.stringify({ hash: verified.hash, valid: true })}\n`
        : technicalFeatureReport(verified.artifact),
    );
    return;
  }
  let input: unknown, request: unknown;
  if (command === 'fixture') ({ input, request } = technicalFeatureFixture());
  else {
    if (options.has('--snapshot') === options.has('--artifact'))
      throw new Error('Choose one verified feature artifact or market snapshot');
    if (options.has('--artifact'))
      input = (await verifyTechnicalFeatureArtifact(required('--artifact'))).artifact.input;
    else {
      const snapshot = await verifyMarketSnapshot(required('--snapshot'));
      input = {
        schemaVersion: 'technical-feature-dataset.v1',
        marketSnapshots: [snapshot.manifest],
        bars: (await readMarketParquet(join(snapshot.directory, 'bars.parquet'))).map((r) => r.bar),
      };
    }
    request = await localJson(required('--request'));
  }
  const result = await writeTechnicalFeatureArtifact(
    input,
    request,
    options.get('--out') ?? 'data/technical-features',
    await workingTreeVersion(),
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        path: result.path,
        hash: result.hash,
        execution: 'DISABLED',
        synthetic:
          result.artifact.input.bars.length > 0 &&
          result.artifact.input.bars.every((b) => b.provenance.origin === 'FIXTURE'),
        rows: result.artifact.rows.length,
        readyValues: result.artifact.rows
          .flatMap((r) => r.features)
          .filter((f) => f.status === 'READY').length,
      },
      null,
      2,
    )}\n`,
  );
}
main(process.argv.slice(2)).catch(() => {
  process.stderr.write(
    'Technical features failed: invalid request or incompatible local evidence.\n',
  );
  process.exitCode = 1;
});
