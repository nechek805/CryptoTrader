import type {
  SpotSimulationInput,
  SpotSimulationRequest,
  MarketBar,
  UtcTimestamp,
  InstrumentRevision,
} from '@crypto/contracts';
import { utcNanoseconds } from '@crypto/contracts';
import { fromEpoch, isAvailableAt, isDecimalMultipleOf } from '@crypto/core';
import { SnapshotMarketData } from '@crypto/research';
import { barIntervalSeconds } from './scheduler.js';

export class SpotEvidence {
  readonly market: SnapshotMarketData;
  constructor(
    readonly input: SpotSimulationInput,
    readonly request: SpotSimulationRequest,
  ) {
    this.market = new SnapshotMarketData(input.market);
  }
  metadata(key: string, marketAt: UtcTimestamp, knownAt: UtcTimestamp) {
    const history = this.market.history({
        schemaVersion: 'market-history-query.v1',
        sourceId: this.request.sourceId,
        instrumentKey: key,
        decisionAt: knownAt,
      }).revisions,
      m = history
        .filter((m) => m.effectiveFrom <= marketAt)
        .sort((a, b) =>
          a.effectiveFrom > b.effectiveFrom
            ? -1
            : a.effectiveFrom < b.effectiveFrom
              ? 1
              : b.revision - a.revision,
        )[0];
    if (
      !m ||
      !isAvailableAt(m, knownAt) ||
      m.venue !== this.request.venue ||
      m.marketType !== 'SPOT' ||
      m.quoteCode !== this.request.quoteCurrency ||
      m.baseCode === m.quoteCode ||
      m.listedAt > marketAt ||
      (m.delistedAt !== null && m.delistedAt <= marketAt)
    )
      return null;
    const resolved = this.market.resolve({
      schemaVersion: 'market-resolve-query.v1',
      sourceId: this.request.sourceId,
      providerSymbol: m.providerSymbol,
      marketType: 'SPOT',
      marketAt,
      decisionAt: knownAt,
    });
    return resolved.instrument?.instrumentKey === key ? m : null;
  }
  bar(key: string, b: MarketBar): { metadata: InstrumentRevision; ids: string[] } | null {
    if (
      b.marketType !== 'SPOT' ||
      !isAvailableAt(b, b.availableAt ?? b.closeAt) ||
      b.availableAt === null ||
      barIntervalSeconds(b) !== this.request.intervalSeconds ||
      b.exchange !== this.request.venue ||
      !b.provenance.sourceIds.includes(this.request.sourceId) ||
      b.qualityFlags.some((f) =>
        ['MISSING', 'STALE', 'GAP', 'UNCERTAIN_TIMESTAMP', 'CONFLICTING_EVIDENCE'].includes(f),
      ) ||
      utcNanoseconds(b.availableAt) - utcNanoseconds(b.closeAt) >
        BigInt(this.request.maxBarDelayMs) * 1000000n
    )
      return null;
    const m = this.metadata(key, b.openAt, b.availableAt),
      end = this.metadata(
        key,
        fromEpoch(utcNanoseconds(b.closeAt) - 1n, 'nanoseconds'),
        b.availableAt,
      );
    if (
      !m ||
      m.id !== end?.id ||
      `${m.baseCode}/${m.quoteCode}` !== b.instrumentId ||
      [m.tickSize, m.quantityStep].some((s) => (s.split('.')[1]?.length ?? 0) > 12) ||
      ![b.open, b.high, b.low, b.close].every((p) => isDecimalMultipleOf(p, m.tickSize)) ||
      !isDecimalMultipleOf(b.volume, m.quantityStep)
    )
      return null;
    return { metadata: m, ids: [m.id] };
  }
}
