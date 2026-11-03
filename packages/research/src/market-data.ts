import {
  compareDecimal,
  CrossVenueQuerySchema,
  CrossVenueResultSchema,
  MarketDatasetSchema,
  MarketDataQuerySchema,
  MarketHistoryQuerySchema,
  MarketHistoryResultSchema,
  MarketQueryResultSchema,
  MarketQualityQuerySchema,
  MarketQualityResultSchema,
  MarketResolveQuerySchema,
  MarketResolveResultSchema,
  UniverseRequestSchema,
  UniverseResultSchema,
  utcNanoseconds,
} from '@crypto/contracts';
import type {
  DecimalString,
  InstrumentRevision,
  MarketData,
  MarketDataQuery,
  MarketDataset,
  MarketObservation,
  UtcTimestamp,
} from '@crypto/contracts';
import {
  addDecimal,
  canonicalHash,
  canonicalJson,
  decimal,
  deepFreeze,
  divideDecimal,
  fromEpoch,
  isDecimalMultipleOf,
  multiplyDecimal,
  subtractDecimal,
} from '@crypto/core';

const ns = utcNanoseconds;
const zero = decimal('0');
const frozen = <T>(value: T): T => {
  deepFreeze(value);
  return value;
};
const abs = (v: bigint) => (v < 0n ? -v : v);
const absDecimal = (v: DecimalString) => (v.startsWith('-') ? decimal(v.slice(1)) : v);
const fraction = (n: number, d: number) =>
  divideDecimal(decimal(String(n)), decimal(String(d)), 18, 'HALF_EVEN');
const changeBps = (left: DecimalString, right: DecimalString) =>
  divideDecimal(
    multiplyDecimal(absDecimal(subtractDecimal(left, right)), decimal('10000')),
    left,
    18,
    'HALF_EVEN',
  );
const milliseconds = (nanos: bigint) =>
  divideDecimal(decimal(nanos.toString()), decimal('1000000'), 6, 'HALF_EVEN');
const eligible = (v: InstrumentRevision | MarketObservation) =>
  v.researchUse === 'ELIGIBLE' &&
  v.availableAt !== null &&
  ['OBSERVED', 'ARCHIVED_CAPTURE'].includes(v.availabilityBasis);
const visible = (v: InstrumentRevision | MarketObservation, at: UtcTimestamp) =>
  v.observedAt <= at && (v.availableAt ?? v.observedAt) <= at;
const active = (v: InstrumentRevision, at: UtcTimestamp) =>
  v.listedAt <= at && (v.delistedAt === null || at < v.delistedAt);
const sampleKey = (v: MarketObservation) =>
  `${v.sourceId}|${v.instrumentKey}|${v.windowStart}|${v.windowEnd}|${v.intervalSeconds}`;

export class MarketDataError extends Error {
  constructor(readonly code: 'IDENTITY' | 'CONFLICT' | 'SOURCE' | 'INCOMPATIBLE') {
    super(`Market data: ${code}`);
  }
}

/** Immutable, bounded in-memory snapshot; all reads are explicit about source and knowledge time. */
export class SnapshotMarketData implements MarketData {
  readonly schemaVersion = 'market-data.v1' as const;
  readonly datasetHash: string;
  #data: MarketDataset;
  #metadata = new Map<string, InstrumentRevision[]>();

