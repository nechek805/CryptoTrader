import { BtcDatasetSchema } from '@crypto/contracts';
import type { MarketAsset } from '@crypto/contracts';
import { marketByteHash, marketInstrument, verifyMarketHistory } from '@crypto/research';

/** Deliberately synthetic, per-symbol provenance for offline causal and accounting checks. */
export function marketHistoryFixture(asset: MarketAsset = 'BTC', priceScale = 1, length = 600) {
  const from = Date.UTC(2025, 0, 1),
    capturedAt = '2026-01-01T00:00:00.000Z';
  const filters =
    asset === 'TRX'
      ? { tickSize: '0.0001', stepSize: '0.1', minQty: '0.1', maxQty: '9000000' }
      : { tickSize: '0.01', stepSize: '0.00001', minQty: '0.00001', maxQty: '9000' };
  const metadataBody = JSON.stringify({
    symbols: [
      {
        symbol: asset + 'USDT',
        baseAsset: asset,
        quoteAsset: 'USDT',
        status: 'TRADING',
        isSpotTradingAllowed: true,
        filters: [
          { filterType: 'PRICE_FILTER', tickSize: filters.tickSize },
          {
            filterType: 'LOT_SIZE',
            stepSize: filters.stepSize,
            minQty: filters.minQty,
            maxQty: filters.maxQty,
          },
          { filterType: 'NOTIONAL', minNotional: '5' },
        ],
      },
    ],
  });
  const metadata = {
    url: 'https://data-api.binance.vision/api/v3/exchangeInfo',
    receivedAt: capturedAt,
    body: metadataBody,
    hash: marketByteHash(metadataBody),
  };
  const bars = Array.from({ length }, (_, i) => {
    const price = (150 + i * 0.1 + 8 * Math.sin(i / 12)) * priceScale;
    return {
      at: from + i * 3600000,
      open: price.toFixed(8),
      high: (price + 0.8 * priceScale).toFixed(8),
      low: (price - 0.8 * priceScale).toFixed(8),
      close: price.toFixed(8),
      volume: '1000000',
    };
  });
  const rows = bars.map((b) => [
    b.at,
    b.open,
    b.high,
    b.low,
    b.close,
    b.volume,
    b.at + 3599999,
    '100000',
    10,
    '500',
    '50000',
    '0',
  ]);
  const captures = Array.from({ length: Math.ceil(rows.length / 1000) }, (_, i) => {
    const body = JSON.stringify(rows.slice(i * 1000, (i + 1) * 1000));
    return {
      url: `https://data-api.binance.vision/api/v3/klines?symbol=${asset}USDT&interval=1h`,
      receivedAt: capturedAt,
      body,
      hash: marketByteHash(body),
    };
  });
  return verifyMarketHistory({
    version: 'market-history.v1',
    origin: 'SYNTHETIC',
    instrument: marketInstrument(metadata, asset),
    interval: '1h',
    from,
    to: from + bars.length * 3600000,
    capturedAt,
    historicalAvailability: 'UNKNOWN',
    captures,
    bars,
  });
}
export function legacyBtcFixture() {
  const market = marketHistoryFixture();
  return BtcDatasetSchema.parse({
    version: 'btc-history.v1',
    origin: 'SYNTHETIC',
    symbol: 'BTCUSDT',
    interval: '1h',
    from: market.from,
    to: market.to,
    capturedAt: market.capturedAt,
    historicalAvailability: 'UNKNOWN',
    bars: market.bars,
    captures: market.captures,
  });
}
