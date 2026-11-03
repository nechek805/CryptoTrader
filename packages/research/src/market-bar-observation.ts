import {
  InstrumentRevisionSchema,
  MarketBarSchema,
  MarketObservationSchema,
} from '@crypto/contracts';
import { canonicalHash, deterministicId } from '@crypto/core';

/** Explicit projection; base volume cannot establish quote turnover or order-book liquidity. */
export function marketObservationFromBar(
  barInput: unknown,
  instrumentInput: unknown,
  revisionInput: number,
) {
  const bar = MarketBarSchema.parse(barInput),
    instrument = InstrumentRevisionSchema.parse(instrumentInput);
  const revision = MarketObservationSchema.shape.revision.parse(revisionInput);
  if (
    bar.exchange !== instrument.venue ||
    bar.instrumentId !== `${instrument.baseCode}/${instrument.quoteCode}` ||
    bar.marketType !== instrument.marketType ||
    instrument.effectiveFrom > bar.openAt
  )
    throw new Error('Bar/metadata binding mismatch');
  const contentHash = canonicalHash(bar);
  const seconds = { seconds: 1, minutes: 60, hours: 3600, days: 86400 };
  const derivative =
    bar.marketType === 'SPOT'
      ? { status: 'NOT_APPLICABLE', reason: 'Spot bar' }
      : { status: 'UNAVAILABLE', reason: 'OHLCV source supplies no derivative series' };
  return MarketObservationSchema.parse({
    schemaVersion: 'market-observation.v1',
    id: deterministicId('market-observation', {
      barId: bar.id,
      contentHash,
      instrumentKey: instrument.instrumentKey,
      revision,
    }),
    sourceId: instrument.sourceId,
    instrumentKey: instrument.instrumentKey,
    providerSymbol: instrument.providerSymbol,
    revision,
    quality: 'CANDLE_ONLY',
    evidence: { id: bar.id, contentHash },
    windowStart: bar.openAt,
    windowEnd: bar.closeAt,
    intervalSeconds: bar.interval.value * seconds[bar.interval.unit],
    providerAt: bar.closeAt,
    observedAt: bar.provenance.capturedAt,
    availableAt: bar.availableAt,
    availabilityBasis: bar.availabilityBasis,
    researchUse: bar.researchUse,
    price: bar.close,
    quoteVolume: null,
    liquidityQuote: null,
    derivatives: { fundingRate: derivative, openInterest: derivative, markPrice: derivative },
  });
}
