import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { canonicalHash, canonicalJson } from '@crypto/core';
import { simulateSpot, validateSpotSimulationArtifact } from './spot-simulator.js';
const limit = 64 * 1024 * 1024;
export async function verifySpotSimulationArtifact(path: string) {
  const info = await lstat(path);
  if (!info.isFile() || info.size > limit) throw new Error('Invalid spot simulation file');
  const b = await readFile(path);
  if (b.length > limit) throw new Error('Spot artifact size limit');
  const artifact = validateSpotSimulationArtifact(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(b)),
    ),
    hash = canonicalHash(artifact);
  if (basename(path) !== `spot-simulation_${hash.slice(7)}.json`)
    throw new Error('Spot simulation artifact name mismatch');
  return { path, hash, artifact };
}
export async function writeSpotSimulationArtifact(
  input: unknown,
  request: unknown,
  rootInput: string,
  codeVersion: string,
) {
  const artifact = simulateSpot(input, request, codeVersion),
    hash = canonicalHash(artifact),
    text = `${canonicalJson(artifact)}\n`;
  if (Buffer.byteLength(text) > limit) throw new Error('Spot artifact size limit');
  await mkdir(rootInput, { recursive: true });
  const root = await realpath(rootInput),
    path = join(root, `spot-simulation_${hash.slice(7)}.json`),
    temporary = join(root, `.spot-${randomUUID()}.tmp`),
    handle = await open(temporary, 'wx');
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
      const old = await verifySpotSimulationArtifact(path);
      if (old.hash !== hash) throw new Error('Existing spot artifact mismatch', { cause: error });
    }
  } finally {
    await unlink(temporary);
  }
  return { path, hash, artifact };
}
export function spotSimulationReport(input: unknown) {
  const a = validateSpotSimulationArtifact(input),
    safe = (s: string) => s.replaceAll('|', '\\|').replaceAll('\n', ' ');
  return [
    '# Spot fill and ledger handoff',
    '',
    `Execution: SIMULATED; live execution: DISABLED. Run ${a.runId}.`,
    `Input ${a.inputHash}; config ${a.configHash}; software ${a.codeVersion}.`,
    `Orders ${a.orders.length}; fills ${a.fills.length}; journal transactions ${a.journal.length}; excluded bars ${a.excludedBars.length}.`,
    '',
    '| Portfolio | Asset | Free | Reserved |',
    '| --- | --- | ---: | ---: |',
    ...a.balances.map((b) => `| ${b.portfolio} | ${b.asset} | ${b.free} | ${b.reserved} |`),
    '',
    '| Fill | Side | Quantity | Modeled price | Fee | Trigger |',
    '| --- | --- | ---: | ---: | ---: | --- |',
    ...a.fills.map(
      (f) =>
        `| ${safe(f.fill.id)} | ${f.fill.side} | ${f.fill.quantity} | ${f.fill.price} | ${f.fill.fee} ${f.fill.feeCurrency} | ${f.trigger ?? 'NONE'} |`,
    ),
    '',
    `Journal ${a.reconciliation.journalHash}; fills ${a.reconciliation.fillsHash}; balances ${a.reconciliation.balancesHash}.`,
    'All posting groups balance per portfolio and asset; reservations match open virtual orders at every action. No negative cash/inventory, borrowing, leverage or duplicate fills.',
    '',
    'OHLCV depth and maker queues are unknown. Modeled market buys use adverse candle highs; sells use adverse lows plus declared spread/slippage and tick rounding. Limits require strict penetration and the shared volume cap; this is an execution assumption, not a guaranteed historical fill.',
    'Orders must be active before the full candle opens; outcomes are recorded only at source availability. Publication delays are bounded. Mid-candle orders/cancellation cannot reconstruct an intrabar path. Late/revised candles never supply new liquidity.',
    'Protective exits are inventory-backed reduce-only virtual market orders. Stop wins whenever stop and target are touched in one eligible candle. Targets use taker fees; stop gaps can execute worse than the stop. Entry-bar history never becomes a retroactive exit.',
    '',
    ...a.fills.flatMap((f) => f.flags.map((flag) => `- ${safe(f.fill.id)}: ${safe(flag)}`)),
    ...a.orders
      .filter((o) => o.rejectionReason !== null)
      .map((o) => `- REJECTED ${safe(o.order.clientOrderId)}: ${safe(o.rejectionReason!)}`),
    ...a.excludedBars.map((b) => `- EXCLUDED ${safe(b.recordId)}: ${safe(b.reason)}`),
    '',
    `Source origins: ${[...new Set(a.input.market.sources.map((s) => s.origin))].join(', ')}. Fixture evidence and manual risk permits are synthetic. Hashes establish local consistency, not provider authenticity.`,
    '',
    'No strategy performance, equity curve, benchmark comparison or derivatives model is implemented. Finalization releases outstanding reservations without fabricating liquidation prices. Next: Module 08, Iteration 3 — Research Controls and Sensitivity.',
    '',
  ].join('\n');
}
