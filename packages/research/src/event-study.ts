import { Decimal } from 'decimal.js';
import {
  DecimalStringSchema,
  EventStudyInputSchema,
  EventStudyRequestSchema,
  EventStudyResultSchema,
  EventStudyPricePathRequestSchema,
  EventStudyPricePathSchema,
  utcNanoseconds,
} from '@crypto/contracts';
import type {
  EventStudy,
  EventStudySeries,
  EventStudyWindow,
  MarketBar,
  UtcTimestamp,
} from '@crypto/contracts';
import { canonicalHash, deepFreeze, fromEpoch, isAvailableAt } from '@crypto/core';
import { newsEventResearchInputs, validateNewsEventSnapshot } from '@crypto/news';

// Private decimal context; price ratios and log/sqrt never pass through binary floats.
const D = Decimal.clone({ precision: 256, rounding: Decimal.ROUND_HALF_EVEN });
const out = (v: Decimal) => DecimalStringSchema.parse(v.toDecimalPlaces(36).toFixed());
const change = (start: string, end: string) => new D(end).div(start).minus(1);
const seconds = (time: UtcTimestamp, delta: number) =>
  fromEpoch(utcNanoseconds(time) + BigInt(delta) * 1_000_000_000n, 'nanoseconds');
const seriesKey = (s: EventStudySeries) => `${s.exchange}|${s.instrumentId}|${s.marketType}`;
const durations = { seconds: 1, minutes: 60, hours: 3600, days: 86400 };
const windows = [
  ['-24h', -86400],
  ['-1h', -3600],
  ['+1m', 60],
  ['+5m', 300],
  ['+15m', 900],
  ['+1h', 3600],
  ['+4h', 14400],
  ['+24h', 86400],
  ['+72h', 259200],
  ['+7d', 604800],
] as const;

