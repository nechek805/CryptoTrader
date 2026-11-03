import { Decimal } from 'decimal.js';
import {
  DecimalStringSchema,
  TechnicalFeatureDatasetSchema,
  TechnicalFeatureQuerySchema,
  TechnicalFeatureRowSchema,
  utcNanoseconds,
} from '@crypto/contracts';
import type { MarketBar, TechnicalFeatureValue, TechnicalFeatureRow } from '@crypto/contracts';
import { canonicalHash, canonicalJson, deepFreeze, fromEpoch, isAvailableAt } from '@crypto/core';

const D = Decimal.clone({ precision: 256, rounding: Decimal.ROUND_HALF_EVEN }),
  output = (v: Decimal) => DecimalStringSchema.parse(v.toDecimalPlaces(36).toFixed()),
  durations = { seconds: 1, minutes: 60, hours: 3600, days: 86400 },
  key = (b: { exchange: string; instrumentId: string; marketType: string }) =>
    `${b.exchange}|${b.instrumentId}|${b.marketType}`,
  badFlags = ['MISSING', 'GAP', 'STALE', 'UNCERTAIN_TIMESTAMP', 'CONFLICTING_EVIDENCE'],
  maximum = <T extends string>(v: T[]): T | null =>
    v.length ? v.reduce((a, b) => (a > b ? a : b)) : null,
  mean = (v: Decimal[]) => D.sum(...v).div(v.length),
  variance = (v: Decimal[]) => {
    const m = mean(v);
    return mean(v.map((x) => x.minus(m).pow(2)));
  };

// Repeated frozen robustness trials share only small, immutable, fully identified rows.
// Parsing, input-identity checks and replay query budgets still run before a cache hit.
const smallRows = new Map<string, { row: TechnicalFeatureRow; bytes: number }>();
let smallRowBytes = 0;

