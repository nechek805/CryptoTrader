import { lstat, readFile } from 'node:fs/promises';
import {
  appendHypothesisCard,
  hypothesisFixture,
  hypothesisRegistryReport,
  hypothesisNewsStrategyInputs,
  verifyHypothesisRegistry,
  writeHypothesisRegistry,
} from '@crypto/research';
import { workingTreeVersion } from './database-fixtures.js';

async function jsonFile(path: string, limit: number) {
  const info = await lstat(path);
  if (!info.isFile() || info.size > limit) throw new Error('Invalid hypothesis input file');
  const bytes = await readFile(path);
  if (bytes.length > limit) throw new Error('Hypothesis input limit');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
}
export async function hypothesesCommand(args: string[]) {
  const command = args[0],
    options = new Map<string, string>(),
    allowed =
      command === 'hypothesis-fixture'
        ? ['--out']
        : command === 'hypothesis-build'
          ? ['--input', '--request', '--out']
          : command === 'hypothesis-revise'
            ? ['--artifact', '--revision', '--out']
            : command === 'hypothesis-inputs'
              ? ['--artifact', '--at', '--purpose']
              : command === 'hypothesis-verify' || command === 'hypothesis-report'
                ? ['--artifact']
                : null;
  if (!allowed) throw new Error('Invalid hypothesis command');
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
  if (
    command === 'hypothesis-verify' ||
    command === 'hypothesis-report' ||
    command === 'hypothesis-inputs'
  ) {
    const verified = await verifyHypothesisRegistry(required('--artifact'));
    if (command === 'hypothesis-verify')
      process.stdout.write(`${JSON.stringify({ hash: verified.hash, valid: true })}\n`);
    else if (command === 'hypothesis-report')
      process.stdout.write(hypothesisRegistryReport(verified.artifact));
    else
      process.stdout.write(
        `${JSON.stringify(hypothesisNewsStrategyInputs(verified.artifact, { decisionAt: required('--at'), purpose: options.get('--purpose') ?? 'NEWS_STRATEGY_RESEARCH' }), null, 2)}\n`,
      );
    return;
  }
  let input: unknown, request: unknown;
  if (command === 'hypothesis-fixture') ({ input, request } = await hypothesisFixture());
  else if (command === 'hypothesis-revise') {
    const previous = (await verifyHypothesisRegistry(required('--artifact'))).artifact,
      at = new Date().toISOString(),
      revision = appendHypothesisCard(
        previous.input.cards,
        await jsonFile(required('--revision'), 16384),
        at,
      );
    input = { ...previous.input, cards: [...previous.input.cards, revision] };
    request = { ...previous.request, generatedAt: at };
  } else {
    input = await jsonFile(required('--input'), 64 * 1024 * 1024);
    request = await jsonFile(required('--request'), 16384);
  }
  const result = await writeHypothesisRegistry(
    input,
    request,
    options.get('--out') ?? 'data/hypothesis-registry',
    await workingTreeVersion(),
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        path: result.path,
        hash: result.hash,
        execution: 'DISABLED',
        synthetic: result.artifact.synthetic,
        cards: result.artifact.evaluations.length,
        negativeFindings: result.artifact.evaluations.filter(
          (e) => e.finding === 'CONTRADICTED_IN_SAMPLE',
        ).length,
        quarantined: result.artifact.evaluations.reduce(
          (n, e) => n + e.validation.quarantinedCount + e.selection.quarantinedCount,
          0,
        ),
      },
      null,
      2,
    )}\n`,
  );
}
