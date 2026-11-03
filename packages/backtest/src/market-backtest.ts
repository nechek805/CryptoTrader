import {
  MarketBaselineManifestSchema,
  MarketBaselineReportSchema,
  MarketStrategySourceSchema,
  MarketFixtureSignalsSchema,
  MarketStrategyConfigSchema,
} from '@crypto/contracts';
import type {
  MarketBaselineManifest,
  MarketStrategySource,
  MarketStrategyConfig,
  BacktestOutcome,
} from '@crypto/contracts';
import { canonicalHash, deepFreeze } from '@crypto/core';
import { MarketSignalProvider } from '@crypto/strategies';
import { executeReplay } from './kernel.js';
import { simulateSpot } from './spot-simulator.js';
import { compileMarketTargets } from './market-sizing-bridge.js';
import { measureBacktest } from './backtest-metrics.js';
import { SpotEvidence } from './spot-evidence.js';
import { utcNanoseconds } from '@crypto/contracts';
function checkedManifest(input: unknown) {
  const m = MarketBaselineManifestSchema.parse(input),
    b = m.backtest,
    p = b.assumptions.policy;
  if (canonicalHash(b.input) !== b.inputHash)
    throw new Error('Market baseline input hash mismatch');
  const provider = new MarketSignalProvider(m.provider, marketSource(m));
  if (
    b.strategy.id !== provider.descriptor.id ||
    canonicalHash(b.strategy.config) !== canonicalHash(provider.descriptor.config)
  )
    throw new Error('Market manifest/provider fingerprint mismatch');
  if (
    utcNanoseconds(b.calendar.firstCloseAt) - utcNanoseconds(p.startAt) >
      BigInt(p.intervalSeconds) * 1000000000n ||
    utcNanoseconds(p.endAt) - utcNanoseconds(m.historyStartCloseAt) >
      BigInt(p.intervalSeconds) * 129000000000n
  )
    throw new Error('Market calendar work budget');
  const evidence = new SpotEvidence(
    {
      schemaVersion: 'spot-simulation-input.v1',
      market: b.input.market,
      bars: b.input.replay.bars,
      commands: [],
    },
    p,
  );
  if (
    !b.input.replay.bars.some(
      (bar) =>
        bar.availableAt !== null &&
        bar.availableAt >= p.startAt &&
        bar.availableAt < p.endAt &&
        evidence.bar(p.instrumentKeys[0]!, bar),
    )
  )
    throw new Error('No eligible in-window market prices');
  return m;
}
export function marketSource(m: MarketBaselineManifest): MarketStrategySource {
  const b = m.backtest,
    p = b.assumptions.policy;
  return MarketStrategySourceSchema.parse({
    schemaVersion: 'market-strategy-source.v1',
    market: b.input.market,
    sourceId: p.sourceId,
    instrumentKey: p.instrumentKeys[0]!,
    series: b.series,
    portfolio: 'BASELINE',
    intervalSeconds: p.intervalSeconds,
    historyStartCloseAt: m.historyStartCloseAt,
    maxBarDelayMs: p.maxBarDelayMs,
  });
}
function replay(m: MarketBaselineManifest, cfg: MarketStrategyConfig, code: string) {
  const b = m.backtest,
    p = b.assumptions.policy,
    provider = new MarketSignalProvider(cfg, marketSource(m)),
    r = executeReplay(
      b.input.replay,
      {
        schemaVersion: 'replay-request.v1',
        startAt: p.startAt,
        endAt: p.endAt,
        generatedAt: p.generatedAt,
        symbols: [b.series.instrumentId],
        randomSeed: p.randomSeed,
        snapshotEvery: 1,
        maxQueriesPerEvent: 20,
      },
      code,
      () => provider.strategy(),
    );
  return { provider, replay: r };
}
export function marketFixtureSignals(input: unknown, codeVersion: string) {
  const m = checkedManifest(input);
  if (m.provider.kind !== 'SYMMETRIC_MA_FIXTURE')
    throw new Error('Expected symmetric signal-only fixture');
  if (!m.backtest.input.replay.bars.every((b) => b.provenance.origin === 'FIXTURE'))
    throw new Error('Synthetic fixture bars required');
  const r = replay(m, m.provider, codeVersion),
    a = MarketFixtureSignalsSchema.parse({
      schemaVersion: 'market-fixture-signals.v1',
      execution: 'DISABLED',
      manifest: m,
      source: marketSource(m),
      config: m.provider,
      replay: r.replay,
    });
  deepFreeze(a);
  return a;
}
export function runMarketBaseline(input: unknown, codeVersion: string) {
  const m = checkedManifest(input),
    b = m.backtest,
    p = b.assumptions.policy;
  if (m.provider.kind === 'SYMMETRIC_MA_FIXTURE')
    throw new Error('Symmetric short targets are signal-only; spot borrowing is disabled');
  const main = new MarketSignalProvider(m.provider, marketSource(m));
  const outcomes: BacktestOutcome[] = [],
    sizing = [];
  for (const role of ['STRATEGY', 'CASH', 'BUY_AND_HOLD'] as const) {
    const cfg =
        role === 'STRATEGY'
          ? m.provider
          : MarketStrategyConfigSchema.parse({
              schemaVersion: 'market-strategy-config.v1',
              kind: role === 'CASH' ? 'CASH' : 'BUY_AND_HOLD',
              minimumBaseVolume: m.provider.minimumBaseVolume,
              staleAfterSeconds: m.provider.staleAfterSeconds,
              maxHoldingBars: 128,
              cooldownBars: 0,
              onMissing: 'HOLD',
              signalValiditySeconds: m.provider.signalValiditySeconds,
            }),
      r = replay(m, cfg, codeVersion),
      compiled = compileMarketTargets(r.replay, b, p, codeVersion),
      simulation = simulateSpot(
        {
          schemaVersion: 'spot-simulation-input.v1',
          market: b.input.market,
          bars: b.input.replay.bars,
          commands: compiled.commands,
        },
        p,
        codeVersion,
      );
    outcomes.push({ role, replay: r.replay, simulation, ...measureBacktest(simulation, b) });
    sizing.push({ role, decisions: compiled.decisions });
  }
  const report = MarketBaselineReportSchema.parse({
    schemaVersion: 'market-baseline-report.v1',
    execution: 'SIMULATED',
    liveExecution: 'DISABLED',
    codeVersion,
    manifest: m,
    manifestHash: canonicalHash(m),
    providerHash: main.providerHash,
    featureFingerprint: main.featureFingerprint,
    outcomes,
    sizing,
    warnings: [
      'Market-only providers ignore news and emit target intents, not broker fills. Warm-up, gaps, unavailable historical metadata and low volume remain explicit.',
      'Sizing is a fixed owned-asset target independent of scores, price, volatility or past PnL. No leverage or borrowed short execution exists.',
      'Target reconciliation occurs after receipts at decisionAt plus one nanosecond. Full-candle rules therefore wait for a later complete price window.',
      'Pending orders block new submissions; opposing orders are canceled. Rejected/expired target attempts are not retried until a new target transition.',
      'OHLCV depth, queues and intrabar paths are unknown. Costed synthetic fixtures are not evidence of profitability or generalization.',
      'Benchmarks use the same fixed quantity, post-receipt bridge, source, cost assumptions and initial cash. Marks and risk statistics remain sampled and may be unknown.',
      'ML training, parameter searches, ranking/model selection and statistical alpha claims are outside Module 09 Iteration 1.',
    ],
  });
  deepFreeze(report);
  return report;
}
export function validateMarketBaseline(input: unknown) {
  const a = MarketBaselineReportSchema.parse(input),
    b = runMarketBaseline(a.manifest, a.codeVersion);
  if (canonicalHash(a) !== canonicalHash(b)) throw new Error('Market baseline integrity mismatch');
  return b;
}
