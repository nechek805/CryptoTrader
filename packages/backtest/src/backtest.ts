import {
  BacktestManifestSchema,
  BacktestReportSchema,
  SpotSimulationRequestSchema,
  SpotCommandSchema,
  utcNanoseconds,
} from '@crypto/contracts';
import type {
  BacktestManifest,
  BacktestCase,
  BacktestOutcome,
  SpotSimulationRequest,
  ReplayArtifact,
} from '@crypto/contracts';
import { canonicalHash, deepFreeze, deterministicId, isAvailableAt, fromEpoch } from '@crypto/core';
import { executeReplay } from './kernel.js';
import { simulateSpot } from './spot-simulator.js';
import { backtestControl } from './backtest-controls.js';
import { measureBacktest, missingBacktestCloses } from './backtest-metrics.js';
import { D } from './spot-math.js';
import type { StrategyFactory } from './strategy.js';
import { SpotEvidence } from './spot-evidence.js';

function commands(
  replay: ReplayArtifact,
  manifest: BacktestManifest,
  policy: SpotSimulationRequest,
) {
  return replay.candidates
    .filter((c) => c.side !== 'HOLD')
    .map((c, index) => {
      if (c.symbol !== manifest.series.instrumentId)
        throw new Error('Candidate outside backtest opportunity set');
      const expiry = fromEpoch(
          utcNanoseconds(c.decisionAt) + BigInt(manifest.orderLifetimeSeconds) * 1000000000n,
          'nanoseconds',
        ),
        expiresAt = [expiry, c.validUntil, policy.endAt].sort()[0]!,
        intent = {
          clientOrderId: `backtest:order:${index + 1}`,
          portfolio: c.portfolio,
          instrumentKey: policy.instrumentKeys[0]!,
          side: c.side === 'LONG' ? 'BUY' : 'SELL',
          orderType: 'MARKET',
          quantity: manifest.quantity,
          limitPrice: null,
          marketPriceBound: c.side === 'LONG' ? manifest.buyPriceCap : manifest.sellPriceFloor,
          allowPartial: true,
          expiresAt,
          protection: null,
        },
        risk = {
          schemaVersion: 'risk-decision.v1',
          id: deterministicId('backtest-risk', {
            candidateId: c.id,
            policyHash: canonicalHash(policy),
          }),
          candidateId: c.id,
          portfolio: c.portfolio,
          decisionAt: c.decisionAt,
          allowed: true,
          ruleIds: ['backtest:predeclared-sizing.v1', 'backtest:inventory-and-cash-guard.v1'],
          sizing: {
            quantity: manifest.quantity,
            maxNotional: manifest.maxOrderNotional,
            currency: policy.quoteCurrency,
          },
          expiresAt,
          stopTargetPolicy: { kind: 'NONE' },
          audit: {
            inputHash: canonicalHash({
              candidate: c,
              quantity: manifest.quantity,
              maxNotional: manifest.maxOrderNotional,
            }),
            configHash: canonicalHash(policy),
            codeVersion: 'backtest-bounded-authorization.v1',
            reasons: [
              'Predeclared quantity/notional only; executor vetoes cash, inventory, timing and metadata violations. No general risk engine is claimed.',
            ],
          },
        };
      return SpotCommandSchema.parse({
        kind: 'SUBMIT',
        id: deterministicId('backtest-command', { candidateId: c.id, index }),
        at: c.decisionAt,
        sequence: index + 1,
        intent,
        candidate: c,
        risk,
      });
    });
}
function outcome(
  manifest: BacktestManifest,
  policy: SpotSimulationRequest,
  role: BacktestOutcome['role'],
  codeVersion: string,
  factory?: StrategyFactory,
): BacktestOutcome {
  const selected =
      role === 'STRATEGY'
        ? (factory ?? backtestControl(manifest, policy))
        : backtestControl(
            manifest,
            policy,
            role === 'CASH' ? 'control:no-trade' : 'control:buy-and-hold',
          ),
    replay = executeReplay(
      manifest.input.replay,
      {
        schemaVersion: 'replay-request.v1',
        startAt: policy.startAt,
        endAt: policy.endAt,
        generatedAt: policy.generatedAt,
        symbols: [manifest.series.instrumentId],
        randomSeed: policy.randomSeed,
        snapshotEvery: 1000,
        maxQueriesPerEvent: 20,
      },
      codeVersion,
      selected,
    ),
    simulation = simulateSpot(
      {
        schemaVersion: 'spot-simulation-input.v1',
        market: manifest.input.market,
        bars: manifest.input.replay.bars,
        commands: commands(replay, manifest, policy),
      },
      policy,
      codeVersion,
    );
  if (
    role === 'STRATEGY' &&
    (replay.strategy.portfolio !== 'BASELINE' ||
      replay.strategy.id !== manifest.strategy.id ||
      replay.strategy.version !== manifest.strategy.version ||
      canonicalHash(replay.strategy.config) !== canonicalHash(manifest.strategy.config))
  )
    throw new Error('Backtest strategy descriptor mismatch');
  return { role, replay, simulation, ...measureBacktest(simulation, manifest) };
}
export function runBacktest(input: unknown, codeVersion: string, factory?: StrategyFactory) {
  const manifest = BacktestManifestSchema.parse(input),
    p = manifest.assumptions.policy;
  if (canonicalHash(manifest.input) !== manifest.inputHash)
    throw new Error('Backtest input hash mismatch');
  if (
    utcNanoseconds(manifest.calendar.firstCloseAt) - utcNanoseconds(p.startAt) >
    BigInt(p.intervalSeconds) * 1000000000n
  )
    throw new Error('Backtest calendar starts too late');
  if (
    (manifest.input.replay.bars.length + manifest.input.replay.news.length) *
      (manifest.scenarios.length + 1) *
      3 >
    12000
  )
    throw new Error('Backtest scenario work budget');
  for (const field of manifest.strategy.requiredFields) {
    if (
      field === 'ORDER_BOOK_DEPTH' ||
      field === 'FUNDING_RATE' ||
      (field === 'TIMED_NEWS' &&
        !manifest.input.replay.news.some(
          (n) => n.availableAt !== null && n.availableAt < p.endAt && isAvailableAt(n, p.endAt),
        ))
    )
      throw new Error(`UNAVAILABLE_REQUIRED_FIELD:${field}`);
  }
  const ids = new Set(manifest.input.replay.bars.map((b) => b.id));
  for (const s of manifest.scenarios)
    if (s.omittedBarIds.some((id) => !ids.has(id))) throw new Error('Unknown omitted bar identity');
  const scenarios = [{ id: 'BASE', overrides: {}, omittedBarIds: [] }, ...manifest.scenarios],
    cases: BacktestCase[] = [];
  for (const scenario of scenarios) {
    const policy = SpotSimulationRequestSchema.parse({ ...p, ...scenario.overrides }),
      bars = manifest.input.replay.bars.filter((b) => !scenario.omittedBarIds.includes(b.id)),
      effective = {
        ...manifest,
        input: { ...manifest.input, replay: { ...manifest.input.replay, bars } },
      },
      evidence = new SpotEvidence(
        {
          schemaVersion: 'spot-simulation-input.v1',
          market: effective.input.market,
          bars,
          commands: [],
        },
        policy,
      );
    if (
      !bars.some(
        (b) =>
          b.availableAt !== null &&
          b.availableAt >= policy.startAt &&
          b.availableAt < policy.endAt &&
          evidence.bar(policy.instrumentKeys[0]!, b) !== null,
      )
    )
      throw new Error('UNAVAILABLE_REQUIRED_FIELD:CLOSED_OHLCV');
    const outcomes = (['STRATEGY', 'CASH', 'BUY_AND_HOLD'] as const).map((role) =>
        outcome(effective, policy, role, codeVersion, factory),
      ),
      assumptions = { ...manifest.assumptions, policy },
      base = cases[0];
    let feeCheck: BacktestCase['feeCheck'] =
      scenario.id === 'BASE' ? 'BASE' : 'NOT_HIGHER_FEE_ONLY';
    const feeOnly =
      scenario.id !== 'BASE' &&
      scenario.omittedBarIds.length === 0 &&
      Object.keys(scenario.overrides).every((k) => k === 'makerRate' || k === 'takerRate') &&
      new D(policy.makerRate).gte(p.makerRate) &&
      new D(policy.takerRate).gte(p.takerRate);
    if (feeOnly && base) {
      const identical = outcomes.every(
        (o, i) =>
          o.fillFingerprint === base.outcomes[i]!.fillFingerprint &&
          o.metrics.grossPnl !== null &&
          base.outcomes[i]!.metrics.grossPnl !== null,
      );
      feeCheck = identical
        ? 'IDENTICAL_GROSS_NET_NONINCREASING'
        : 'CHANGED_EXECUTION_OR_UNKNOWN_MARKS';
      if (identical)
        for (const [i, o] of outcomes.entries()) {
          const b = base.outcomes[i]!.metrics;
          if (!new D(o.metrics.grossPnl!).eq(b.grossPnl!) || new D(o.metrics.netPnl!).gt(b.netPnl!))
            throw new Error('Fee invariance violation');
        }
    }
    cases.push({
      id: scenario.id,
      assumptions,
      assumptionsHash: canonicalHash(assumptions),
      effectiveInputHash: canonicalHash(effective.input),
      omittedBarIds: scenario.omittedBarIds,
      missingCloseTimes: missingBacktestCloses(bars, effective, policy),
      outcomes,
      feeCheck,
    });
  }
  const manifestHash = canonicalHash(manifest),
    report = BacktestReportSchema.parse({
      schemaVersion: 'backtest-report.v1',
      execution: 'SIMULATED',
      liveExecution: 'DISABLED',
      algorithmVersion: 'backtest-controls.v1',
      codeVersion,
      manifest,
      manifestHash,
      runId: deterministicId('backtest-run', { manifestHash, codeVersion }),
      cases,
      clockSemantics: 'utc-nanoseconds.v1',
      randomAlgorithm: 'mulberry32.v1',
      valuationPolicy: 'AVAILABLE_CLOSE_NO_FORWARD_FILL_BEYOND_AGE_V1',
      tradePolicy: 'FIFO_FEE_ALLOCATION_V1',
      warnings: [
        'OHLCV depth, maker queues and intrabar paths are unknown; conservative execution assumptions are not guaranteed historical fills.',
        'End-of-timestamp equity uses only available, valid, fresh closes. Missing marks remain null; drawdown/exposure summaries are unknown if any equity point is unknown.',
        'Drawdown and exposure maxima use reported valuation points only; intrabar risk is unknown.',
        'Gross results include modeled spread/slippage; gross-to-net drag is explicit fees. Fee invariance applies only to identical executed quantity/price paths.',
        'Cash and buy-and-hold are separate counterfactual accounts with identical input, starting cash, opportunity set and execution assumptions.',
        'Only declared research controls are registered. News-only, market-only and fusion engines, a general risk policy, ML, statistical significance and live trading are not implemented.',
        'Synthetic losing/leaking controls are test diagnostics, not strategy recommendations. Complete cohort coverage or profitability is not established.',
        'Scenarios are predeclared counterfactuals, not independent samples. No significance, confidence interval, annualization or best-scenario selection is claimed.',
      ],
    });
  deepFreeze(report);
  return report;
}
export function validateBacktestReport(input: unknown, factory?: StrategyFactory) {
  const report = BacktestReportSchema.parse(input),
    expected = runBacktest(report.manifest, report.codeVersion, factory);
  if (canonicalHash(report) !== canonicalHash(expected))
    throw new Error('Backtest report integrity mismatch');
  return expected;
}
