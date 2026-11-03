import { BacktestManifestSchema, MarketBarSchema } from '@crypto/contracts';
import { canonicalHash, fromEpoch } from '@crypto/core';
import { spotSimulationFixture } from './spot-fixture.js';
import { crossFeatureFixture } from '@crypto/research';
/** Entirely fictional controls and falling prices, explicitly designed to retain a losing result. */
export function backtestFixture() {
  const at = (s: number) => fromEpoch(1767225600n + BigInt(s), 'seconds'),
    base = spotSimulationFixture(),
    raw = crossFeatureFixture(),
    prices = [100, 120, 110, 80, 90, 90],
    bars = raw.input.technical.bars
      .filter((b) => b.instrumentId === 'BTC/USDT' && b.marketType === 'SPOT')
      .slice(0, 6)
      .map((b, i) => {
        const price = String(prices[i]!);
        return MarketBarSchema.parse({
          ...b,
          id: `synthetic:backtest:bar:${i + 1}`,
          open: price,
          high: price,
          low: price,
          close: price,
          availableAt: at((i + 1) * 60),
          sourceVersion: 'synthetic-backtest.v1',
          provenance: {
            ...b.provenance,
            capturedAt: at((i + 1) * 60),
            sourceVersion: 'synthetic-backtest.v1',
            parentIds: [canonicalHash({ i, price, recipe: 'synthetic-losing-control.v1' })],
          },
        });
      }),
    input = {
      schemaVersion: 'backtest-input.v1',
      market: base.input.market,
      replay: { schemaVersion: 'replay-input.v1', bars, news: [] },
    },
    manifest = BacktestManifestSchema.parse({
      schemaVersion: 'backtest-manifest.v1',
      input,
      inputHash: canonicalHash(input),
      assumptions: {
        schemaVersion: 'execution-assumptions.v1',
        declaredAt: at(0),
        policy: { ...base.request, endAt: at(361), generatedAt: at(420) },
      },
      strategy: {
        id: 'synthetic:loss-control',
        version: '1',
        config: { sellAfterEvents: 3 },
        requiredFields: ['CLOSED_OHLCV'],
      },
      series: {
        asset: 'BTC',
        exchange: 'synthetic-cross',
        instrumentId: 'BTC/USDT',
        marketType: 'SPOT',
      },
      quantity: '1',
      buyPriceCap: '200',
      sellPriceFloor: '1',
      maxOrderNotional: '200',
      orderLifetimeSeconds: 180,
      calendar: { firstCloseAt: at(60) },
      maxMarkAgeMs: 60000,
      cohortDisclosure:
        'SYNTHETIC explicit single BTC spot teaching cohort. Not a complete historical market or investment result.',
      scenarios: [
        {
          id: 'HIGH_FEES',
          overrides: { makerRate: '0.002', takerRate: '0.002' },
          omittedBarIds: [],
        },
        { id: 'HIGH_SLIPPAGE', overrides: { slippageBps: '20' }, omittedBarIds: [] },
        { id: 'WIDE_SPREAD', overrides: { spreadBps: '40' }, omittedBarIds: [] },
        { id: 'LATENCY', overrides: { latencyMs: 1000 }, omittedBarIds: [] },
        { id: 'MISSING_CANDLE', overrides: {}, omittedBarIds: ['synthetic:backtest:bar:3'] },
      ],
    });
  return manifest;
}
