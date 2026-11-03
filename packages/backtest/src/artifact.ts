import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { canonicalHash, canonicalJson } from '@crypto/core';
import { executeReplay, validateReplayArtifact } from './kernel.js';
import { createNoTradeControl } from './strategy.js';
import type { StrategyFactory } from './strategy.js';

const limit = 64 * 1024 * 1024;
export async function verifyReplayArtifact(
  path: string,
  factory: StrategyFactory = createNoTradeControl,
) {
  const info = await lstat(path);
  if (!info.isFile() || info.size > limit) throw new Error('Invalid replay artifact file');
  const bytes = await readFile(path);
  if (bytes.length > limit) throw new Error('Replay artifact limit');
  const artifact = validateReplayArtifact(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
      factory,
    ),
    hash = canonicalHash(artifact);
  if (basename(path) !== `replay_${hash.slice(7)}.json`)
    throw new Error('Replay artifact name mismatch');
  return { path, hash, artifact };
}
export async function writeReplayArtifact(
  input: unknown,
  request: unknown,
  rootInput: string,
  codeVersion: string,
  factory: StrategyFactory = createNoTradeControl,
) {
  const artifact = validateReplayArtifact(
      executeReplay(input, request, codeVersion, factory),
      factory,
    ),
    hash = canonicalHash(artifact),
    text = `${canonicalJson(artifact)}\n`;
  if (Buffer.byteLength(text) > limit) throw new Error('Replay artifact limit');
  await mkdir(rootInput, { recursive: true });
  const root = await realpath(rootInput),
    path = join(root, `replay_${hash.slice(7)}.json`),
    temporary = join(root, `.replay-${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx');
  try {
    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, path);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      const old = await verifyReplayArtifact(path, factory);
      if (old.hash !== hash) throw new Error('Existing replay artifact mismatch', { cause: error });
    }
  } finally {
    await unlink(temporary);
  }
  return { path, hash, artifact };
}
export function replayReport(input: unknown, factory: StrategyFactory = createNoTradeControl) {
  const a = validateReplayArtifact(input, factory),
    m = a.manifest;
  return [
    '# Deterministic replay research handoff',
    '',
    `Execution: DISABLED. Strategy: ${a.strategy.id} ${a.strategy.version}.`,
    `Run: ${m.runId}. Input: ${m.inputHash}. Config: ${m.configHash}. Software: ${m.codeVersion}.`,
    `Period: [${a.request.startAt}, ${a.request.endAt}). Generated: ${m.generatedAt}.`,
    `Seed: ${m.randomSeed} (${m.randomAlgorithm}); event order: ${m.eventOrderHash}.`,
    '',
    `Events ${m.eventCount}; decision callbacks ${m.decisionCount}; candidates ${m.candidateCount}; excluded inputs ${m.exclusions.length}.`,
    `HOLD ${a.candidates.filter((c) => c.side === 'HOLD').length}; LONG ${a.candidates.filter((c) => c.side === 'LONG').length}; SHORT ${a.candidates.filter((c) => c.side === 'SHORT').length}.`,
    `Candidates: ${m.candidatesHash}. Final state: ${m.finalStateHash}. Log: ${m.logHash}. Snapshots: ${m.snapshotsHash}.`,
    '',
    'Events are ordered by availableAt, kind and original record ID. Queries see only the delivered prefix, including at equal timestamps. Query violations fail the run even if the callback catches them.',
    'Candidates record the exact inclusive dataCutoff and logical sequence in the event log. Historical queries can use earlier cutoffs; future requests/undelivered IDs fail. Late corrections never rewrite earlier callbacks.',
    'Snapshots are audit checkpoints; continuation/resume is not implemented. Strategy callbacks are trusted local code, not a security sandbox. They must use the supplied clock/randomness and explicit JSON state.',
    '',
    'No execution, cost model, broker, orders, fills, balances or PnL. The no-trade control emits HOLD for market events; news events update state without inferring an affected symbol.',
    ...m.exclusions.map((e) => `- ${e.kind} ${e.recordId}: ${e.reason}`),
    '',
    `Source origins: ${[...new Set([...a.input.bars, ...a.input.news].map((r) => r.provenance.origin))].join(', ')}. Fixture records are synthetic; hashes are not source authentication.`,
    '',
    'Next: Module 08, Iteration 2 — Fill, Costs and Portfolio Ledger.',
    '',
  ].join('\n');
}
