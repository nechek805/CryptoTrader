import { EventStudyInputSchema, EventStudyRequestSchema } from '@crypto/contracts';
import { fromEpoch, utc, canonicalHash } from '@crypto/core';
import { buildNewsEventSnapshot, newsTemporalEventFixtures } from '@crypto/news';

/** Fictional prices and fictional news. ETH moves; BTC/SOL are flat negative findings. */
export async function eventStudyFixture() {
  const fixture = await newsTemporalEventFixtures(),
    anchor = utc('2026-01-01T09:21:00Z'),
    at = (minute: number) =>
      fromEpoch(BigInt(Date.parse(anchor)) + BigInt(minute) * 60000n, 'milliseconds'),
    newsSnapshot = buildNewsEventSnapshot(
      fixture.graphConfig,
      fixture.graphRecords,
      fixture.metadataRecords,
      fixture.config,
      { decisionAt: fixture.now, generatedAt: fixture.now },
      'synthetic:news-temporal-events.v1',
    ),
    assets = ['BTC', 'ETH', 'SOL'].map((asset) => ({
      asset,
      exchange: 'synthetic:event-study',
      instrumentId: `${asset}/USDT`,
      marketType: 'SPOT' as const,
    })),
    eth = [100, 110, 90, 100, 110, 120],
    price = (asset: string, i: number) =>
      asset === 'BTC' ? 100 : asset === 'SOL' ? 50 : i <= 0 ? 100 : eth[Math.min(i, 5)]!;
  const bars = assets.flatMap((series) =>
    Array.from({ length: 121 }, (_, i) => {
      const minute = i - 60,
        close = price(series.asset, minute),
        previous = price(series.asset, minute - 1),
        high =
          series.asset === 'ETH' && minute > 0 && minute <= 5
            ? [112, 111, 105, 115, 125][minute - 1]!
            : Math.max(previous, close),
        low =
          series.asset === 'ETH' && minute > 0 && minute <= 5
            ? [95, 85, 88, 99, 108][minute - 1]!
            : Math.min(previous, close);
      return {
        schemaVersion: 'market-bar.v1',
        id: `synthetic:study:${series.asset}:${i}`,
        exchange: series.exchange,
        instrumentId: series.instrumentId,
        marketType: series.marketType,
        interval: { value: 1, unit: 'minutes' },
        openAt: at(minute - 1),
        closeAt: at(minute),
        open: String(previous),
        high: String(high),
        low: String(low),
        close: String(close),
        volume: '100',
        availableAt: at(minute),
        availabilityBasis: 'OBSERVED',
        researchUse: 'ELIGIBLE',
        sourceVersion: 'synthetic-event-study-prices.v1',
        qualityFlags: ['SYNTHETIC'],
        provenance: {
          origin: 'FIXTURE',
          sourceIds: ['synthetic:event-study-prices'],
          parentIds: [canonicalHash({ asset: series.asset, minute, close, high, low })],
          sourceVersion: 'synthetic-event-study-prices.v1',
          capturedAt: at(minute),
          rawTimestamp: null,
        },
      };
    }),
  );
  const input = EventStudyInputSchema.parse({
      schemaVersion: 'event-study-input.v1',
      newsSnapshot,
      bars,
    }),
    request = EventStudyRequestSchema.parse({
      schemaVersion: 'event-study-request.v1',
      events: [{ eventId: fixture.baseId, decisionAt: anchor }],
      assets,
      benchmark: assets[0],
      intervalSeconds: 60,
      analysisAsOf: at(10080),
      generatedAt: at(10080),
      roundTripCostBps: 10,
      clock: 'UTC_24_7_EXACT_CLOSE',
    });
  return { input, request };
}
