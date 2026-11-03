import {
  CrossFeatureDatasetSchema,
  CrossFeatureRequestSchema,
  CrossFeatureRowSchema,
  utcNanoseconds,
} from '@crypto/contracts';
import type { Decimal } from 'decimal.js';
import type {
  CrossFeatureDataset,
  CrossFeatureRequest,
  CrossAssetFeature,
  CrossCorrelation,
  MarketBar,
  InstrumentRevision,
  UtcTimestamp,
} from '@crypto/contracts';
import {
  canonicalHash,
  deepFreeze,
  fromEpoch,
  isAvailableAt,
  isDecimalMultipleOf,
} from '@crypto/core';
import { SnapshotMarketData } from './market-data.js';
import { ControlDecimal as D, metric } from './event-control-math.js';

const ns = utcNanoseconds,
  stepUnits = { seconds: 1, minutes: 60, hours: 3600, days: 86400 },
  seriesKey = (s: { exchange: string; instrumentId: string; marketType: string }) =>
    `${s.exchange}|${s.instrumentId}|${s.marketType}`,
  max = <T extends string>(v: T[]): T | null =>
    v.length ? v.reduce((a, b) => (a > b ? a : b)) : null,
  bad = ['MISSING', 'GAP', 'STALE', 'UNCERTAIN_TIMESTAMP', 'CONFLICTING_EVIDENCE'];
type Frame = {
  asset: CrossAssetFeature;
  bars: (MarketBar | undefined)[];
  metadata: InstrumentRevision[];
};
type Group = { at: UtcTimestamp; versions: MarketBar[] };
const mean = (v: Decimal[]) => D.sum(...v).div(v.length);
function correlation(
  asset: Frame,
  btc: Frame,
  lag: number,
  r: CrossFeatureRequest,
): CrossCorrelation {
  const returns = (f: Frame) =>
      f.bars.map((b, i) => {
        const prev = f.bars[i - 1];
        return b &&
          prev &&
          ns(b.closeAt) - ns(prev.closeAt) === BigInt(r.intervalSeconds) * 1000000000n
          ? { value: new D(b.close).div(prev.close).minus(1), b, prev }
          : null;
      }),
    a = returns(asset),
    b = returns(btc),
    pairs: CrossCorrelation['pairs'] = [],
    x: Decimal[] = [],
    y: Decimal[] = [];
  for (let i = 1; i < b.length; i++) {
    const p = b[i],
      q = a[i + lag];
    if (!p || !q) continue;
    x.push(p.value);
    y.push(q.value);
    pairs.push({
      btcNominalAt: btc.asset.slots[i]!.nominalCloseAt,
      assetNominalAt: asset.asset.slots[i + lag]!.nominalCloseAt,
      btcActualAt: p.b.closeAt,
      assetActualAt: q.b.closeAt,
      knownAt: max([
        p.b.availableAt!,
        p.prev.availableAt!,
        q.b.availableAt!,
        q.prev.availableAt!,
        ...asset.metadata.map((m) => m.availableAt!),
        ...btc.metadata.map((m) => m.availableAt!),
      ])!,
      barIds: [p.prev.id, p.b.id, q.prev.id, q.b.id],
    });
  }
  const base = {
    lagBars: lag,
    direction:
      lag > 0
        ? ('BTC_LEADS_ASSET' as const)
        : lag < 0
          ? ('ASSET_LEADS_BTC' as const)
          : ('CONTEMPORANEOUS_GRID' as const),
    expectedPairs: Math.max(0, r.lookbackBars - Math.abs(lag)),
    completeCoverage: pairs.length === Math.max(0, r.lookbackBars - Math.abs(lag)),
    pairs,
  };
  if (pairs.length < r.minimumPairs) return { ...base, status: 'INSUFFICIENT_PAIRS', value: null };
  const mx = mean(x),
    my = mean(y);
  let xx = new D(0),
    yy = new D(0),
    xy = new D(0);
  for (let i = 0; i < x.length; i++) {
    const dx = x[i]!.minus(mx),
      dy = y[i]!.minus(my);
    xx = xx.plus(dx.pow(2));
    yy = yy.plus(dy.pow(2));
    xy = xy.plus(dx.mul(dy));
  }
  if (xx.isZero() || yy.isZero()) return { ...base, status: 'ZERO_VARIANCE', value: null };
  return {
    ...base,
    status: 'COMPUTED',
    value: metric(D.max(-1, D.min(1, xy.div(xx.mul(yy).sqrt())))),
  };
}

