import {
  ReplayBarsQuerySchema,
  ReplayNewsQuerySchema,
  ReplayPointQuerySchema,
  TechnicalFeatureQuerySchema,
} from '@crypto/contracts';
import type {
  MarketBar,
  NewsDocument,
  ReplayQueryTrace,
  UtcTimestamp,
  TechnicalFeatureRow,
  ReplayRequest,
} from '@crypto/contracts';
import { canonicalHash, deepFreeze, isAvailableAt } from '@crypto/core';
import { SnapshotTechnicalFeatures } from '@crypto/research';
import { barCloseKey, barSeriesKey, barIntervalSeconds, newsKey } from './scheduler.js';

export class ReplayAccessError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ReplayAccessError';
  }
}
export interface ReplayContext {
  readonly clock: Readonly<{ now: () => UtcTimestamp }>;
  readonly cursor: Readonly<{ sequence: number; availableAt: UtcTimestamp }>;
  readonly random: Readonly<{ next: () => number }>;
  bar(query: unknown): MarketBar;
  bars(query: unknown): readonly MarketBar[];
  newsById(query: unknown): NewsDocument;
  news(query: unknown): readonly NewsDocument[];
  features(query: unknown): TechnicalFeatureRow;
}
const max = (v: UtcTimestamp[]) => (v.length ? v.reduce((a, b) => (a > b ? a : b)) : null);
/** A capability for one callback only. No reference to the input schedule is exposed. */
export function createReplayContext(
  bars: readonly MarketBar[],
  news: readonly NewsDocument[],
  now: UtcTimestamp,
  sequence: number,
  request: ReplayRequest,
  random: () => number,
) {
  const traces: ReplayQueryTrace[] = [],
    known = new Set<string>();
  let active = true,
    calls = 0,
    randomCalls = 0,
    recordCount = 0,
    featureCalls = 0,
    violation: ReplayAccessError | undefined;
  const fail = (code: string): never => {
    violation = new ReplayAccessError(code);
    throw violation;
  };
  const guard = () => {
    if (!active) fail('REPLAY_CONTEXT_EXPIRED');
    if (++calls > request.maxQueriesPerEvent) fail('REPLAY_QUERY_BUDGET');
  };
  const cutoff = (asOf: UtcTimestamp) => {
    if (asOf > now) fail('REPLAY_FUTURE_QUERY');
  };
  const parse = <T>(schema: { parse: (input: unknown) => T }, input: unknown): T => {
    try {
      return schema.parse(input);
    } catch {
      return fail('REPLAY_INVALID_QUERY');
    }
  };
  const trace = (
    kind: ReplayQueryTrace['kind'],
    query: unknown,
    records: (MarketBar | NewsDocument)[],
  ) => {
    recordCount += records.length;
    if (recordCount > 10000) fail('REPLAY_TRACE_BUDGET');
    for (const r of records) known.add(r.id);
    traces.push({
      kind,
      requestHash: canonicalHash(query),
      recordIds: records.map((r) => r.id).sort(),
      maxInputAvailableAt: max(records.map((r) => r.availableAt!)),
      maxInputEventAt: max(records.map((r) => ('closeAt' in r ? r.closeAt : r.firstObservedAt))),
    });
  };
  const point = (
    input: unknown,
    records: readonly (MarketBar | NewsDocument)[],
    kind: 'BAR' | 'NEWS_BY_ID',
  ) => {
    guard();
    const q = parse(ReplayPointQuerySchema, input);
    cutoff(q.asOf);
    const r =
      records.find((r) => r.id === q.id && isAvailableAt(r, q.asOf)) ??
      fail('REPLAY_DATA_NOT_VISIBLE');
    trace(kind, q, [r]);
    return r;
  };
  const context: ReplayContext = Object.freeze({
    clock: Object.freeze({
      now: () => {
        if (!active) fail('REPLAY_CONTEXT_EXPIRED');
        return now;
      },
    }),
    cursor: Object.freeze({ sequence, availableAt: now }),
    random: Object.freeze({
      next: () => {
        if (!active) fail('REPLAY_CONTEXT_EXPIRED');
        if (++randomCalls > 1024) fail('REPLAY_RANDOM_BUDGET');
        return random();
      },
    }),
    bar: (q: unknown) => point(q, bars, 'BAR') as MarketBar,
    newsById: (q: unknown) => point(q, news, 'NEWS_BY_ID') as NewsDocument,
    bars: (input: unknown) => {
      guard();
      const q = parse(ReplayBarsQuerySchema, input);
      cutoff(q.asOf);
      if (q.toCloseAt > q.asOf) fail('REPLAY_FUTURE_QUERY');
      if (!request.symbols.includes(q.series.instrumentId)) fail('REPLAY_SYMBOL_OUTSIDE_COHORT');
      const selected = new Map<string, MarketBar>();
      for (const b of bars)
        if (
          barSeriesKey(b) === barSeriesKey(q.series) &&
          barIntervalSeconds(b) === q.intervalSeconds &&
          b.closeAt >= q.fromCloseAt &&
          b.closeAt <= q.toCloseAt &&
          isAvailableAt(b, q.asOf)
        ) {
          const k = barCloseKey(b),
            old = selected.get(k);
          if (!old || old.availableAt! < b.availableAt!) selected.set(k, b);
        }
      const result = [...selected.values()].sort((a, b) => (a.closeAt < b.closeAt ? -1 : 1));
      if (result.length > 2000) fail('REPLAY_QUERY_RESULT_LIMIT');
      trace('BARS', q, result);
      deepFreeze(result);
      return result;
    },
    news: (input: unknown) => {
      guard();
      const q = parse(ReplayNewsQuerySchema, input);
      cutoff(q.asOf);
      const selected = new Map<string, NewsDocument>();
      for (const n of news)
        if ((q.sourceId === undefined || q.sourceId === n.sourceId) && isAvailableAt(n, q.asOf)) {
          const k = newsKey(n),
            old = selected.get(k);
          if (!old || old.availableAt! < n.availableAt!) selected.set(k, n);
        }
      const result = [...selected.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
      trace('NEWS', q, result);
      deepFreeze(result);
      return result;
    },
    features: (input: unknown) => {
      guard();
      const q = parse(TechnicalFeatureQuerySchema, input);
      cutoff(q.featureAsOf);
      if (++featureCalls > 2) fail('REPLAY_FEATURE_QUERY_BUDGET');
      if (!request.symbols.includes(q.series.instrumentId)) fail('REPLAY_SYMBOL_OUTSIDE_COHORT');
      const visible = bars.filter((b) => isAvailableAt(b, q.featureAsOf)),
        result = new SnapshotTechnicalFeatures({
          schemaVersion: 'technical-feature-dataset.v1',
          bars: visible,
        }).query(q),
        used = visible.filter((b) => result.inputBarIds.includes(b.id));
      trace('FEATURES', q, used);
      deepFreeze(result);
      return result;
    },
  });
  return {
    context,
    traces,
    known,
    close: () => {
      active = false;
    },
    assertSafe: () => {
      if (violation) throw violation;
    },
  };
}
