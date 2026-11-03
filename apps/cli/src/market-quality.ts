import { buildMarketQueryApp } from '@crypto/api';
import { marketQualityFixture } from '@crypto/connectors';
import { MarketQualityReportRequestSchema } from '@crypto/contracts';
import {
  SnapshotMarketData,
  verifyMarketQualityArtifact,
  writeMarketQualityArtifact,
} from '@crypto/research';
import { resolve } from 'node:path';
import { workingTreeVersion } from './database-fixtures.js';

export function fixtureQualityRequest() {
  const window = {
    decisionAt: '2026-01-01T00:04:03Z',
    from: '2026-01-01T00:00:00Z',
    to: '2026-01-01T00:04:00Z',
    intervalSeconds: 60,
  };
  return MarketQualityReportRequestSchema.parse({
    schemaVersion: 'market-quality-report-request.v1',
    universe: {
      schemaVersion: 'market-universe-query.v1',
      ...window,
      sourceId: 'synthetic:alpha',
      quoteAssetId: 'asset:USDT',
      marketType: 'SPOT',
      count: 3,
      minQuoteVolume: '1',
      minLiquidityQuote: '100',
      minCoverageFraction: '1',
      maxWindowAgeMs: 5000,
      maxObservationAgeMs: 5000,
      maxAbsDriftMs: 500,
    },
    quality: [
      ...['alpha', 'beta'].flatMap((venue) =>
        ['BTC', 'ETH', 'SOL'].map((asset) => ({
          schemaVersion: 'market-quality-query.v1',
          ...window,
          sourceId: `synthetic:${venue}`,
          instrumentKey: `${venue}:SPOT:${asset}`,
          mode: 'ELIGIBLE',
          spikeThresholdBps: '1000',
          maxAbsDriftMs: 500,
        })),
      ),
      {
        schemaVersion: 'market-quality-query.v1',
        ...window,
        sourceId: 'synthetic:alpha',
        instrumentKey: 'alpha:PERPETUAL:BTC',
        mode: 'ELIGIBLE',
        spikeThresholdBps: '1000',
        maxAbsDriftMs: 500,
      },
    ],
    comparisons: ['BTC', 'ETH', 'SOL'].map((asset) => ({
      schemaVersion: 'market-cross-venue-query.v1',
      ...window,
      left: { sourceId: 'synthetic:alpha', instrumentKey: `alpha:SPOT:${asset}` },
      right: { sourceId: 'synthetic:beta', instrumentKey: `beta:SPOT:${asset}` },
      toleranceMs: 250,
      divergenceThresholdBps: '500',
    })),
    history: ['BTC', 'SOL', 'OLD', 'NEW'].map((asset) => ({
      schemaVersion: 'market-history-query.v1',
      sourceId: 'synthetic:alpha',
      instrumentKey: `alpha:SPOT:${asset}`,
      decisionAt: window.decisionAt,
    })),
  });
}
export async function marketQualityCommand(args: string[]) {
  const command = args[0],
    allowed =
      command === 'quality'
        ? ['--provider', '--out']
        : command === 'verify-quality'
          ? ['--artifact']
          : command === 'serve-fixture'
            ? ['--port']
            : [];
  const flags = new Map<string, string>();
  for (let i = 1; i < args.length; i += 2) {
    const key = args[i],
      value = args[i + 1];
    if (!key || !value || !allowed.includes(key) || flags.has(key) || value.startsWith('--'))
      throw new Error('Invalid quality flags');
    flags.set(key, value);
  }
  if (command === 'serve-fixture') {
    const port = flags.get('--port') ?? '3001';
    if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)
      throw new Error('Invalid port');
    const data = new SnapshotMarketData(marketQualityFixture()),
      app = buildMarketQueryApp(data);
    await app.listen({ host: '127.0.0.1', port: Number(port) });
    const close = () => {
      void app.close();
    };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: 'market-query-service.v1', mode: 'fixture-only', execution: 'DISABLED', url: `http://127.0.0.1:${port}`, datasetHash: data.datasetHash })}\n`,
    );
    return;
  }
  if (command === 'verify-quality') {
    const path = flags.get('--artifact');
    if (!path) throw new Error('Missing artifact');
    const result = await verifyMarketQualityArtifact(resolve(path));
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: 'market-quality-verification.v1', verified: true, hash: result.hash, datasetHash: result.artifact.datasetHash })}\n`,
    );
    return;
  }
  if (flags.has('--provider') && flags.get('--provider') !== 'fixture')
    throw new Error('Quality CLI requires fixture provider');
  const result = await writeMarketQualityArtifact(
    marketQualityFixture(),
    fixtureQualityRequest(),
    resolve(flags.get('--out') ?? 'data/market-quality'),
    await workingTreeVersion(),
  );
  process.stdout.write(
    `${JSON.stringify({ schemaVersion: 'market-quality-cli-report.v1', origin: 'SYNTHETIC', execution: 'DISABLED', path: result.path, hash: result.hash, datasetHash: result.artifact.datasetHash, universe: result.artifact.report.universe.selected.map((v) => v.instrument.instrumentKey), quality: result.artifact.report.quality.map((q) => ({ instrumentKey: q.request.instrumentKey, missingFraction: q.missingFraction, spikes: q.spikes.length, driftViolations: q.driftViolationIds.length, unavailableMetrics: q.unavailableMetrics })), alignment: result.artifact.report.comparisons.map((c) => ({ left: c.request.left.instrumentKey, right: c.request.right.instrumentKey, toleranceMs: c.request.toleranceMs, matched: c.matches.length, unmatchedLeft: c.unmatchedLeftIds.length, divergent: c.matches.filter((m) => m.divergent).length })) }, null, 2)}\n`,
  );
}
