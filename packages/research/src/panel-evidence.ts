import { utcNanoseconds } from '@crypto/contracts';
import type {
  DatasetPanelInput,
  DatasetPanelRequest,
  InstrumentRevision,
  MarketBar,
  PanelLabel,
  UtcTimestamp,
} from '@crypto/contracts';
import { fromEpoch, isAvailableAt, isDecimalMultipleOf } from '@crypto/core';
import { SnapshotMarketData } from './market-data.js';
import { ControlDecimal as D, metric } from './event-control-math.js';

type Binding = DatasetPanelInput['bindings'][number];
const seriesKey = (b: { exchange: string; instrumentId: string; marketType: string }) =>
  `${b.exchange}|${b.instrumentId}|${b.marketType}`;
const units = { seconds: 1, minutes: 60, hours: 3600, days: 86400 };
export class PanelEvidence {
  readonly market: SnapshotMarketData;
  readonly #history = new Map<string, InstrumentRevision[]>();
  readonly #index = new Map<string, MarketBar[]>();
  constructor(
    readonly input: DatasetPanelInput,
    readonly bars: Map<string, MarketBar>,
  ) {
    this.market = new SnapshotMarketData(input.market);
    const bindings = new Set<string>();
    for (const b of input.bindings) {
      if (bindings.has(b.instrumentKey)) throw new Error('Duplicate panel binding');
      bindings.add(b.instrumentKey);
    }
    const versions = new Set<string>();
    for (const b of bars.values()) {
      const key = `${seriesKey(b)}|${b.interval.value * units[b.interval.unit]}|${b.closeAt}`,
        version = `${key}|${b.availableAt}`;
      if (versions.has(version)) throw new Error('Ambiguous combined panel evidence');
      versions.add(version);
      const list = this.#index.get(key) ?? [];
      list.push(b);
      this.#index.set(key, list);
    }
    for (const list of this.#index.values())
      list.sort((a, b) => ((a.availableAt ?? '') < (b.availableAt ?? '') ? -1 : 1));
    const ids = new Set<string>(),
      revisions = new Map<string, DatasetPanelInput['groups']>();
    for (const g of input.groups) {
      if (ids.has(g.id)) throw new Error('Duplicate group evidence');
      ids.add(g.id);
      const list = revisions.get(g.instrumentKey) ?? [];
      if (list.some((v) => v.revision === g.revision))
        throw new Error('Conflicting group revision');
      list.push(g);
      revisions.set(g.instrumentKey, list);
    }
    for (const list of revisions.values()) {
      list.sort((a, b) => a.revision - b.revision);
      for (let i = 1; i < list.length; i++)
        if (
          list[i]!.observedAt < list[i - 1]!.observedAt ||
          (list[i]!.availableAt ?? list[i]!.observedAt) <
            (list[i - 1]!.availableAt ?? list[i - 1]!.observedAt)
        )
          throw new Error('Group revision clock reversal');
    }
  }
  binding(key: string) {
    return this.input.bindings.find((b) => b.instrumentKey === key);
  }
  metadata(binding: Binding, marketAt: UtcTimestamp, decisionAt: UtcTimestamp) {
    const cacheKey = `${binding.sourceId}|${binding.instrumentKey}|${decisionAt}`;
    let history = this.#history.get(cacheKey);
    if (!history) {
      history = this.market.history({
        schemaVersion: 'market-history-query.v1',
        sourceId: binding.sourceId,
        instrumentKey: binding.instrumentKey,
        decisionAt,
      }).revisions;
      this.#history.set(cacheKey, history);
    }
    const m = history
      .filter((m) => m.effectiveFrom <= marketAt)
      .sort((a, b) =>
        a.effectiveFrom > b.effectiveFrom
          ? -1
          : a.effectiveFrom < b.effectiveFrom
            ? 1
            : b.revision - a.revision,
      )[0];
    return m && isAvailableAt(m, decisionAt) ? m : null;
  }
  matches(binding: Binding, m: InstrumentRevision) {
    return (
      m.venue === binding.series.exchange &&
      m.marketType === binding.series.marketType &&
      m.baseCode === binding.series.asset &&
      `${m.baseCode}/${m.quoteCode}` === binding.series.instrumentId
    );
  }
  validBar(binding: Binding, b: MarketBar, decisionAt: UtcTimestamp) {
    if (
      !isAvailableAt(b, decisionAt) ||
      !b.provenance.sourceIds.includes(binding.sourceId) ||
      b.closeAt > decisionAt ||
      b.qualityFlags.some((f) =>
        ['MISSING', 'GAP', 'STALE', 'UNCERTAIN_TIMESTAMP', 'CONFLICTING_EVIDENCE'].includes(f),
      )
    )
      return null;
    const m = this.metadata(binding, b.openAt, decisionAt),
      end = this.metadata(
        binding,
        fromEpoch(utcNanoseconds(b.closeAt) - 1n, 'nanoseconds'),
        decisionAt,
      );
    if (
      !m ||
      m.id !== end?.id ||
      !this.matches(binding, m) ||
      m.listedAt > b.openAt ||
      (m.delistedAt !== null && b.closeAt > m.delistedAt) ||
      seriesKey(b) !== seriesKey(binding.series)
    )
      return null;
    try {
      if (
        this.market.resolve({
          schemaVersion: 'market-resolve-query.v1',
          sourceId: binding.sourceId,
          providerSymbol: m.providerSymbol,
          marketType: m.marketType,
          marketAt: b.openAt,
          decisionAt,
        }).instrument?.instrumentKey !== binding.instrumentKey
      )
        return null;
    } catch {
      return null;
    }
    return [b.open, b.high, b.low, b.close].every((p) => isDecimalMultipleOf(p, m.tickSize)) &&
      isDecimalMultipleOf(b.volume, m.quantityStep)
      ? m
      : null;
  }
  group(key: string, time: UtcTimestamp) {
    const g = this.input.groups
      .filter(
        (g) =>
          g.instrumentKey === key &&
          g.observedAt <= time &&
          (g.availableAt ?? g.observedAt) <= time &&
          g.effectiveFrom <= time,
      )
      .sort((a, b) =>
        a.effectiveFrom > b.effectiveFrom
          ? -1
          : a.effectiveFrom < b.effectiveFrom
            ? 1
            : b.revision - a.revision,
      )[0];
    return g && isAvailableAt(g, time) ? g : null;
  }
  labels(
    binding: Binding | undefined,
    startId: string | null,
    featureAsOf: UtcTimestamp,
    request: DatasetPanelRequest,
  ): PanelLabel[] {
    const start = startId ? this.bars.get(startId) : undefined;
    return request.horizonsBars.map((h) => {
      const base: PanelLabel = {
        horizonBars: h,
        status: 'MISSING_START',
        value: null,
        startCloseAt: start?.closeAt ?? null,
        endAt: null,
        decisionAt: null,
        availableAt: null,
        inputBarIds: start ? [start.id] : [],
        inputMetadataIds: [],
      };
      if (!start || !binding) return base;
      const meta = this.validBar(binding, start, featureAsOf);
      if (!meta) return { ...base, status: 'LISTING_OR_MAPPING' };
      const endAt = fromEpoch(
          utcNanoseconds(start.closeAt) + BigInt(h * request.intervalSeconds) * 1000000000n,
          'nanoseconds',
        ),
        decisionAt = fromEpoch(
          utcNanoseconds(endAt) + BigInt(request.labelPublicationLagSeconds) * 1000000000n,
          'nanoseconds',
        );
      base.endAt = endAt;
      base.decisionAt = decisionAt;
      base.inputMetadataIds = [meta.id];
      if (endAt <= featureAsOf) return { ...base, status: 'NON_FUTURE_TARGET' };
      if (decisionAt > request.labelsAsOf) return { ...base, status: 'FUTURE_OBSERVATION_WINDOW' };
      let last = start,
        availableAt =
          start.availableAt! > meta.availableAt! ? start.availableAt! : meta.availableAt!;
      for (let i = 1; i <= h; i++) {
        const at = fromEpoch(
            utcNanoseconds(start.closeAt) + BigInt(i * request.intervalSeconds) * 1000000000n,
            'nanoseconds',
          ),
          cutoff = fromEpoch(
            utcNanoseconds(at) + BigInt(request.labelPublicationLagSeconds) * 1000000000n,
            'nanoseconds',
          ),
          key = `${seriesKey(start)}|${request.intervalSeconds}|${at}`,
          bar = (this.#index.get(key) ?? []).filter((b) => isAvailableAt(b, cutoff)).at(-1);
        if (!bar) return { ...base, status: 'MISSING_FUTURE_BAR' };
        const m = this.validBar(binding, bar, cutoff);
        if (!m) return { ...base, status: 'LISTING_OR_MAPPING' };
        base.inputBarIds.push(bar.id);
        base.inputMetadataIds.push(m.id);
        last = bar;
        if (bar.availableAt! > availableAt) availableAt = bar.availableAt!;
        if (m.availableAt! > availableAt) availableAt = m.availableAt!;
      }
      return {
        ...base,
        status: 'READY',
        value: metric(new D(last.close).div(start.close).minus(1)),
        availableAt: availableAt > decisionAt ? availableAt : decisionAt,
        inputMetadataIds: [...new Set(base.inputMetadataIds)],
      };
    });
  }
}
