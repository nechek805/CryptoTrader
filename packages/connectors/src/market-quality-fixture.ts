import { MarketDatasetSchema } from '@crypto/contracts';
import type { MarketDataset } from '@crypto/contracts';
import { canonicalHash, fromEpoch } from '@crypto/core';

/** Locally authored fiction: prices, metadata and two venue identities are synthetic. */
export function marketQualityFixture(): MarketDataset {
  const at = (ms: number) => fromEpoch(1767225600000n + BigInt(ms), 'milliseconds');
  const notApplicable = { status: 'NOT_APPLICABLE', reason: 'Synthetic spot instrument' };
  const unavailable = {
    status: 'UNAVAILABLE',
    reason: 'Synthetic provider has no permitted derivative series',
  };
  const instruments: unknown[] = [],
    observations: unknown[] = [];
  const observation = (row: Record<string, unknown>) => ({
    ...row,
    quality: 'ORDER_BOOK',
    evidence: { id: `fixture:${String(row.id)}`, contentHash: canonicalHash(row) },
  });
  for (const venue of ['alpha', 'beta']) {
    for (const asset of ['BTC', 'ETH', 'SOL', 'OLD', 'NEW']) {
      const sourceId = `synthetic:${venue}`,
        key = `${venue}:SPOT:${asset}`;
      const metadata = {
        schemaVersion: 'instrument-revision.v1',
        id: `${key}:metadata:1`,
        instrumentKey: key,
        revision: 1,
        sourceId,
        venue: `synthetic-${venue}`,
        baseAssetId: `asset:${asset}`,
        quoteAssetId: 'asset:USDT',
        baseCode: asset,
        quoteCode: 'USDT',
        assetName: `Synthetic ${asset}`,
        marketType: 'SPOT',
        providerSymbol: `${asset}USDT`,
        effectiveFrom: at(0),
        listedAt: asset === 'NEW' ? at(120000) : at(0),
        delistedAt: null,
        tickSize: '0.01',
        quantityStep: '0.001',
        derivatives: {
          fundingRate: 'NOT_APPLICABLE',
          openInterest: 'NOT_APPLICABLE',
          markPrice: 'NOT_APPLICABLE',
        },
        observedAt: at(0),
        availableAt: asset === 'NEW' ? at(180000) : at(0),
        availabilityBasis: 'OBSERVED',
        researchUse: 'ELIGIBLE',
      };
      instruments.push(metadata);
      if (asset === 'OLD')
        instruments.push({
          ...metadata,
          id: `${key}:metadata:2`,
          revision: 2,
          effectiveFrom: at(120000),
          delistedAt: at(180000),
          observedAt: at(120000),
          availableAt: at(120000),
        });
      if (asset === 'BTC')
        instruments.push({
          ...metadata,
          id: `${key}:metadata:2`,
          revision: 2,
          effectiveFrom: at(120000),
          tickSize: '0.1',
          quantityStep: '0.01',
          observedAt: at(120000),
          availableAt: at(125000),
        });
      if (asset === 'SOL')
        instruments.push({
          ...metadata,
          id: `${key}:metadata:2`,
          revision: 2,
          effectiveFrom: at(120000),
          baseCode: 'SOLX',
          assetName: 'Synthetic renamed SOL',
          providerSymbol: 'SOLXUSDT',
          observedAt: at(120000),
          availableAt: at(125000),
        });
      for (let slot = 1; slot <= 4; slot++) {
        if (asset === 'SOL' && venue === 'alpha' && slot === 2) continue;
        if (asset === 'NEW' && slot < 3) continue;
        if (asset === 'OLD' && slot === 4) continue;
        const base = asset === 'BTC' ? 100 : asset === 'ETH' ? 50 : asset === 'SOL' ? 10 : 5;
        const price = venue === 'beta' && asset === 'SOL' && slot === 3 ? '15' : String(base);
        observations.push(
          observation({
            schemaVersion: 'market-observation.v1',
            id: `${key}:sample:${slot}:1`,
            instrumentKey: key,
            sourceId,
            revision: 1,
            providerSymbol: asset === 'SOL' && slot >= 3 ? 'SOLXUSDT' : `${asset}USDT`,
            windowStart: at((slot - 1) * 60000),
            windowEnd: at(slot * 60000),
            intervalSeconds: 60,
            providerAt: at(slot * 60000 - (venue === 'beta' ? (asset === 'ETH' ? 900 : 200) : 0)),
            observedAt: at(slot * 60000 + (asset === 'SOL' && slot === 3 ? 2000 : 100)),
            availableAt: at(slot * 60000 + (asset === 'SOL' && slot === 3 ? 2000 : 100)),
            availabilityBasis: 'OBSERVED',
            researchUse: 'ELIGIBLE',
            price,
            quoteVolume:
              asset === 'OLD'
                ? '5000'
                : asset === 'NEW'
                  ? '9000'
                  : asset === 'BTC'
                    ? '1000'
                    : asset === 'ETH'
                      ? '700'
                      : '500',
            liquidityQuote: asset === 'SOL' && slot === 4 ? null : asset === 'ETH' ? '300' : '500',
            derivatives: {
              fundingRate: notApplicable,
              openInterest: notApplicable,
              markPrice: notApplicable,
            },
          }),
        );
      }
    }
  }
  const key = 'alpha:PERPETUAL:BTC';
  instruments.push({
    schemaVersion: 'instrument-revision.v1',
    id: `${key}:metadata:1`,
    instrumentKey: key,
    revision: 1,
    sourceId: 'synthetic:alpha',
    venue: 'synthetic-alpha',
    baseAssetId: 'asset:BTC',
    quoteAssetId: 'asset:USDT',
    baseCode: 'BTC',
    quoteCode: 'USDT',
    assetName: 'Synthetic BTC perpetual',
    marketType: 'PERPETUAL',
    providerSymbol: 'BTCUSDT',
    effectiveFrom: at(0),
    listedAt: at(0),
    delistedAt: null,
    tickSize: '0.1',
    quantityStep: '0.001',
    derivatives: {
      fundingRate: 'UNAVAILABLE',
      openInterest: 'UNAVAILABLE',
      markPrice: 'UNAVAILABLE',
    },
    observedAt: at(0),
    availableAt: at(0),
    availabilityBasis: 'OBSERVED',
    researchUse: 'ELIGIBLE',
  });
  observations.push(
    observation({
      schemaVersion: 'market-observation.v1',
      id: `${key}:sample:1:1`,
      instrumentKey: key,
      sourceId: 'synthetic:alpha',
      providerSymbol: 'BTCUSDT',
      revision: 1,
      windowStart: at(0),
      windowEnd: at(60000),
      intervalSeconds: 60,
      providerAt: at(60000),
      observedAt: at(60100),
      availableAt: at(60100),
      availabilityBasis: 'OBSERVED',
      researchUse: 'ELIGIBLE',
      price: '100',
      quoteVolume: '99999',
      liquidityQuote: null,
      derivatives: { fundingRate: unavailable, openInterest: unavailable, markPrice: unavailable },
    }),
  );
  return MarketDatasetSchema.parse({
    schemaVersion: 'market-dataset.v1',
    sources: ['alpha', 'beta'].map((venue) => ({
      id: `synthetic:${venue}`,
      venue: `synthetic-${venue}`,
      origin: 'SYNTHETIC',
      version: 'market-quality-fixture.v1',
      reference: 'fixture://locally-authored/market-quality',
      termsReference: 'fixture://locally-authored',
      license: 'SYNTHETIC',
      liquidityDefinition: 'MIN_BID_ASK_NOTIONAL_WITHIN_100BPS',
    })),
    instruments,
    observations,
  });
}
