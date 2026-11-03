import {
  MarketBarSchema,
  TechnicalFeatureDatasetSchema,
  TechnicalFeatureRequestSchema,
} from '@crypto/contracts';
import { canonicalHash, fromEpoch, utc } from '@crypto/core';

/** Hand-authored synthetic trend, reversal, zero volume, delayed candle and later correction. */
export function technicalFeatureFixture() {
  const start = utc('2026-01-01T00:01:00Z'),
    at = (seconds: number) =>
      fromEpoch(BigInt(Date.parse(start)) + BigInt(seconds) * 1000n, 'milliseconds'),
    closes = [10, 11, 12, 13, 12, 11, 14, 15, 16, 15],
    volumes = [10, 20, 30, 40, 0, 20, 30, 40, 50, 60],
    bars = closes.map((close, i) =>
      MarketBarSchema.parse({
        schemaVersion: 'market-bar.v1',
        id: `synthetic:features:${i}`,
        exchange: 'synthetic:features',
        instrumentId: 'BTC/USDT',
        marketType: 'SPOT',
        interval: { value: 1, unit: 'minutes' },
        openAt: at((i - 1) * 60),
        closeAt: at(i * 60),
        open: String(i ? closes[i - 1] : 10),
        high: String(Math.max(close, i ? closes[i - 1]! : 10) + 1),
        low: String(Math.min(close, i ? closes[i - 1]! : 10) - 1),
        close: String(close),
        volume: String(volumes[i]),
        availableAt: at(i * 60 + (i === 3 ? 30 : 0)),
        availabilityBasis: 'OBSERVED',
        researchUse: 'ELIGIBLE',
        sourceVersion: 'synthetic-technical-features.v1',
        qualityFlags: ['SYNTHETIC'],
        provenance: {
          origin: 'FIXTURE',
          sourceIds: ['synthetic:feature-prices'],
          parentIds: [canonicalHash({ i, close, volume: volumes[i] })],
          sourceVersion: 'synthetic-technical-features.v1',
          capturedAt: at(i * 60 + (i === 3 ? 30 : 0)),
          rawTimestamp: null,
        },
      }),
    ),
    correction = MarketBarSchema.parse({
      ...bars[1],
      id: 'synthetic:features:corrected-1',
      close: '12',
      high: '13',
      qualityFlags: ['SYNTHETIC', 'CORRECTED'],
      availableAt: at(540),
      provenance: {
        ...bars[1]!.provenance,
        capturedAt: at(540),
        parentIds: [canonicalHash('synthetic:late-correction')],
      },
    }),
    input = TechnicalFeatureDatasetSchema.parse({
      schemaVersion: 'technical-feature-dataset.v1',
      bars: [...bars, correction],
    }),
    request = TechnicalFeatureRequestSchema.parse({
      schemaVersion: 'technical-feature-request.v1',
      series: {
        asset: 'BTC',
        exchange: 'synthetic:features',
        instrumentId: 'BTC/USDT',
        marketType: 'SPOT',
      },
      intervalSeconds: 60,
      historyStartCloseAt: start,
      featureAsOf: [at(0), at(60), at(120), at(180), at(210), at(240), at(480), at(540)],
      generatedAt: at(600),
      config: {
        schemaVersion: 'technical-feature-config.v1',
        smaPeriod: 3,
        emaPeriod: 3,
        volatilityPeriod: 3,
        atrPeriod: 3,
        relativeVolumePeriod: 3,
        zScorePeriod: 3,
        breakoutPeriod: 3,
        returnHorizonsBars: [1, 2, 5],
        minimumBaseVolume: '5',
        lowRelativeVolumeThreshold: '0.25',
        candleGapThresholdBps: 100,
        staleAfterSeconds: 120,
      },
    });
  return { input, request };
}