/** Source metadata, liquid universe and every price join share the same knowledge cutoff. */
export class SnapshotCrossFeatures {
  readonly input: CrossFeatureDataset;
  readonly inputHash: string;
  readonly #market: SnapshotMarketData;
  readonly #bars = new Map<string, Group[]>();
  constructor(input: unknown) {
    this.input = CrossFeatureDatasetSchema.parse(input);
    this.#market = new SnapshotMarketData(this.input.market);
    const bindings = new Set<string>(),
      ids = new Set<string>(),
      versions = new Set<string>(),
      groups = new Map<string, Map<string, MarketBar[]>>();
    for (const binding of this.input.bindings) {
      const k = `${binding.sourceId}|${binding.instrumentKey}`,
        source = this.input.market.sources.find((s) => s.id === binding.sourceId);
      if (bindings.has(k) || !source || source.venue !== binding.series.exchange)
        throw new Error('Invalid cross-feature binding');
      bindings.add(k);
    }
    for (const b of this.input.technical.bars) {
      const k = `${seriesKey(b)}|${b.interval.value * stepUnits[b.interval.unit]}`,
        v = `${k}|${b.closeAt}|${b.availableAt}`;
      if (ids.has(b.id) || versions.has(v)) throw new Error('Ambiguous cross-feature price');
      if (b.provenance.origin === 'FIXTURE' && !b.qualityFlags.includes('SYNTHETIC'))
        throw new Error('Fixture prices must be synthetic');
      ids.add(b.id);
      versions.add(v);
      const series = groups.get(k) ?? new Map<string, MarketBar[]>(),
        list = series.get(b.closeAt) ?? [];
      list.push(b);
      series.set(b.closeAt, list);
      groups.set(k, series);
    }
    for (const [k, series] of groups)
      this.#bars.set(
        k,
        [...series.values()]
          .map((versions) => ({
            at: versions[0]!.closeAt,
            versions: versions.sort((a, b) =>
              (a.availableAt ?? '') < (b.availableAt ?? '') ? -1 : 1,
            ),
          }))
          .sort((a, b) => (a.at < b.at ? -1 : 1)),
      );
    const derivativeIds = new Set<string>(),
      derivativeVersions = new Set<string>();
    for (const d of this.input.derivatives) {
      const k = `${d.sourceId}|${d.instrumentKey}|${d.metric}|${d.measurementAt}|${d.availableAt}`;
      if (
        derivativeIds.has(d.id) ||
        derivativeVersions.has(k) ||
        !this.input.market.sources.some((s) => s.id === d.sourceId)
      )
        throw new Error('Ambiguous derivative evidence');
      derivativeIds.add(d.id);
      derivativeVersions.add(k);
    }
    this.inputHash = canonicalHash(this.input);
    deepFreeze(this.input);
  }
  evaluate(requestInput: unknown) {
    const r = CrossFeatureRequestSchema.parse(requestInput),
      btcBinding = this.input.bindings.find(
        (b) => b.sourceId === r.sourceId && b.instrumentKey === r.btcInstrumentKey,
      );
    if (btcBinding && btcBinding.series.asset !== 'BTC')
      throw new Error('BTC reference binding must name BTC');
    const step = BigInt(r.intervalSeconds) * 1000000000n,
      start = ns(r.historyStartCloseAt),
      source = this.input.market.sources.find((s) => s.id === r.sourceId),
      { lookbackBars: universeLookback, ...universePolicy } = r.universe;
    if (!source) throw new Error('Unknown cross-feature source');
    const rows = r.featureAsOf.map((featureAsOf) => {
      const anchorNs = start + ((ns(featureAsOf) - start) / step) * step,
        anchor = fromEpoch(anchorNs, 'nanoseconds'),
        at = (i: number) => fromEpoch(anchorNs - BigInt(r.lookbackBars - i) * step, 'nanoseconds'),
        histories = new Map<string, InstrumentRevision[]>(),
        metadataUsed = new Map<string, InstrumentRevision>(),
        history = (key: string) => {
          let h = histories.get(key);
          if (!h) {
            h = this.#market.history({
              schemaVersion: 'market-history-query.v1',
              sourceId: r.sourceId,
              instrumentKey: key,
              decisionAt: featureAsOf,
            }).revisions;
            histories.set(key, h);
          }
          return h;
        },
        metadata = (key: string, time: UtcTimestamp) => {
          const m = history(key)
            .filter((m) => m.effectiveFrom <= time)
            .sort((a, b) =>
              a.effectiveFrom > b.effectiveFrom
                ? -1
                : a.effectiveFrom < b.effectiveFrom
                  ? 1
                  : b.revision - a.revision,
            )[0];
          if (m) metadataUsed.set(m.id, m);
          return m && isAvailableAt(m, featureAsOf) ? m : null;
        },
        universe = this.#market.universe({
          schemaVersion: 'market-universe-query.v1',
          sourceId: r.sourceId,
          quoteAssetId: r.quoteAssetId,
          marketType: r.marketType,
          decisionAt: featureAsOf,
          from: fromEpoch(anchorNs - BigInt(universeLookback) * step, 'nanoseconds'),
          to: anchor,
          intervalSeconds: r.intervalSeconds,
          ...universePolicy,
        }),
        selected = new Set(universe.selected.map((s) => s.instrument.instrumentKey));
      const unambiguous = (m: InstrumentRevision, time: UtcTimestamp) => {
          const keys = [
              ...new Set(
                this.input.market.instruments
                  .filter((v) => v.sourceId === r.sourceId)
                  .map((v) => v.instrumentKey),
              ),
            ],
            matches = keys.flatMap((k) => {
              const v = metadata(k, time);
              return v &&
                v.providerSymbol === m.providerSymbol &&
                v.marketType === m.marketType &&
                v.listedAt <= time &&
                (v.delistedAt === null || time < v.delistedAt)
                ? [v]
                : [];
            });
          return matches.length === 1 && matches[0]!.instrumentKey === m.instrumentKey;
        },
        frameCache = new Map<string, Frame>();
      const frame = (instrumentKey: string): Frame => {
        const cached = frameCache.get(instrumentKey);
        if (cached) return cached;
        const binding = this.input.bindings.find(
            (b) => b.sourceId === r.sourceId && b.instrumentKey === instrumentKey,
          ),
          m = metadata(instrumentKey, featureAsOf),
          status: CrossAssetFeature['status'] = !binding
            ? 'NO_BINDING'
            : !m
              ? 'NO_KNOWN_LISTING'
              : m.listedAt > featureAsOf
                ? 'NOT_LISTED'
                : m.delistedAt !== null && m.delistedAt <= featureAsOf
                  ? 'DELISTED'
                  : m.venue !== binding.series.exchange ||
                      m.baseCode !== binding.series.asset ||
                      `${m.baseCode}/${m.quoteCode}` !== binding.series.instrumentId ||
                      m.marketType !== binding.series.marketType ||
                      m.quoteAssetId !== r.quoteAssetId ||
                      !unambiguous(m, featureAsOf)
                    ? 'METADATA_MISMATCH'
                    : 'AVAILABLE',
          slots: CrossAssetFeature['slots'] = [],
          bars: (MarketBar | undefined)[] = [],
          usedMetadata: InstrumentRevision[] = [];
        if (m) usedMetadata.push(m);
        const groups = binding
          ? (this.#bars.get(`${seriesKey(binding.series)}|${r.intervalSeconds}`) ?? [])
          : [];
        for (let i = 0; i <= r.lookbackBars; i++) {
          const nominal = at(i),
            base = {
              nominalCloseAt: nominal,
              barId: null,
              actualCloseAt: null,
              availableAt: null,
              metadataId: null,
            };
          let slotStatus: CrossAssetFeature['slots'][number]['status'] =
            nominal < r.historyStartCloseAt
              ? 'WARMUP'
              : status === 'AVAILABLE'
                ? 'MISSING'
                : status;
          let chosen: MarketBar | undefined,
            meta: InstrumentRevision | null = null;
          if (slotStatus === 'MISSING') {
            let low = 0,
              high = groups.length;
            while (low < high) {
              const mid = Math.floor((low + high) / 2);
              if (groups[mid]!.at <= nominal) low = mid + 1;
              else high = mid;
            }
            const candidates: MarketBar[] = [];
            let present = false;
            for (
              let j = low - 1;
              j >= 0 && ns(nominal) - ns(groups[j]!.at) <= BigInt(r.joinToleranceMs) * 1000000n;
              j--
            ) {
              present = true;
              const row = groups[j]!.versions.filter((b) => isAvailableAt(b, featureAsOf)).at(-1);
              if (row) candidates.push(row);
            }
            if (candidates.length > 1) slotStatus = 'AMBIGUOUS_SLOT';
            else if (!candidates.length) slotStatus = present ? 'NOT_AVAILABLE' : 'MISSING';
            else {
              const b = candidates[0]!;
              meta = metadata(instrumentKey, b.openAt);
              const endMeta = metadata(instrumentKey, fromEpoch(ns(b.closeAt) - 1n, 'nanoseconds'));
              if (!meta) slotStatus = 'NO_KNOWN_LISTING';
              else if (
                meta.listedAt > b.openAt ||
                (meta.delistedAt !== null && b.closeAt > meta.delistedAt)
              )
                slotStatus = meta.listedAt > b.openAt ? 'NOT_LISTED' : 'DELISTED';
              else if (
                endMeta?.id !== meta.id ||
                meta.venue !== b.exchange ||
                `${meta.baseCode}/${meta.quoteCode}` !== b.instrumentId ||
                meta.marketType !== b.marketType ||
                !unambiguous(meta, b.openAt)
              )
                slotStatus = 'METADATA_MISMATCH';
              else if (b.qualityFlags.some((f) => bad.includes(f))) slotStatus = 'SOURCE_QUALITY';
              else if (
                ![b.open, b.high, b.low, b.close].every((p) =>
                  isDecimalMultipleOf(p, meta!.tickSize),
                ) ||
                !isDecimalMultipleOf(b.volume, meta.quantityStep)
              )
                slotStatus = 'PRECISION';
              else {
                slotStatus = 'JOINED';
                chosen = b;
                usedMetadata.push(meta);
              }
            }
          }
          bars.push(chosen);
          slots.push(
            chosen
              ? {
                  nominalCloseAt: nominal,
                  barId: chosen.id,
                  actualCloseAt: chosen.closeAt,
                  availableAt: chosen.availableAt,
                  metadataId: meta!.id,
                  status: 'JOINED',
                }
              : { ...base, status: slotStatus },
          );
        }
        const complete = (values: (MarketBar | undefined)[]) =>
            values.length > 0 &&
            values.every(
              (b, i) =>
                b !== undefined && (i === 0 || ns(b.closeAt) - ns(values[i - 1]!.closeAt) === step),
            ),
          tail = bars.slice(-r.returnHorizonBars - 1),
          gross = complete(tail) ? new D(tail.at(-1)!.close).div(tail[0]!.close).minus(1) : null;
        let regime: CrossAssetFeature['regime'] = {
          status: 'WARMUP_OR_GAP',
          trend: 'UNKNOWN',
          direction: 'UNKNOWN',
          highVolatility: null,
          efficiency: null,
          volatility: null,
        };
        if (complete(bars)) {
          const b = bars as MarketBar[],
            delta = new D(b.at(-1)!.close).minus(b[0]!.close),
            travel = D.sum(...b.slice(1).map((v, i) => new D(v.close).minus(b[i]!.close).abs())),
            efficiency = travel.isZero() ? new D(0) : delta.abs().div(travel),
            logs = b.slice(1).map((v, i) => new D(v.close).div(b[i]!.close).ln()),
            avg = mean(logs),
            vol = mean(logs.map((v) => v.minus(avg).pow(2))).sqrt();
          regime = {
            status: 'READY',
            trend:
              efficiency.gte(r.regime.trendEfficiencyThreshold) && !travel.isZero()
                ? 'TRENDING'
                : 'RANGING',
            direction: delta.gt(0) ? 'UP' : delta.lt(0) ? 'DOWN' : 'FLAT',
            highVolatility: vol.gte(r.regime.highVolatilityThreshold),
            efficiency: metric(efficiency),
            volatility: metric(vol),
          };
        }
        const derivative = (
          field: 'fundingRate' | 'openInterest',
        ): CrossAssetFeature['derivatives']['fundingRate'] => {
          const empty = {
            value: null,
            id: null,
            measurementAt: null,
            publishedAt: null,
            availableAt: null,
          };
          if (m?.marketType === 'SPOT') return { ...empty, status: 'NOT_APPLICABLE' };
          if (status !== 'AVAILABLE' || !m || m.derivatives[field] !== 'AVAILABLE')
            return { ...empty, status: 'UNAVAILABLE' };
          const metricName = field === 'fundingRate' ? 'FUNDING_RATE' : 'OPEN_INTEREST',
            d = this.input.derivatives
              .filter(
                (d) =>
                  d.sourceId === r.sourceId &&
                  d.instrumentKey === instrumentKey &&
                  d.metric === metricName &&
                  isAvailableAt(d, featureAsOf) &&
                  d.measurementAt <= featureAsOf &&
                  d.publishedAt <= featureAsOf &&
                  d.measurementAt >= m.listedAt,
              )
              .sort((a, b) =>
                a.measurementAt > b.measurementAt
                  ? -1
                  : a.measurementAt < b.measurementAt
                    ? 1
                    : a.availableAt! > b.availableAt!
                      ? -1
                      : 1,
              )[0];
          if (!d) return { ...empty, status: 'UNAVAILABLE' };
          if (
            ns(featureAsOf) - ns(d.measurementAt) >
            BigInt(r.derivativeMaxAgeSeconds) * 1000000000n
          )
            return {
              status: 'STALE',
              value: null,
              id: d.id,
              measurementAt: d.measurementAt,
              publishedAt: d.publishedAt,
              availableAt: d.availableAt,
            };
          return {
            status: 'AVAILABLE',
            value: d.value,
            id: d.id,
            measurementAt: d.measurementAt,
            publishedAt: d.publishedAt,
            availableAt: d.availableAt,
          };
        };
        const result: Frame = {
          asset: {
            instrumentKey,
            series: binding?.series ?? null,
            metadataId: m?.id ?? null,
            status,
            inLiquidUniverse: selected.has(instrumentKey),
            slots,
            grossReturn: gross === null ? null : metric(gross),
            btcReturn: null,
            relativeToBtc: null,
            correlations: [],
            regime,
            derivatives: {
              fundingRate: derivative('fundingRate'),
              openInterest: derivative('openInterest'),
            },
          },
          bars,
          metadata: usedMetadata,
        };
        frameCache.set(instrumentKey, result);
        return result;
      };
      const btc = frame(r.btcInstrumentKey),
        assets = r.targets.map(frame),
        members = universe.selected.map((s) => frame(s.instrument.instrumentKey));
      for (const f of frameCache.values()) {
        f.asset.btcReturn = btc.asset.grossReturn;
        f.asset.relativeToBtc =
          f.asset.grossReturn !== null && btc.asset.grossReturn !== null
            ? metric(new D(f.asset.grossReturn).minus(btc.asset.grossReturn))
            : null;
        f.asset.correlations = [...new Set([0, ...r.lagBars])].map((lag) =>
          correlation(f, btc, lag, r),
        );
      }
      const measured = members.filter((m) => m.asset.grossReturn !== null),
        advancing = measured.filter((m) => new D(m.asset.grossReturn!).gt(0)).length,
        declining = measured.filter((m) => new D(m.asset.grossReturn!).lt(0)).length,
        totalVolume = D.sum(new D(0), ...universe.selected.map((s) => s.quoteVolume)),
        shares = totalVolume.isZero()
          ? []
          : universe.selected.map((s) => ({
              instrumentKey: s.instrument.instrumentKey,
              share: metric(new D(s.quoteVolume).div(totalVolume)),
            })),
        bars = [
          ...new Map(
            [...frameCache.values()]
              .flatMap((f) => f.bars.filter((b): b is MarketBar => b !== undefined))
              .map((b) => [b.id, b]),
          ).values(),
        ],
        marketObsIds = [
          ...new Set(
            [
              ...new Set([
                ...universe.selected.map((s) => s.instrument.instrumentKey),
                ...universe.excluded.map((s) => s.instrumentKey),
              ]),
            ].flatMap((instrumentKey) => {
              const q = this.#market.query({
                schemaVersion: 'market-data-query.v1',
                sourceId: r.sourceId,
                instrumentKey,
                mode: 'ELIGIBLE',
                decisionAt: featureAsOf,
                from: universe.request.from,
                to: universe.request.to,
                intervalSeconds: r.intervalSeconds,
              });
              for (const o of q.rows) metadata(instrumentKey, o.windowStart);
              return [...q.rows.map((o) => o.id), ...q.excluded.map((o) => o.id)];
            }),
          ),
        ],
        marketObs = this.input.market.observations.filter((o) => marketObsIds.includes(o.id)),
        metadataIds = [
          ...new Set(
            [...metadataUsed.values()]
              .filter((m) => isAvailableAt(m, featureAsOf))
              .map((m) => m.id)
              .concat(universe.selected.flatMap((s) => [s.instrument.id, ...s.metadataIds])),
          ),
        ],
        metaRows = this.input.market.instruments.filter((m) => metadataIds.includes(m.id)),
        derivativeIds = [
          ...new Set(
            [...frameCache.values()]
              .flatMap((f) => [
                f.asset.derivatives.fundingRate.id,
                f.asset.derivatives.openInterest.id,
              ])
              .filter((id): id is string => id !== null),
          ),
        ],
        derivatives = this.input.derivatives.filter((d) => derivativeIds.includes(d.id)),
        result = CrossFeatureRowSchema.parse({
          schemaVersion: 'cross-feature-row.v1',
          featureAsOf,
          anchorCloseAt: anchor,
          universe,
          universePolicy: 'POINT_IN_TIME_BOOK_REQUIRED_EMPTY_OR_PARTIAL_NO_STATIC_REPLACEMENT',
          btc: btc.asset,
          assets: assets.map((f) => f.asset),
          members: members.map((f) => f.asset),
          breadth: {
            selectedCount: members.length,
            measuredCount: measured.length,
            advancing,
            declining,
            unchanged: measured.length - advancing - declining,
            advancingFraction: measured.length
              ? metric(new D(advancing).div(measured.length))
              : null,
            decliningFraction: measured.length
              ? metric(new D(declining).div(measured.length))
              : null,
            coverageFraction: members.length
              ? metric(new D(measured.length).div(members.length))
              : null,
          },
          concentration: {
            interpretation: 'SELECTED_EXCHANGE_TURNOVER_NOT_MARKET_CAP_OR_RISK',
            largestShare: shares.length ? metric(D.max(...shares.map((s) => s.share))) : null,
            herfindahl: shares.length
              ? metric(D.sum(...shares.map((s) => new D(s.share).pow(2))))
              : null,
            shares,
          },
          inputBarIds: bars.map((b) => b.id).sort(),
          inputMetadataIds: metadataIds.sort(),
          inputMarketObservationIds: marketObsIds.sort(),
          inputDerivativeIds: derivativeIds.sort(),
          sourceIds: [r.sourceId],
          parentIds: [
            ...new Set([
              ...bars.flatMap((b) => b.provenance.parentIds),
              ...marketObs.map((o) => o.evidence.contentHash),
              ...derivatives.flatMap((d) => d.provenance.parentIds),
            ]),
          ].sort(),
          maxInputAvailableAt: max([
            ...bars.map((b) => b.availableAt!),
            ...metaRows.map((m) => m.availableAt!),
            ...marketObs.map((o) => o.availableAt!),
            ...derivatives.map((d) => d.availableAt!),
          ]),
          maxInputEventAt: max([
            ...bars.map((b) => b.closeAt),
            ...metaRows.map((m) => m.observedAt),
            ...marketObs.map((o) => o.windowEnd),
            ...derivatives.map((d) => d.measurementAt),
          ]),
        });
      deepFreeze(result);
      return result;
    });
    deepFreeze(rows);
    return rows;
  }
}
