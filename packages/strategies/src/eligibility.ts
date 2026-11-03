import type {
  MarketStrategySource,
  MarketBar,
  UtcTimestamp,
  InstrumentRevision,
} from '@crypto/contracts';
import { utcNanoseconds } from '@crypto/contracts';
import { fromEpoch, isAvailableAt, isDecimalMultipleOf } from '@crypto/core';
import { SnapshotMarketData } from '@crypto/research';
const units = { seconds: 1, minutes: 60, hours: 3600, days: 86400 };
export class MarketEligibility {
  readonly market: SnapshotMarketData;
  #at: UtcTimestamp | undefined;
  #history: InstrumentRevision[] = [];
  constructor(readonly source: MarketStrategySource) {
    this.market = new SnapshotMarketData(source.market);
  }
  metadataAt(time: UtcTimestamp, knownAt: UtcTimestamp) {
    if (this.#at !== knownAt) {
      this.#at = knownAt;
      this.#history = this.market.history({
        schemaVersion: 'market-history-query.v1',
        sourceId: this.source.sourceId,
        instrumentKey: this.source.instrumentKey,
        decisionAt: knownAt,
      }).revisions;
    }
    return (
      this.#history
        .filter((m) => m.effectiveFrom <= time && isAvailableAt(m, knownAt))
        .sort((a, b) =>
          a.effectiveFrom > b.effectiveFrom
            ? -1
            : a.effectiveFrom < b.effectiveFrom
              ? 1
              : b.revision - a.revision,
        )[0] ?? null
    );
  }
  bar(b: MarketBar, knownAt: UtcTimestamp) {
    const s = this.source,
      m = this.metadataAt(b.openAt, knownAt),
      end = this.metadataAt(fromEpoch(utcNanoseconds(b.closeAt) - 1n, 'nanoseconds'), knownAt);
    if (
      !isAvailableAt(b, knownAt) ||
      b.closeAt > knownAt ||
      b.exchange !== s.series.exchange ||
      b.instrumentId !== s.series.instrumentId ||
      b.marketType !== 'SPOT' ||
      b.interval.value * units[b.interval.unit] !== s.intervalSeconds ||
      !b.provenance.sourceIds.includes(s.sourceId) ||
      !m ||
      m.id !== end?.id ||
      m.marketType !== 'SPOT' ||
      m.venue !== s.series.exchange ||
      m.baseCode !== s.series.asset ||
      `${m.baseCode}/${m.quoteCode}` !== s.series.instrumentId ||
      m.listedAt > b.openAt ||
      (m.delistedAt !== null && b.closeAt > m.delistedAt) ||
      b.qualityFlags.some((f) =>
        ['MISSING', 'GAP', 'STALE', 'UNCERTAIN_TIMESTAMP', 'CONFLICTING_EVIDENCE'].includes(f),
      ) ||
      utcNanoseconds(b.availableAt!) - utcNanoseconds(b.closeAt) >
        BigInt(s.maxBarDelayMs) * 1000000n
    )
      return null;
    const resolved = this.market.resolve({
      schemaVersion: 'market-resolve-query.v1',
      sourceId: s.sourceId,
      providerSymbol: m.providerSymbol,
      marketType: 'SPOT',
      marketAt: b.openAt,
      decisionAt: knownAt,
    });
    if (
      resolved.instrument?.instrumentKey !== s.instrumentKey ||
      ![b.open, b.high, b.low, b.close].every((p) => isDecimalMultipleOf(p, m.tickSize)) ||
      !isDecimalMultipleOf(b.volume, m.quantityStep)
    )
      return null;
    return m;
  }
}