/** Local, immutable OHLC history. A close is usable only at its own simulated close decision. */
export class SnapshotEventStudy implements EventStudy {
  readonly input;
  readonly inputHash;
  readonly #index = new Map<string, MarketBar[]>();
  constructor(input: unknown) {
    this.input = EventStudyInputSchema.parse(input);
    validateNewsEventSnapshot(this.input.newsSnapshot);
    const ids = new Set<string>(),
      versions = new Set<string>();
    for (const bar of this.input.bars) {
      const key = `${bar.exchange}|${bar.instrumentId}|${bar.marketType}|${durations[bar.interval.unit] * bar.interval.value}|${bar.closeAt}`;
      const version = `${key}|${bar.availableAt}`;
      if (ids.has(bar.id) || versions.has(version))
        throw new Error('Ambiguous bar identity/version');
      if (bar.provenance.origin === 'FIXTURE' && !bar.qualityFlags.includes('SYNTHETIC'))
        throw new Error('Fixture bars must be labelled synthetic');
      ids.add(bar.id);
      versions.add(version);
      const list = this.#index.get(key) ?? [];
      list.push(bar);
      this.#index.set(key, list);
    }
    for (const rows of this.#index.values())
      rows.sort((a, b) => ((a.availableAt ?? '') < (b.availableAt ?? '') ? -1 : 1));
    this.inputHash = canonicalHash(this.input);
    deepFreeze(this.input);
  }
  /** Shared exact-close gate for both event studies and matched control research. */
  observePath(input: unknown) {
    const request = EventStudyPricePathRequestSchema.parse(input),
      step = request.intervalSeconds,
      count = Number(
        (utcNanoseconds(request.to) - utcNanoseconds(request.from)) / (BigInt(step) * 1000000000n),
      ),
      bars: MarketBar[] = [],
      missingCloseTimes: UtcTimestamp[] = [],
      excludedBarIds: string[] = [];
    for (let i = 0; i <= count; i++) {
      const at = seconds(request.from, i * step),
        rows = this.#index.get(`${seriesKey(request.series)}|${step}|${at}`) ?? [],
        eligible = rows.filter(
          (b) =>
            at <= request.analysisAsOf &&
            isAvailableAt(b, at) &&
            !b.qualityFlags.some((f) =>
              ['MISSING', 'GAP', 'CONFLICTING_EVIDENCE', 'STALE', 'UNCERTAIN_TIMESTAMP'].includes(
                f,
              ),
            ),
        ),
        chosen = eligible.at(-1);
      excludedBarIds.push(...rows.filter((r) => r !== chosen).map((r) => r.id));
      if (chosen) bars.push(chosen);
      else missingCloseTimes.push(at);
    }
    return EventStudyPricePathSchema.parse({
      request,
      bars,
      missingCloseTimes,
      excludedBarIds: excludedBarIds.sort(),
    });
  }
  #window(
    series: EventStudySeries,
    anchor: UtcTimestamp,
    label: EventStudyWindow['label'],
    offset: number,
    step: number,
    asOf: UtcTimestamp,
    costs: number,
  ): EventStudyWindow {
    const from = offset < 0 ? seconds(anchor, offset) : anchor,
      to = offset < 0 ? anchor : seconds(anchor, offset),
      supported = Math.abs(offset) % step === 0,
      count = supported ? Math.abs(offset) / step : 0,
      path = supported
        ? this.observePath({ series, from, to, intervalSeconds: step, analysisAsOf: asOf })
        : null,
      missing = path?.missingCloseTimes ?? [],
      selected = path?.bars ?? [],
      excluded = path?.excludedBarIds ?? [],
      start = selected.find((b) => b.closeAt === from),
      end = selected.find((b) => b.closeAt === to);
    const complete = supported && missing.length === 0,
      status = !supported
        ? 'UNSUPPORTED_INTERVAL'
        : to > asOf
          ? 'NOT_YET_OBSERVABLE'
          : complete
            ? 'COMPLETE'
            : selected.length
              ? 'PARTIAL'
              : 'MISSING';
    let gross = null,
      net = null,
      absolute = null,
      adverse = null,
      favorable = null,
      volatility = null,
      drawdown = null;
    if (complete && start && end) {
      const r = change(start.close, end.close);
      gross = out(r);
      net = out(r.minus(new D(costs).div(10000)));
      absolute = out(r.abs());
      let mae = new D(0),
        mfe = new D(0),
        sum = new D(0),
        peak = new D(start.close),
        dd = new D(0);
      for (let i = 1; i < selected.length; i++) {
        const bar = selected[i]!,
          previous = selected[i - 1]!;
        mae = D.min(mae, change(start.close, bar.low));
        mfe = D.max(mfe, change(start.close, bar.high));
        const logReturn = new D(bar.close).div(previous.close).ln();
        sum = sum.plus(logReturn.mul(logReturn));
        peak = D.max(peak, bar.close);
        dd = D.max(dd, new D(1).minus(new D(bar.close).div(peak)));
      }
      adverse = out(mae);
      favorable = out(mfe);
      volatility = out(sum.sqrt());
      drawdown = out(dd);
    }
    return {
      label,
      from,
      to,
      status,
      expectedBars: count,
      observedBars: selected.filter((b) => b.closeAt > from).length,
      missingCloseTimes: missing,
      startBarId: start?.id ?? null,
      endBarId: end?.id ?? null,
      barIds: selected.map((b) => b.id),
      excludedBarIds: excluded.sort(),
      grossReturn: gross,
      netReturn: net,
      absoluteReturn: absolute,
      benchmarkReturn: null,
      benchmarkAdjustedReturn: null,
      maxAdverseExcursion: adverse,
      maxFavorableExcursion: favorable,
      realizedVolatility: volatility,
      maxDrawdown: drawdown,
    };
  }
  run(input: unknown) {
    const request = EventStudyRequestSchema.parse(input),
      result = EventStudyResultSchema.parse({
        schemaVersion: 'event-study-result.v1',
        execution: 'DISABLED',
        interpretation: 'DESCRIPTIVE_ASSOCIATION_NOT_CAUSAL_OR_EXECUTABLE',
        inputHash: this.inputHash,
        configHash: canonicalHash(request),
        request,
        events: request.events.map((selection) => {
          const frozen = newsEventResearchInputs(this.input.newsSnapshot, selection.decisionAt),
            event = frozen.events.find((e) => e.identity.id === selection.eventId);
          if (!event) throw new Error('Event not replay eligible at selected decision');
          const measure = (series: EventStudySeries) =>
            windows.map(([label, offset]) =>
              this.#window(
                series,
                selection.decisionAt,
                label,
                offset,
                request.intervalSeconds,
                request.analysisAsOf,
                request.roundTripCostBps,
              ),
            );
          const benchmarkWindows = measure(request.benchmark);
          return {
            event,
            decisionAt: selection.decisionAt,
            benchmarkWindows,
            responses: request.assets.map((series) => ({
              series,
              windows: measure(series).map((w, i) => {
                const benchmark = benchmarkWindows[i]!.grossReturn;
                return {
                  ...w,
                  benchmarkReturn: benchmark,
                  benchmarkAdjustedReturn:
                    w.grossReturn !== null && benchmark !== null
                      ? out(new D(w.grossReturn).minus(benchmark))
                      : null,
                };
              }),
            })),
          };
        }),
      });
    deepFreeze(result);
    return result;
  }
}
