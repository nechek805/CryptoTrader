import { beforeAll, expect, it } from 'vitest';
import { MARKET_ASSETS, MarketMatrixSchema, DEFAULT_MARKET_FEES } from '@crypto/contracts';
import type { MarketMatrix } from '@crypto/contracts';
import { canonicalHash, decimal } from '@crypto/core';
import {
  runMarketStrategy,
  diagnoseMarketTrades,
  selectMarketFees,
  MARKET_ENGINE_HASH,
} from '@crypto/backtest';
import { marketHistoryFixture } from './helpers/market-history.js';

let fixture: MarketMatrix;
beforeAll(() => {
  const variants: NonNullable<MarketMatrix['feeVariants']> = { STANDARD: [], ZERO: [] };
  for (const asset of MARKET_ASSETS) {
    const data = marketHistoryFixture(asset, 1, 100);
    for (const mode of ['STANDARD', 'ZERO'] as const) {
      const cells = (['V1', 'V2', 'V3'] as const).map((strategy) => {
        const result = runMarketStrategy(data, strategy, mode);
        return {
          strategy,
          reportId: result.id,
          summary: result.report.summary,
          attribution: diagnoseMarketTrades(result.report),
          exposureFraction: decimal('0'),
          gateCounts: {},
        };
      });
      variants[mode].push({
        asset,
        datasetId: canonicalHash(data),
        status: 'COMPLETE',
        error: null,
        candles: 100,
        filters: data.instrument.filters,
        sources: [],
        cells,
        btcReferenceReproduced: asset === 'BTC' ? true : null,
      });
    }
  }
  const data = marketHistoryFixture('BTC', 1, 100);
  fixture = MarketMatrixSchema.parse({
    version: 'market-matrix.v1',
    origin: 'SYNTHETIC',
    engineHash: MARKET_ENGINE_HASH,
    feeMode: 'STANDARD',
    fees: DEFAULT_MARKET_FEES,
    feeVariants: variants,
    from: data.from,
    to: data.to,
    referenceBtcDatasetId: canonicalHash(data),
    interval: '1h',
    initialUsdt: '10000',
    rows: variants.STANDARD,
    cash: {
      asset: 'USDT',
      equity: '10000',
      netPnl: '0',
      trades: 0,
      interpretation: 'QUOTE_CURRENCY_UNITS_NOT_USD_PEG_TEST',
    },
    strategyCount: 3,
    revisions: 2,
    selection: 'FIXED_CURRENT_UNIVERSE_NOT_HISTORICAL_RANKING',
  });
});
it.each(Array.from({ length: 8 }, (_, mask) => mask))(
  'selects every position and market with fee combination %i, without changing recorded results',
  (mask) => {
    const fees = { V1: !!(mask & 1), V2: !!(mask & 2), V3: !!(mask & 4) },
      selected = selectMarketFees(fixture, fees);
    expect(selected.fees).toEqual(fees);
    expect(selected.feeMode).toBe(mask === 7 ? 'STANDARD' : mask === 0 ? 'ZERO' : 'MIXED');
    for (const row of selected.rows)
      for (const cell of row.cells) {
        const expected = fixture
          .feeVariants![fees[cell.strategy] ? 'STANDARD' : 'ZERO'].find(
            (r) => r.asset === row.asset,
          )!
          .cells.find((c) => c.strategy === cell.strategy)!;
        expect(cell).toEqual(expected);
      }
    expect(selected.cash).toEqual(fixture.cash);
    expect(selectMarketFees(selected, DEFAULT_MARKET_FEES)).toEqual(fixture);
  },
);
it('keeps failed scenarios visible and allows recovery by choosing the available scenario', () => {
  const changed = structuredClone(fixture);
  const row = changed.feeVariants!.ZERO[0]!;
  Object.assign(row, {
    status: 'FAILED',
    error: 'Synthetic unavailable scenario',
    cells: [],
    btcReferenceReproduced: null,
  });
  const failed = selectMarketFees(changed, { V1: false, V2: true, V3: true });
  expect(failed.rows[0]!.status).toBe('FAILED');
  expect(failed.rows[0]!.cells).toHaveLength(0);
  expect(selectMarketFees(failed, DEFAULT_MARKET_FEES).rows[0]!.status).toBe('COMPLETE');
});
it('rejects missing strategies and mismatched snapshots rather than inventing a comparison', () => {
  const changed = structuredClone(fixture);
  changed.feeVariants!.ZERO[0]!.datasetId = canonicalHash('different snapshot');
  expect(() => selectMarketFees(changed, { V1: false, V2: true, V3: true })).toThrow(
    'one market snapshot',
  );
  const incomplete = structuredClone(fixture);
  incomplete.feeVariants!.ZERO[0]!.cells.pop();
  expect(() => selectMarketFees(incomplete, { V1: false, V2: false, V3: false })).toThrow();
});
