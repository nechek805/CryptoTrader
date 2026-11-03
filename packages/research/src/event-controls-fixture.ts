import { EventControlsRequestSchema, EventStudyInputSchema } from '@crypto/contracts';
import { canonicalHash } from '@crypto/core';
import { eventStudyFixture } from './event-study-fixture.js';
import { ControlDecimal as D, metric, shift } from './event-control-math.js';

/** Entirely synthetic prices/news; exact beta two, one recovery and one censored decline. */
export async function eventControlsFixture() {
  const base = await eventStudyFixture(),
    anchor = base.request.events[0]!.decisionAt,
    at = (minute: number) => shift(anchor, minute * 60),
    btcPre = ['100', '110', '99', '99', '108.9', '98.01', '98.01'],
    ethPre = ['100', '120', '96', '96', '115.2', '92.16', '92.16'],
    close = (asset: string, minute: number) => {
      if (minute >= -7 && minute <= -1 && asset !== 'SOL')
        return (asset === 'BTC' ? btcPre : ethPre)[minute + 7]!;
      if (minute >= 0 && minute <= 5)
        return (
          asset === 'BTC'
            ? ['100', '101', '99', '100', '102', '100']
            : asset === 'ETH'
              ? ['100', '90', '80', '90', '100', '110']
              : ['50', '49', '48', '47', '46', '45']
        )[minute]!;
      return asset === 'BTC'
        ? '100'
        : asset === 'SOL'
          ? '50'
          : ['100', '102', '101', '99', '100', '103'][((minute % 6) + 6) % 6]!;
    },
    bars = base.request.assets.flatMap((series) =>
      Array.from({ length: 421 }, (_, i) => {
        const minute = i - 180,
          price = close(series.asset, minute),
          previous = close(series.asset, minute - 1);
        return {
          schemaVersion: 'market-bar.v1',
          id: `synthetic:controls:${series.asset}:${i}`,
          exchange: series.exchange,
          instrumentId: series.instrumentId,
          marketType: series.marketType,
          interval: { value: 1, unit: 'minutes' },
          openAt: at(minute - 1),
          closeAt: at(minute),
          open: previous,
          close: price,
          high: metric(D.max(price, previous)),
          low: metric(D.min(price, previous)),
          volume: '100',
          availableAt: at(minute),
          availabilityBasis: 'OBSERVED',
          researchUse: 'ELIGIBLE',
          sourceVersion: 'synthetic-event-controls.v1',
          qualityFlags: ['SYNTHETIC'],
          provenance: {
            origin: 'FIXTURE',
            sourceIds: ['synthetic:event-controls'],
            parentIds: [canonicalHash({ asset: series.asset, minute, price })],
            sourceVersion: 'synthetic-event-controls.v1',
            capturedAt: at(minute),
            rawTimestamp: null,
          },
        };
      }),
    ),
    input = EventStudyInputSchema.parse({ ...base.input, bars }),
    request = EventControlsRequestSchema.parse({
      schemaVersion: 'event-controls-request.v1',
      study: base.request,
      horizonSeconds: 300,
      fitLookbackBars: 6,
      factor: base.request.assets[0],
      basket: [
        { series: base.request.assets[0], weightBps: 5000 },
        { series: base.request.assets[2], weightBps: 5000 },
      ],
      lags: [-1, 0, 1],
      controls: {
        from: at(-120),
        to: at(10),
        strideSeconds: 600,
        sampleCount: 4,
        seed: 42,
        blackoutSeconds: 60,
        timeOfDayToleranceSeconds: null,
        volatilityTolerance: null,
      },
      taxonomyFilter: [],
    });
  return { input, request };
}
