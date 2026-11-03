import {
  BacktestManifestSchema,
  MarketBaselineManifestSchema,
  MarketBarSchema,
  MarketStrategyConfigSchema,
} from '@crypto/contracts';
import type { MarketStrategyConfig } from '@crypto/contracts';
import { canonicalHash, fromEpoch } from '@crypto/core';
import { crossFeatureFixture } from '@crypto/research';
import { MarketSignalProvider } from '@crypto/strategies';
import { backtestFixture } from './backtest-fixture.js';
import { marketSource } from './market-backtest.js';

/** Predeclared fictional regimes, not observations, tuning data or model selection. */
export function marketBaselineFixture(
  asset: 'BTC' | 'ETH' | 'SOL' = 'BTC',
  regime: 'TREND' | 'WHIPSAW' | 'REVERSAL' = 'TREND',
  kind: MarketStrategyConfig['kind'] = 'MA_CROSSOVER',
) {
  if (!['BTC', 'ETH', 'SOL'].includes(asset) || !['TREND', 'WHIPSAW', 'REVERSAL'].includes(regime))
    throw new Error('Unknown synthetic fixture');
  const at = (s: number) => fromEpoch(1767225600n + BigInt(s), 'seconds'),
    raw = crossFeatureFixture(),
    old = backtestFixture(),
    key = `cross:SPOT:${asset}`,
    base = { BTC: 100, ETH: 50, SOL: 20 }[asset];
  const provider = MarketStrategyConfigSchema.parse({
    schemaVersion: 'market-strategy-config.v1',
    kind,
    minimumBaseVolume: '1',
    staleAfterSeconds: 120,
    maxHoldingBars: 128,
    cooldownBars: 1,
    onMissing: 'EXIT',
    signalValiditySeconds: 1800,
    ...(kind === 'MA_CROSSOVER' || kind === 'SYMMETRIC_MA_FIXTURE'
      ? { fastPeriod: 2, slowPeriod: 4, average: 'SMA' }
      : kind === 'BREAKOUT'
        ? { lookbackBars: 4, exitLookbackBars: 2, entryBufferBps: '0' }
        : kind === 'ZSCORE_REVERSION'
          ? { lookbackBars: 4, entryThreshold: '1.25', exitThreshold: '0' }
          : {}),
  });
  const template = raw.input.technical.bars.find(
    (b) => b.instrumentId === `${asset}/USDT` && b.marketType === 'SPOT',
  )!;
  const bars = Array.from({ length: 24 }, (_, i) => {
    const price = String(
      regime === 'TREND'
        ? base + i
        : regime === 'WHIPSAW'
          ? base + (i % 6 < 3 ? 3 : -3)
          : base + (i < 12 ? i : 22 - i),
    );
    return MarketBarSchema.parse({
      ...template,
      id: `synthetic:market:${asset}:${regime}:${i + 1}`,
      openAt: at(i * 60),
      closeAt: at((i + 1) * 60),
      availableAt: at((i + 1) * 60),
      open: price,
      high: price,
      low: price,
      close: price,
      volume: '1000',
      sourceVersion: 'synthetic-market-baselines.v1',
      provenance: {
        ...template.provenance,
        capturedAt: at((i + 1) * 60),
        sourceVersion: 'synthetic-market-baselines.v1',
        parentIds: [
          canonicalHash({ asset, regime, i, price, recipe: 'synthetic-market-baselines.v1' }),
        ],
      },
    });
  });
  const input = {
    ...old.input,
    market: {
      ...old.input.market,
      instruments: raw.input.market.instruments.filter((m) => m.instrumentKey === key),
      observations: [],
    },
    replay: { ...old.input.replay, bars, news: [] },
  };
  const m = {
    ...old,
    input,
    inputHash: canonicalHash(input),
    series: { ...old.series, asset, instrumentId: `${asset}/USDT` },
    assumptions: {
      ...old.assumptions,
      policy: {
        ...old.assumptions.policy,
        instrumentKeys: [key],
        initialBalances: [
          { asset: 'USDT', amount: '1000' },
          { asset, amount: '0' },
        ],
        endAt: at(1441),
        generatedAt: at(1500),
        spreadBps: '10',
        slippageBps: '5',
      },
    },
    scenarios: [],
    cohortDisclosure: `SYNTHETIC ${asset} ${regime}; fixed recipe, not historical data or an alpha claim.`,
  };
  const shell = {
    schemaVersion: 'market-baseline-manifest.v1' as const,
    backtest: BacktestManifestSchema.parse(m),
    provider,
    historyStartCloseAt: at(60),
    regime,
    bridge: 'POST_RECEIPT_TARGET_NO_RETRY_V1' as const,
  };
  const p = new MarketSignalProvider(provider, marketSource(shell));
  return MarketBaselineManifestSchema.parse({
    ...shell,
    backtest: {
      ...m,
      strategy: {
        id: p.descriptor.id,
        version: '1',
        config: p.descriptor.config,
        requiredFields: ['CLOSED_OHLCV'],
      },
    },
  });
}
