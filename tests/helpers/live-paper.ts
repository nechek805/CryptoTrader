import { randomUUID } from 'node:crypto';
import { canonicalHash } from '@crypto/core';
import { createLiveRun } from '@crypto/paper';
import {
  LIVE_ASSETS,
  LIVE_EXCHANGES,
  LiveBookSchema,
  LiveBarsSchema,
  LiveInstrumentSchema,
} from '@crypto/contracts';
import type { LiveAsset, LiveExchange, LiveSource } from '@crypto/contracts';
import type { LiveMarket } from '@crypto/paper';
export const LIVE_TEST_TIME = 1793977200000;
export const testProfiles: Record<LiveAsset, unknown> = {
  SOL: {
    asset: 'SOL',
    strategy: 'V6',
    candidate: {
      asset: 'SOL',
      base: 'V2',
      lowVolatilityTargetAtr: '4',
      lowVolatilityThreshold: '0.008',
      stopAtr: '2.5',
      targetAtr: '5',
      trendSlopeHours: 24,
    },
    shortRules: {
      asset: 'SOL',
      kind: 'TUNED',
      maxDistanceAtr: null,
      minDistanceAtr: '0',
      minSlopeAtr: '0.75',
      targetAtr: '2.5',
    },
  },
  XRP: {
    asset: 'XRP',
    strategy: 'V6',
    candidate: {
      adaptiveLowerAtr: '1.5',
      adaptiveTargetAtr: '6',
      asset: 'XRP',
      base: 'V3',
      minSignalRangeAtr: '0.8',
      stopAtr: '2',
      targetAtr: '3.5',
      trendSlopeHours: 24,
    },
    shortRules: {
      asset: 'XRP',
      kind: 'TUNED',
      maxDistanceAtr: '4',
      minDistanceAtr: '0.75',
      minSlopeAtr: '0',
      targetAtr: '3.5',
    },
  },
};
export function liveTestSource(at = LIVE_TEST_TIME): LiveSource {
  return {
    id: randomUUID(),
    url: 'https://data-api.binance.vision/api/v3/depth?symbol=SOLUSDT&limit=5',
    requestedAt: at - 20,
    receivedAt: at,
    providerAt: at,
    sequence: String(at),
    rawHash: canonicalHash('{"origin":"SYNTHETIC"}'),
    raw: '{"origin":"SYNTHETIC"}',
  };
}
export function liveTestMarket(
  at = LIVE_TEST_TIME,
  exchange: LiveExchange = 'BINANCE',
  asset: LiveAsset = 'SOL',
  price = 100,
  size = '1000',
): LiveMarket {
  const hour = Math.floor(at / 3600000) * 3600000;
  return {
    book: LiveBookSchema.parse({
      exchange,
      asset,
      source: liveTestSource(at),
      bids: [[String(price - 0.01), size]],
      asks: [[String(price + 0.01), size]],
    }),
    instrument: LiveInstrumentSchema.parse({
      exchange,
      asset,
      source: liveTestSource(at),
      tick: '0.01',
      step: '0.001',
      minQty: '0.001',
      minNotional: '1',
    }),
    bars: LiveBarsSchema.parse({
      exchange,
      asset,
      source: liveTestSource(at),
      bars: Array.from({ length: 299 }, (_, i) => ({
        at: hour - (300 - i) * 3600000,
        open: '100',
        high: '102',
        low: '98',
        close: '100',
        volume: '10000',
      })),
    }),
  };
}
export function liveTestRun(at = LIVE_TEST_TIME) {
  const markets = LIVE_EXCHANGES.flatMap((e) => LIVE_ASSETS.map((a) => liveTestMarket(at, e, a)));
  return { run: createLiveRun(at, testProfiles, 'test-engine', 'test-profile', markets), markets };
}