/** Frozen input; each evaluation selects the revision actually known at its own cutoff. */
export class SnapshotTechnicalFeatures {
  readonly input;
  readonly datasetHash;
  readonly #index = new Map<string, MarketBar[]>();
  constructor(input: unknown) {
    this.input = TechnicalFeatureDatasetSchema.parse(input);
    const ids = new Set<string>(),
      versions = new Set<string>();
    for (const bar of this.input.bars) {
      const k = `${key(bar)}|${bar.interval.value * durations[bar.interval.unit]}|${bar.closeAt}`,
        v = `${k}|${bar.availableAt}`;
      if (ids.has(bar.id) || versions.has(v))
        throw new Error('Ambiguous feature bar identity or availability version');
      if (bar.provenance.origin === 'FIXTURE' && !bar.qualityFlags.includes('SYNTHETIC'))
        throw new Error('Fixture bars must be labelled synthetic');
      ids.add(bar.id);
      versions.add(v);
      const list = this.#index.get(k) ?? [];
      list.push(bar);
      this.#index.set(k, list);
    }
    for (const list of this.#index.values())
      list.sort((a, b) => ((a.availableAt ?? '') < (b.availableAt ?? '') ? -1 : 1));
    this.datasetHash = canonicalHash(this.input);
    deepFreeze(this.input);
  }
  query(input: unknown) {
    const request = TechnicalFeatureQuerySchema.parse(input),
      cacheKey =
        this.input.bars.length <= 256
          ? canonicalHash({ datasetHash: this.datasetHash, request })
          : null,
      cached = cacheKey === null ? undefined : smallRows.get(cacheKey);
    if (cached && cacheKey !== null) {
      smallRows.delete(cacheKey);
      smallRows.set(cacheKey, cached);
      return cached.row;
    }
    const c = request.config,
      step = BigInt(request.intervalSeconds) * 1000000000n,
      start = utcNanoseconds(request.historyStartCloseAt),
      last = Number((utcNanoseconds(request.featureAsOf) - start) / step),
      at = (i: number) => fromEpoch(start + BigInt(i) * step, 'nanoseconds'),
      slots: (MarketBar | undefined)[] = [],
      missingCloseTimes: TechnicalFeatureRow['coverage']['missingCloseTimes'] = [],
      excluded: TechnicalFeatureRow['coverage']['excluded'] = [];
    for (let i = 0; i <= last; i++) {
      const closeAt = at(i),
        rows =
          this.#index.get(`${key(request.series)}|${request.intervalSeconds}|${closeAt}`) ?? [],
        known = rows.filter((b) => isAvailableAt(b, request.featureAsOf)),
        newest = known.at(-1),
        chosen =
          newest && !newest.qualityFlags.some((f) => badFlags.includes(f)) ? newest : undefined;
      for (const b of rows)
        if (b !== chosen)
          excluded.push({
            barId: b.id,
            reason:
              b.researchUse !== 'ELIGIBLE'
                ? 'DESCRIPTIVE_ONLY'
                : !isAvailableAt(b, request.featureAsOf)
                  ? 'NOT_AVAILABLE_AT_ASOF'
                  : b === newest
                    ? 'SOURCE_QUALITY'
                    : 'SUPERSEDED',
          });
      slots.push(chosen);
      if (!chosen) missingCloseTimes.push(closeAt);
    }
    const current = slots[last],
      features: TechnicalFeatureValue[] = [],
      make = (
        id: string,
        required: number,
        bars: MarketBar[],
        status: TechnicalFeatureValue['status'],
        value: Decimal | null,
      ) => {
        const feature: TechnicalFeatureValue = {
          featureId: id,
          status,
          value: value === null ? null : output(value),
          requiredBars: required,
          observedBars: bars.length,
          inputBarIds: bars.map((b) => b.id),
          maxInputAvailableAt: maximum(bars.map((b) => b.availableAt!)),
          maxInputCloseAt: maximum(bars.map((b) => b.closeAt)),
        };
        features.push(feature);
      },
      window = (n: number, excludeCurrent = false) => {
        const end = last - (excludeCurrent ? 1 : 0),
          begin = end - n + 1,
          part = slots.slice(Math.max(0, begin), end + 1),
          bars = part.filter((b): b is MarketBar => b !== undefined);
        const status: TechnicalFeatureValue['status'] =
          !excludeCurrent && !current
            ? 'MISSING_CURRENT_BAR'
            : part.some((b) => !b)
              ? 'GAP'
              : begin < 0
                ? 'WARMUP'
                : 'READY';
        return { bars, status };
      },
      fixed = (
        id: string,
        n: number,
        calculate: (bars: MarketBar[]) => {
          value: Decimal | null;
          status?: TechnicalFeatureValue['status'];
        },
        excludeCurrent = false,
      ) => {
        const w = window(n, excludeCurrent),
          result = w.status === 'READY' ? calculate(w.bars) : { value: null };
        make(id, n, w.bars, result.status ?? w.status, result.value);
      };
    fixed('sma', c.smaPeriod, (b) => ({ value: mean(b.map((v) => new D(v.close))) }));
    let segmentStart = last;
    while (segmentStart > 0 && slots[segmentStart - 1] && slots[segmentStart]) segmentStart--;
    const segment = slots.slice(segmentStart).filter((b): b is MarketBar => b !== undefined),
      stateStatus = (n: number): TechnicalFeatureValue['status'] =>
        !current
          ? 'MISSING_CURRENT_BAR'
          : segment.length >= n
            ? 'READY'
            : segmentStart > 0
              ? 'GAP'
              : 'WARMUP';
    let ema: Decimal | null = null;
    if (stateStatus(c.emaPeriod) === 'READY') {
      const alpha = new D(2).div(c.emaPeriod + 1);
      ema = mean(segment.slice(0, c.emaPeriod).map((b) => new D(b.close)));
      for (const b of segment.slice(c.emaPeriod))
        ema = alpha.mul(b.close).plus(new D(1).minus(alpha).mul(ema));
    }
    make('ema', c.emaPeriod, segment, stateStatus(c.emaPeriod), ema);
    for (const h of c.returnHorizonsBars)
      fixed(`return_${h}`, h + 1, (b) => ({
        value: new D(b.at(-1)!.close).div(b[0]!.close).minus(1),
      }));
    fixed('rolling_volatility', c.volatilityPeriod + 1, (b) => ({
      value: variance(b.slice(1).map((v, i) => new D(v.close).div(b[i]!.close).ln())).sqrt(),
    }));
    let atr: Decimal | null = null;
    if (stateStatus(c.atrPeriod + 1) === 'READY') {
      const tr = segment
        .slice(1)
        .map((b, i) =>
          D.max(
            new D(b.high).minus(b.low),
            new D(b.high).minus(segment[i]!.close).abs(),
            new D(b.low).minus(segment[i]!.close).abs(),
          ),
        );
      atr = mean(tr.slice(0, c.atrPeriod));
      for (const t of tr.slice(c.atrPeriod))
        atr = atr
          .mul(c.atrPeriod - 1)
          .plus(t)
          .div(c.atrPeriod);
    }
    make('atr', c.atrPeriod + 1, segment, stateStatus(c.atrPeriod + 1), atr);
    fixed('relative_volume', c.relativeVolumePeriod + 1, (b) => {
      const reference = mean(b.slice(0, -1).map((v) => new D(v.volume)));
      return reference.isZero()
        ? { value: null, status: 'ZERO_DENOMINATOR' }
        : { value: new D(b.at(-1)!.volume).div(reference) };
    });
    fixed('z_score', c.zScorePeriod + 1, (b) => {
      const prior = b.slice(0, -1).map((v) => new D(v.close)),
        sd = variance(prior).sqrt();
      return sd.isZero()
        ? { value: null, status: 'ZERO_VARIANCE' }
        : { value: new D(b.at(-1)!.close).minus(mean(prior)).div(sd) };
    });
    fixed(
      'breakout_upper',
      c.breakoutPeriod,
      (b) => ({ value: D.max(...b.map((v) => v.high)) }),
      true,
    );
    fixed(
      'breakout_lower',
      c.breakoutPeriod,
      (b) => ({ value: D.min(...b.map((v) => v.low)) }),
      true,
    );
    fixed('candle_gap', 2, (b) => ({ value: new D(b[1]!.open).div(b[0]!.close).minus(1) }));
    const flags: TechnicalFeatureRow['liquidity']['flags'] = ['ORDER_BOOK_UNAVAILABLE'];
    if (!current) flags.push('MISSING_CURRENT_BAR');
    if (missingCloseTimes.length) flags.push('MISSING_CANDLES');
    const latest = slots.findLast((b) => b !== undefined);
    if (
      !latest ||
      utcNanoseconds(request.featureAsOf) - utcNanoseconds(latest.closeAt) >
        BigInt(c.staleAfterSeconds) * 1000000000n
    )
      flags.push('STALE_PRICE');
    if (current) {
      if (new D(current.volume).isZero()) flags.push('ZERO_VOLUME');
      if (new D(current.volume).lt(c.minimumBaseVolume)) flags.push('LOW_BASE_VOLUME');
    }
    const relative = features.find((f) => f.featureId === 'relative_volume')!,
      gap = features.find((f) => f.featureId === 'candle_gap')!;
    if (relative.value !== null && new D(relative.value).lt(c.lowRelativeVolumeThreshold))
      flags.push('LOW_RELATIVE_VOLUME');
    if (gap.value !== null && new D(gap.value).abs().mul(10000).gt(c.candleGapThresholdBps))
      flags.push('CANDLE_PRICE_GAP');
    const usedIds = new Set([
        ...features.flatMap((f) => f.inputBarIds),
        ...(current ? [current.id] : []),
        ...(latest ? [latest.id] : []),
      ]),
      used = slots.filter((b): b is MarketBar => b !== undefined && usedIds.has(b.id)),
      result = TechnicalFeatureRowSchema.parse({
        schemaVersion: 'technical-feature-row.v1',
        datasetHash: this.datasetHash,
        configHash: canonicalHash(c),
        request,
        anchorCloseAt: at(last),
        currentBarId: current?.id ?? null,
        features,
        inputBarIds: used.map((b) => b.id),
        sourceIds: [...new Set(used.flatMap((b) => b.provenance.sourceIds))].sort(),
        sourceVersions: [
          ...new Set(used.flatMap((b) => [b.sourceVersion, b.provenance.sourceVersion])),
        ].sort(),
        parentIds: [...new Set(used.flatMap((b) => b.provenance.parentIds))].sort(),
        maxInputAvailableAt: maximum(used.map((b) => b.availableAt!)),
        maxInputCloseAt: maximum(used.map((b) => b.closeAt)),
        coverage: {
          expectedBars: last + 1,
          availableBars: slots.filter((b) => b !== undefined).length,
          missingCloseTimes,
          excluded,
        },
        liquidity: {
          status: 'CANDLE_PROXY_ONLY_ORDER_BOOK_UNAVAILABLE',
          flags,
          currentBaseVolume: current?.volume ?? null,
          lastKnownCloseAt: latest?.closeAt ?? null,
        },
      });
    deepFreeze(result);
    if (cacheKey !== null && result.coverage.expectedBars <= 256) {
      const bytes = Buffer.byteLength(canonicalJson(result));
      if (bytes <= 256 * 1024) {
        while (smallRows.size >= 256 || smallRowBytes + bytes > 8 * 1024 * 1024) {
          const oldest = smallRows.keys().next().value!;
          smallRowBytes -= smallRows.get(oldest)!.bytes;
          smallRows.delete(oldest);
        }
        smallRows.set(cacheKey, { row: result, bytes });
        smallRowBytes += bytes;
      }
    }
    return result;
  }
}