  constructor(input: unknown) {
    const data = MarketDatasetSchema.parse(JSON.parse(canonicalJson(input)));
    for (const records of [data.sources, data.instruments, data.observations]) {
      if (new Set(records.map((v) => v.id)).size !== records.length)
        throw new MarketDataError('CONFLICT');
      records.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    }
    for (const source of data.sources)
      if ((source.origin === 'SYNTHETIC') !== (source.license === 'SYNTHETIC'))
        throw new MarketDataError('SOURCE');
    for (const row of data.instruments) {
      const source = data.sources.find((s) => s.id === row.sourceId);
      if (!source || source.venue !== row.venue) throw new MarketDataError('SOURCE');
      const history = this.#metadata.get(row.instrumentKey) ?? [];
      const previous = history[0];
      if (
        previous &&
        ['sourceId', 'venue', 'baseAssetId', 'quoteAssetId', 'marketType'].some(
          (key) =>
            previous[key as keyof InstrumentRevision] !== row[key as keyof InstrumentRevision],
        )
      )
        throw new MarketDataError('IDENTITY');
      if (history.some((v) => v.revision === row.revision)) throw new MarketDataError('CONFLICT');
      history.push(row);
      this.#metadata.set(row.instrumentKey, history);
    }
    const observations = new Map<string, MarketObservation[]>();
    for (const row of data.observations) {
      if (this.#metadata.get(row.instrumentKey)?.[0]?.sourceId !== row.sourceId)
        throw new MarketDataError('SOURCE');
      const group = observations.get(sampleKey(row)) ?? [];
      if (group.some((v) => v.revision === row.revision)) throw new MarketDataError('CONFLICT');
      group.push(row);
      observations.set(sampleKey(row), group);
    }
    // Revision numbers cannot claim that an earlier observation supersedes a later one.
    for (const group of [...this.#metadata.values(), ...observations.values()]) {
      group.sort((a, b) => a.revision - b.revision);
      for (let i = 1; i < group.length; i++) {
        const before = group[i - 1]!,
          after = group[i]!;
        if (
          before.observedAt > after.observedAt ||
          (before.availableAt ?? before.observedAt) > (after.availableAt ?? after.observedAt)
        )
          throw new MarketDataError('CONFLICT');
      }
    }
    this.#data = frozen(data);
    this.datasetHash = canonicalHash(data);
    Object.freeze(this);
  }

  #source(id: string) {
    if (!this.#data.sources.some((s) => s.id === id)) throw new MarketDataError('SOURCE');
  }
  #at(
    key: string,
    marketAt: UtcTimestamp,
    decisionAt: UtcTimestamp,
    mode: MarketDataQuery['mode'] = 'ELIGIBLE',
  ): InstrumentRevision | null {
    const rows = (this.#metadata.get(key) ?? [])
      .filter((v) => visible(v, decisionAt) && v.effectiveFrom <= marketAt)
      .sort((a, b) =>
        a.effectiveFrom < b.effectiveFrom
          ? 1
          : a.effectiveFrom > b.effectiveFrom
            ? -1
            : b.revision - a.revision,
      );
    const row = rows[0];
    return row && (mode === 'DESCRIPTIVE_ONLY' || eligible(row)) ? row : null;
  }
  #ambiguous(
    row: InstrumentRevision,
    at: UtcTimestamp,
    decisionAt: UtcTimestamp,
    mode: MarketDataQuery['mode'],
  ) {
    return [...this.#metadata.keys()].some((key) => {
      const other = this.#at(key, at, decisionAt, mode);
      return (
        other !== null &&
        other.instrumentKey !== row.instrumentKey &&
        other.sourceId === row.sourceId &&
        other.marketType === row.marketType &&
        other.providerSymbol === row.providerSymbol &&
        active(other, at)
      );
    });
  }
  #slots(query: Pick<MarketDataQuery, 'from' | 'to' | 'intervalSeconds'>) {
    const result: UtcTimestamp[] = [],
      interval = BigInt(query.intervalSeconds) * 1000000000n;
    for (let end = ns(query.from) + interval; end <= ns(query.to); end += interval)
      result.push(fromEpoch(end, 'nanoseconds'));
    return result;
  }
  #listedFor(row: InstrumentRevision, start: UtcTimestamp, end: UtcTimestamp) {
    return row.listedAt <= start && (row.delistedAt === null || end <= row.delistedAt);
  }

  history(input: unknown) {
    const request = MarketHistoryQuerySchema.parse(input);
    this.#source(request.sourceId);
    return frozen(
      MarketHistoryResultSchema.parse({
        schemaVersion: 'market-history-result.v1',
        datasetHash: this.datasetHash,
        revisions: (this.#metadata.get(request.instrumentKey) ?? []).filter(
          (v) => v.sourceId === request.sourceId && visible(v, request.decisionAt),
        ),
      }),
    );
  }
  resolve(input: unknown) {
    const request = MarketResolveQuerySchema.parse(input);
    this.#source(request.sourceId);
    const rows = [...this.#metadata.keys()]
      .map((key) => this.#at(key, request.marketAt, request.decisionAt))
      .filter(
        (v): v is InstrumentRevision =>
          v !== null &&
          v.sourceId === request.sourceId &&
          v.marketType === request.marketType &&
          v.providerSymbol === request.providerSymbol &&
          active(v, request.marketAt),
      );
    if (rows.length > 1) throw new MarketDataError('CONFLICT');
    return frozen(
      MarketResolveResultSchema.parse({
        schemaVersion: 'market-resolve-result.v1',
        datasetHash: this.datasetHash,
        instrument: rows[0] ?? null,
      }),
    );
  }
  query(input: unknown) {
    const request = MarketDataQuerySchema.parse(input);
    this.#source(request.sourceId);
    const current = new Map<string, MarketObservation>();
    for (const row of this.#data.observations) {
      if (
        row.sourceId !== request.sourceId ||
        row.instrumentKey !== request.instrumentKey ||
        row.intervalSeconds !== request.intervalSeconds ||
        row.windowStart < request.from ||
        row.windowEnd > request.to ||
        !visible(row, request.decisionAt)
      )
        continue;
      const previous = current.get(sampleKey(row));
      if (!previous || previous.revision < row.revision) current.set(sampleKey(row), row);
    }
    const rows: MarketObservation[] = [],
      excluded: ReturnType<typeof MarketQueryResultSchema.parse>['excluded'] = [];
    const interval = BigInt(request.intervalSeconds) * 1000000000n;
    for (const row of [...current.values()].sort((a, b) =>
      a.windowEnd < b.windowEnd ? -1 : a.windowEnd > b.windowEnd ? 1 : a.id < b.id ? -1 : 1,
    )) {
      if (request.mode === 'ELIGIBLE' && !eligible(row)) continue;
      const metadata = this.#at(
        row.instrumentKey,
        row.windowStart,
        request.decisionAt,
        request.mode,
      );
      let reason: (typeof excluded)[number]['reason'] | null = null;
      if ((ns(row.windowStart) - ns(request.from)) % interval !== 0n) reason = 'GRID_ALIGNMENT';
      else if (!metadata) reason = 'NO_METADATA';
      else if (!this.#listedFor(metadata, row.windowStart, row.windowEnd))
        reason = 'OUTSIDE_LISTING';
      else if (
        this.#at(
          row.instrumentKey,
          fromEpoch(ns(row.windowEnd) - 1n, 'nanoseconds'),
          request.decisionAt,
          request.mode,
        )?.id !== metadata.id
      )
        reason = 'METADATA_CHANGE';
      else if (this.#ambiguous(metadata, row.windowStart, request.decisionAt, request.mode))
        reason = 'AMBIGUOUS_MAPPING';
      else if (row.providerSymbol !== metadata.providerSymbol) reason = 'MAPPING';
      else if (!isDecimalMultipleOf(row.price, metadata.tickSize)) reason = 'PRECISION';
      else if (
        (['fundingRate', 'openInterest', 'markPrice'] as const).some((key) =>
          metadata.marketType === 'SPOT'
            ? row.derivatives[key].status !== 'NOT_APPLICABLE'
            : row.derivatives[key].status === 'NOT_APPLICABLE' ||
              (metadata.derivatives[key] !== 'AVAILABLE' &&
                row.derivatives[key].status === 'KNOWN'),
        )
      )
        reason = 'DERIVATIVE_STATUS';
      if (reason) excluded.push({ id: row.id, reason });
      else rows.push(row);
    }
    return frozen(
      MarketQueryResultSchema.parse({
        schemaVersion: 'market-data-result.v1',
        datasetHash: this.datasetHash,
        request,
        rows,
        excluded,
      }),
    );
  }

  universe(input: unknown) {
    const request = UniverseRequestSchema.parse(input);
    this.#source(request.sourceId);
    const selected: ReturnType<typeof UniverseResultSchema.parse>['selected'] = [],
      excluded: ReturnType<typeof UniverseResultSchema.parse>['excluded'] = [];
    const expected = this.#slots(request).length;
    for (const key of [...this.#metadata.keys()].sort()) {
      // Do not expose identifiers from future/unseen metadata in a historical universe.
      const known = (this.#metadata.get(key) ?? []).filter((v) => visible(v, request.decisionAt));
      if (
        !known.length ||
        known[0]?.sourceId !== request.sourceId ||
        known[0].marketType !== request.marketType ||
        known[0].quoteAssetId !== request.quoteAssetId
      )
        continue;
      const instrument = this.#at(key, request.decisionAt, request.decisionAt);
      let reason: (typeof excluded)[number]['reason'] | null = null;
      if (!instrument) reason = 'NO_METADATA';
      else if (instrument.listedAt > request.decisionAt) reason = 'NOT_LISTED';
      else if (instrument.delistedAt !== null && request.decisionAt >= instrument.delistedAt)
        reason = 'DELISTED';
      else if (this.#ambiguous(instrument, request.decisionAt, request.decisionAt, 'ELIGIBLE'))
        reason = 'AMBIGUOUS_MAPPING';
      else if (ns(request.decisionAt) - ns(request.to) > BigInt(request.maxWindowAgeMs) * 1000000n)
        reason = 'STALE_WINDOW';
      const query = this.query({
        schemaVersion: 'market-data-query.v1',
        sourceId: request.sourceId,
        instrumentKey: key,
        decisionAt: request.decisionAt,
        from: request.from,
        to: request.to,
        intervalSeconds: request.intervalSeconds,
        mode: 'ELIGIBLE',
      });
      const coverage = fraction(query.rows.length, expected);
      const missing = query.rows.some((v) => v.quoteVolume === null || v.liquidityQuote === null);
      const volume = query.rows.reduce(
        (total, v) => addDecimal(total, v.quoteVolume ?? zero),
        zero,
      );
      const liquidity = query.rows.reduce<DecimalString | null>(
        (min, v) =>
          v.liquidityQuote !== null && (min === null || compareDecimal(v.liquidityQuote, min) < 0)
            ? v.liquidityQuote
            : min,
        null,
      );
      if (!reason && compareDecimal(coverage, request.minCoverageFraction) < 0) reason = 'COVERAGE';
      if (!reason && (missing || liquidity === null)) reason = 'MISSING_METRICS';
      const latest = query.rows.at(-1);
      if (
        !reason &&
        latest &&
        ns(request.decisionAt) - ns(latest.windowEnd) >
          BigInt(request.maxObservationAgeMs) * 1000000n
      )
        reason = 'STALE_OBSERVATION';
      if (
        !reason &&
        query.rows.some(
          (v) =>
            abs(ns(v.observedAt) - ns(v.providerAt)) > BigInt(request.maxAbsDriftMs) * 1000000n,
        )
      )
        reason = 'DRIFT';
      if (!reason && compareDecimal(volume, request.minQuoteVolume) < 0) reason = 'VOLUME';
      if (!reason && liquidity !== null && compareDecimal(liquidity, request.minLiquidityQuote) < 0)
        reason = 'LIQUIDITY';
      if (reason) excluded.push({ instrumentKey: key, reason });
      else if (instrument && liquidity !== null)
        selected.push({
          instrument,
          quoteVolume: volume,
          minLiquidityQuote: liquidity,
          coverageFraction: coverage,
          observationIds: query.rows.map((v) => v.id),
          metadataIds: [
            ...new Set(query.rows.map((v) => this.#at(key, v.windowStart, request.decisionAt)!.id)),
          ].sort(),
        });
    }
    selected.sort(
      (a, b) =>
        compareDecimal(b.quoteVolume, a.quoteVolume) ||
        compareDecimal(b.minLiquidityQuote, a.minLiquidityQuote) ||
        (a.instrument.instrumentKey < b.instrument.instrumentKey ? -1 : 1),
    );
    for (const candidate of selected.slice(request.count))
      excluded.push({ instrumentKey: candidate.instrument.instrumentKey, reason: 'RANK' });
    return frozen(
      UniverseResultSchema.parse({
        schemaVersion: 'market-universe-result.v1',
        datasetHash: this.datasetHash,
        request,
        rankingRule: 'QUOTE_VOLUME_DESC_LIQUIDITY_DESC_KEY_ASC.v1',
        selected: selected.slice(0, request.count),
        excluded,
      }),
    );
  }

  quality(input: unknown) {
    const request = MarketQualityQuerySchema.parse(input);
    const { spikeThresholdBps, maxAbsDriftMs, ...base } = request;
    const query = this.query({ ...base, schemaVersion: 'market-data-query.v1' });
    const slots = this.#slots(request),
      expected: UtcTimestamp[] = [];
    for (const end of slots) {
      const start = fromEpoch(
        ns(end) - BigInt(request.intervalSeconds) * 1000000000n,
        'nanoseconds',
      );
      const metadata = this.#at(request.instrumentKey, start, request.decisionAt, request.mode);
      if (metadata?.sourceId === request.sourceId && this.#listedFor(metadata, start, end))
        expected.push(end);
    }
    const missingEnds = expected.filter((end) => !query.rows.some((v) => v.windowEnd === end));
    const spikes: ReturnType<typeof MarketQualityResultSchema.parse>['spikes'] = [];
    const unavailableMetrics = {
      quoteVolume: 0,
      liquidityQuote: 0,
      fundingRate: 0,
      openInterest: 0,
      markPrice: 0,
    };
    let maxDrift: bigint | null = null;
    const driftViolationIds: string[] = [];
    for (let i = 0; i < query.rows.length; i++) {
      const row = query.rows[i]!,
        previous = query.rows[i - 1];
      const drift = abs(ns(row.observedAt) - ns(row.providerAt));
      if (maxDrift === null || drift > maxDrift) maxDrift = drift;
      if (drift > BigInt(maxAbsDriftMs) * 1000000n) driftViolationIds.push(row.id);
      if (previous && previous.windowEnd === row.windowStart) {
        const change = changeBps(previous.price, row.price);
        if (compareDecimal(change, spikeThresholdBps) > 0)
          spikes.push({ previousId: previous.id, id: row.id, changeBps: change });
      }
      if (row.quoteVolume === null) unavailableMetrics.quoteVolume++;
      if (row.liquidityQuote === null) unavailableMetrics.liquidityQuote++;
      for (const field of ['fundingRate', 'openInterest', 'markPrice'] as const)
        if (row.derivatives[field].status === 'UNAVAILABLE') unavailableMetrics[field]++;
    }
    return frozen(
      MarketQualityResultSchema.parse({
        schemaVersion: 'market-quality-result.v1',
        datasetHash: this.datasetHash,
        request,
        expectedSlots: expected.length,
        ineligibleSlots: slots.length - expected.length,
        acceptedSlots: query.rows.length,
        missingSlots: missingEnds.length,
        missingFraction: expected.length ? fraction(missingEnds.length, expected.length) : null,
        missingEnds,
        excluded: query.excluded,
        spikes,
        maxAbsReceiptDriftMs: maxDrift === null ? null : milliseconds(maxDrift),
        driftViolationIds,
        unavailableMetrics,
      }),
    );
  }

  compare(input: unknown) {
    const request = CrossVenueQuerySchema.parse(input);
    const data = (side: typeof request.left) =>
      this.query({
        schemaVersion: 'market-data-query.v1',
        ...side,
        decisionAt: request.decisionAt,
        from: request.from,
        to: request.to,
        intervalSeconds: request.intervalSeconds,
        mode: 'ELIGIBLE',
      });
    const left = data(request.left),
      right = data(request.right);
    const leftMeta = this.#at(request.left.instrumentKey, request.to, request.decisionAt),
      rightMeta = this.#at(request.right.instrumentKey, request.to, request.decisionAt);
    if (
      !leftMeta ||
      !rightMeta ||
      leftMeta.sourceId !== request.left.sourceId ||
      rightMeta.sourceId !== request.right.sourceId ||
      leftMeta.venue === rightMeta.venue ||
      leftMeta.baseAssetId !== rightMeta.baseAssetId ||
      leftMeta.quoteAssetId !== rightMeta.quoteAssetId ||
      leftMeta.marketType !== rightMeta.marketType
    )
      throw new MarketDataError('INCOMPATIBLE');
    const unused = new Set(right.rows.map((v) => v.id)),
      matches: ReturnType<typeof CrossVenueResultSchema.parse>['matches'] = [],
      unmatchedLeftIds: string[] = [];
    const order = (a: MarketObservation, b: MarketObservation) =>
      a.providerAt < b.providerAt ? -1 : a.providerAt > b.providerAt ? 1 : a.id < b.id ? -1 : 1;
    for (const l of [...left.rows].sort(order)) {
      if (l.providerAt > request.decisionAt) {
        unmatchedLeftIds.push(l.id);
        continue;
      }
      const candidate = right.rows
        .filter(
          (r) =>
            unused.has(r.id) &&
            r.quality === l.quality &&
            r.windowEnd <= l.windowEnd &&
            r.providerAt <= l.providerAt &&
            ns(l.providerAt) - ns(r.providerAt) <= BigInt(request.toleranceMs) * 1000000n,
        )
        .sort((a, b) => -order(a, b))[0];
      if (!candidate) {
        unmatchedLeftIds.push(l.id);
        continue;
      }
      const lm = this.#at(l.instrumentKey, l.windowStart, request.decisionAt)!,
        rm = this.#at(candidate.instrumentKey, candidate.windowStart, request.decisionAt)!;
      if (
        lm.baseAssetId !== rm.baseAssetId ||
        lm.quoteAssetId !== rm.quoteAssetId ||
        lm.marketType !== rm.marketType
      )
        throw new MarketDataError('INCOMPATIBLE');
      unused.delete(candidate.id);
      const divergence = changeBps(l.price, candidate.price);
      const availableAt = [l.availableAt!, candidate.availableAt!, lm.availableAt!, rm.availableAt!]
        .sort()
        .at(-1)!;
      matches.push({
        leftId: l.id,
        rightId: candidate.id,
        leftMetadataId: lm.id,
        rightMetadataId: rm.id,
        availableAt,
        lagMs: milliseconds(ns(l.providerAt) - ns(candidate.providerAt)),
        divergenceBps: divergence,
        divergent: compareDecimal(divergence, request.divergenceThresholdBps) > 0,
      });
    }
    return frozen(
      CrossVenueResultSchema.parse({
        schemaVersion: 'market-cross-venue-result.v1',
        datasetHash: this.datasetHash,
        request,
        policy: 'BACKWARD_ASOF_PROVIDER_TIME_ONE_TO_ONE.v1',
        matches,
        unmatchedLeftIds,
        unmatchedRightIds: [...unused].sort(),
      }),
    );
  }
}
