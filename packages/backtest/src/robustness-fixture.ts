import {
  MarketBarSchema,
  MarketRobustnessPlanSchema,
  MarketBaselineManifestSchema,
  BacktestManifestSchema,
} from '@crypto/contracts';
import type { MarketMlModel, RobustScenario, RobustTrial } from '@crypto/contracts';
import { canonicalHash, fromEpoch } from '@crypto/core';
import { marketMlFixture, MarketSignalProvider } from '@crypto/strategies';
import { marketBaselineFixture } from './market-fixture.js';
import { marketSource } from './market-backtest.js';
/** Sparse, predeclared synthetic stress design; includes all nine base asset/regime cells. */
export function robustnessFixture(modelsInput: readonly MarketMlModel[] = []) {
  const at = (s: number) => fromEpoch(1767225600n + BigInt(s), 'seconds'),
    f = marketMlFixture(),
    specs: {
      asset: 'BTC' | 'ETH' | 'SOL';
      regime: 'TREND' | 'WHIPSAW' | 'REVERSAL';
      stress: RobustScenario['stress'];
    }[] = [];
  for (const asset of ['BTC', 'ETH', 'SOL'] as const)
    for (const regime of ['TREND', 'WHIPSAW', 'REVERSAL'] as const)
      specs.push({ asset, regime, stress: 'BASE' });
  specs.push(
    { asset: 'BTC', regime: 'WHIPSAW', stress: 'HIGH_COST' },
    { asset: 'ETH', regime: 'REVERSAL', stress: 'VOLATILITY_SHIFT' },
    { asset: 'SOL', regime: 'TREND', stress: 'COST_AND_VOLATILITY' },
  );
  const scenarios = specs.map(({ asset, regime, stress }) => {
    const old = marketBaselineFixture(asset, regime),
      history = f.input.technicalArtifacts.find((a) => a.request.series.asset === asset)!.input
        .bars,
      last = history.at(-1)!,
      base = Number(last.close),
      mult = stress === 'VOLATILITY_SHIFT' || stress === 'COST_AND_VOLATILITY' ? 2.5 : 1;
    const bars = [
      ...history,
      ...Array.from({ length: 16 }, (_, i) => {
        const j = i - 4,
          delta =
            j < 0
              ? 0
              : regime === 'TREND'
                ? j
                : regime === 'WHIPSAW'
                  ? j % 6 < 3
                    ? 3
                    : -3
                  : j < 6
                    ? j
                    : 10 - j,
          price = String(base + mult * delta);
        return MarketBarSchema.parse({
          ...last,
          id: `synthetic:robust:${asset}:${regime}:${stress}:${i + 1}`,
          openAt: at(5760 + i * 60),
          closeAt: at(5820 + i * 60),
          availableAt: at(5820 + i * 60),
          open: price,
          high: price,
          low: price,
          close: price,
          volume: '1000',
          sourceVersion: 'synthetic-robustness.v1',
          provenance: {
            ...last.provenance,
            capturedAt: at(5820 + i * 60),
            sourceVersion: 'synthetic-robustness.v1',
            parentIds: [
              canonicalHash({ asset, regime, stress, i, price, recipe: 'synthetic-robustness.v1' }),
            ],
          },
        });
      }),
    ];
    const input = { ...old.backtest.input, replay: { ...old.backtest.input.replay, bars } },
      p = {
        ...old.backtest.assumptions.policy,
        startAt: fromEpoch(1767231600000000001n, 'nanoseconds'),
        endAt: at(6721),
        generatedAt: at(6780),
        ...(stress === 'HIGH_COST' || stress === 'COST_AND_VOLATILITY'
          ? { takerRate: '0.003', spreadBps: '30', slippageBps: '15' }
          : {}),
      };
    const shell = {
      ...old,
      backtest: BacktestManifestSchema.parse({
        ...old.backtest,
        input,
        inputHash: canonicalHash(input),
        assumptions: { ...old.backtest.assumptions, declaredAt: at(6000), policy: p },
        calendar: { firstCloseAt: at(6060) },
        cohortDisclosure: `SYNTHETIC robustness ${asset}/${regime}/${stress}, predeclared sparse 12-cell stress design.`,
      }),
    };
    const provider = new MarketSignalProvider(shell.provider, marketSource(shell)),
      manifest = MarketBaselineManifestSchema.parse({
        ...shell,
        backtest: {
          ...shell.backtest,
          strategy: {
            ...shell.backtest.strategy,
            id: provider.descriptor.id,
            config: provider.descriptor.config,
          },
        },
      });
    return {
      id: `${asset}_${regime}_${stress}`,
      asset,
      regime,
      stress,
      parentScenarioId: stress === 'BASE' ? null : `${asset}_${regime}_BASE`,
      manifest,
    };
  });
  const base = scenarios[0]!.manifest.provider as Extract<
    (typeof scenarios)[number]['manifest']['provider'],
    { kind: 'MA_CROSSOVER' }
  >;
  const trials: RobustTrial[] = [
    {
      id: 'MA_2_4',
      family: 'MA',
      change: 'BASE',
      parentTrialId: null,
      provider: base,
      modelId: null,
    },
    {
      id: 'MA_3_5',
      family: 'MA',
      change: 'PARAMETER',
      parentTrialId: 'MA_2_4',
      provider: { ...base, fastPeriod: 3, slowPeriod: 5 },
      modelId: null,
    },
    {
      id: 'BREAKOUT_4_2',
      family: 'BREAKOUT',
      change: 'BASE',
      parentTrialId: null,
      provider: marketBaselineFixture('BTC', 'TREND', 'BREAKOUT').provider,
      modelId: null,
    },
    {
      id: 'ZSCORE_4',
      family: 'REVERSION',
      change: 'BASE',
      parentTrialId: null,
      provider: marketBaselineFixture('BTC', 'TREND', 'ZSCORE_REVERSION').provider,
      modelId: null,
    },
  ];
  for (const [i, model] of modelsInput.entries())
    trials.push({
      id: ['ML_H2_CONTROL', 'ML_H3_FULL', 'ML_H3_NO_RETURN2', 'ML_H3_L2_002'][i]!,
      family: 'ML',
      change:
        i === 0 ? 'BASE' : i === 1 ? 'HORIZON_VERSION' : i === 2 ? 'FEATURE_ABLATION' : 'PARAMETER',
      parentTrialId: i === 0 ? null : i === 1 ? 'ML_H2_CONTROL' : 'ML_H3_FULL',
      provider: null,
      modelId: model.id,
    });
  return MarketRobustnessPlanSchema.parse({
    schemaVersion: 'market-robustness-plan.v1',
    experimentVersion: 'synthetic-robustness.v1',
    parentReportHash: null,
    priorTrialCount: 49,
    priorDisclosure:
      'Conservative declared prior floor: 45 Module 09 baseline cases plus four original ML calibration trials. Imported/new calibration grids and every current case are also counted; reused evidence may be deliberately overcounted.',
    declaredAt: at(6000),
    generatedAt: at(6780),
    randomSeed: 42,
    models: modelsInput,
    trials,
    scenarios,
    policy: {
      ranking: 'MEAN_NET_MINUS_WORST_DRAWDOWN_MINUS_CVAR05_V1',
      uncertainty: 'JOINT_CIRCULAR_TIME_BLOCK_BOOTSTRAP_V1',
      blockLength: 3,
      resamples: 4096,
      minimumBlocks: 8,
      alpha: 0.05,
      maxCandidates: 2,
      maxDrawdown: 0.1,
      maxTailLoss: 0.05,
      syntheticPromotion: 'FORBIDDEN',
    },
  });
}
