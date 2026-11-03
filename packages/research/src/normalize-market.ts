import {
  CoverageReportSchema,
  MarketBarSchema,
  MarketImportRequestSchema,
  MarketSourceBundleSchema,
  NonNegativeDecimalSchema,
  NormalizedMarketImportSchema,
  ProviderTimestampSchema,
  QuarantinedMarketRowSchema,
} from '@crypto/contracts';
import type {
  CoverageReport,
  ImportedMarketBar,
  MarketImportRequest,
  MarketSource,
  MarketSourceBundle,
  NormalizedMarketImport,
  QuarantinedMarketRow,
  RawMarketRow,
  UtcTimestamp,
} from '@crypto/contracts';
import {
  addDecimal,
  canonicalHash,
  canonicalJson,
  decimal,
  deterministicId,
  fromEpoch,
  toEpoch,
  utc,
} from '@crypto/core';
import {
  byteHash,
  instrumentFor,
  intervalNanoseconds,
  MarketImportError,
  periodBounds,
} from '@crypto/connectors';

export const normalizationVersion = 'ohlcv-normalizer.v1' as const;
export function rawCapturePayload(source: MarketSource, row: RawMarketRow) {
  return {
    schemaVersion: 'market-row-capture.v1',
    sourceUri: source.uri,
    fileHash: source.fileHash,
    member: source.member,
    memberHash: source.memberHash,
    format: source.format,
    line: row.line,
    raw: row.raw,
  };
}
export function captureHash(source: MarketSource, row: RawMarketRow): string {
  return byteHash(canonicalJson(rawCapturePayload(source, row)));
}
function canonicalAmount(value: string): string {
  return addDecimal(decimal(value), decimal('0'));
}
function reject(reason: QuarantinedMarketRow['reason']): never {
  throw new RowRejection(reason);
}
class RowRejection extends Error {
  constructor(readonly reason: QuarantinedMarketRow['reason']) {
    super(reason);
  }
}
function decode(source: MarketSource, row: RawMarketRow, step: bigint): ImportedMarketBar {
  const fields = row.fields;
  if (fields === null) reject('CSV_SYNTAX');
  if (fields.length !== 12) reject('COLUMN_COUNT');
  let openText: string,
    closeText: string,
    open: string,
    high: string,
    low: string,
    close: string,
    volume: string,
    observedAt: UtcTimestamp | null = null;
  if (source.format === 'fixture-ohlcv.v1') {
    if (fields[0] !== source.symbol || fields[1] !== 'SPOT' || fields[2] !== source.interval)
      reject('IDENTITY_MISMATCH');
    if (fields[3] !== source.timestampUnit) reject('TIMESTAMP_UNIT');
    [openText, open, high, low, close, volume, closeText] = fields.slice(4, 11) as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    try {
      observedAt = utc(fields[11] ?? '');
      if (observedAt > source.capturedAt) reject('UNAVAILABLE_AT_CAPTURE');
    } catch (error) {
      if (error instanceof RowRejection) throw error;
      reject('INVALID_VALUE');
    }
  } else {
    [openText, open, high, low, close, volume, closeText] = fields.slice(0, 7) as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    if (!/^\d+$/.test(fields[8] ?? '')) reject('INVALID_VALUE');
    for (const index of [7, 9, 10, 11])
      if (!NonNegativeDecimalSchema.safeParse(fields[index]).success) reject('INVALID_VALUE');
  }
  let openAt: UtcTimestamp, closeAt: UtcTimestamp;
  try {
    const start = ProviderTimestampSchema.parse({ value: openText, unit: source.timestampUnit });
    const end = ProviderTimestampSchema.parse({ value: closeText, unit: source.timestampUnit });
    openAt = fromEpoch(BigInt(start.value), start.unit);
    closeAt = fromEpoch(BigInt(end.value) + 1n, end.unit);
    const bounds = periodBounds(source.period);
    if (openAt < bounds.start || openAt >= bounds.end || closeAt > bounds.end)
      reject('TIMESTAMP_OR_PERIOD');
  } catch (error) {
    if (error instanceof RowRejection) throw error;
    reject('TIMESTAMP_OR_PERIOD');
  }
  if (
    toEpoch(openAt, 'nanoseconds') % step !== 0n ||
    toEpoch(closeAt, 'nanoseconds') - toEpoch(openAt, 'nanoseconds') !== step
  )
    reject('INTERVAL_ALIGNMENT');
  if (source.capturedAt < closeAt) reject('UNAVAILABLE_AT_CAPTURE');
  if (observedAt !== null && observedAt < closeAt) reject('UNAVAILABLE_AT_CAPTURE');
  let prices: string[];
  try {
    prices = [open, high, low, close, volume].map(canonicalAmount);
  } catch {
    reject('INVALID_VALUE');
  }
  const rawHash = captureHash(source, row),
    captureId = deterministicId('market-capture', { provider: source.provider, rawHash });
  const interval = {
    value: Number(source.interval.slice(0, -1)),
    unit: ({ s: 'seconds', m: 'minutes', h: 'hours', d: 'days' } as const)[
      source.interval.slice(-1) as 's' | 'm' | 'h' | 'd'
    ],
  };
  const bar = MarketBarSchema.safeParse({
    schemaVersion: 'market-bar.v1',
    id: deterministicId('bar', {
      exchange: source.provider === 'fixture' ? 'fixture-market' : 'binance',
      instrumentId: source.instrumentId,
      marketType: source.marketType,
      interval: source.interval,
      openAt,
    }),
    exchange: source.provider === 'fixture' ? 'fixture-market' : 'binance',
    instrumentId: source.instrumentId,
    marketType: source.marketType,
    interval,
    openAt,
    closeAt,
    open: prices[0],
    high: prices[1],
    low: prices[2],
    close: prices[3],
    volume: prices[4],
    availableAt: source.origin === 'FIXTURE' ? source.capturedAt : null,
    availabilityBasis: source.origin === 'FIXTURE' ? 'OBSERVED' : 'UNKNOWN',
    researchUse: source.origin === 'FIXTURE' ? 'ELIGIBLE' : 'DESCRIPTIVE_ONLY',
    sourceVersion: normalizationVersion,
    qualityFlags: source.origin === 'FIXTURE' ? ['SYNTHETIC'] : ['UNCERTAIN_TIMESTAMP'],
    provenance: {
      origin: source.origin,
      sourceIds: [source.provider],
      parentIds: [captureId],
      sourceVersion: source.providerVersion,
      capturedAt: source.capturedAt,
      rawTimestamp: { value: openText, unit: source.timestampUnit },
    },
  });
  if (!bar.success) reject('INVALID_OHLCV');
  return { schemaVersion: 'imported-market-bar.v1', bar: bar.data, source, row, captureId };
}
export function normalizeMarketImport(
  input: MarketImportRequest,
  bundlesInput: MarketSourceBundle[],
): NormalizedMarketImport {
  const request = MarketImportRequestSchema.parse(input),
    step = intervalNanoseconds(request.interval);
  const start = toEpoch(request.from, 'nanoseconds'),
    end = toEpoch(request.to, 'nanoseconds');
  if (start % step !== 0n || end % step !== 0n || (end - start) / step > 100000n)
    throw new MarketImportError('LIMIT');
  const bundles = bundlesInput
    .map((bundle) => MarketSourceBundleSchema.parse(bundle))
    .sort((a, b) => {
      const left = `${a.source.uri}:${a.source.fileHash}`,
        right = `${b.source.uri}:${b.source.fileHash}`;
      return left < right ? -1 : left > right ? 1 : 0;
    });
  if (bundles.reduce((sum, bundle) => sum + bundle.rows.length, 0) > 200000)
    throw new MarketImportError('LIMIT');
  const reports = new Map<string, CoverageReport>(),
    candidates = new Map<string, ImportedMarketBar[]>(),
    quarantine: QuarantinedMarketRow[] = [];
  for (const symbol of [...request.symbols].sort())
    reports.set(
      symbol,
      CoverageReportSchema.parse({
        schemaVersion: 'market-coverage.v1',
        symbol,
        instrumentId: instrumentFor(symbol),
        expectedBars: Number((end - start) / step),
        acceptedBars: 0,
        missingBars: 0,
        quarantinedRows: 0,
        duplicateRows: 0,
        conflictingRows: 0,
        outOfOrderRows: 0,
        outsideWindowRows: 0,
        eligibleBars: 0,
        descriptiveOnlyBars: 0,
        missingRanges: [],
      }),
    );
  function quarantineRow(
    source: MarketSource,
    row: RawMarketRow,
    reason: QuarantinedMarketRow['reason'],
  ) {
    quarantine.push(
      QuarantinedMarketRowSchema.parse({
        schemaVersion: 'market-quarantine.v1',
        sourceHash: source.fileHash,
        sourceUri: source.uri,
        line: row.line,
        symbol: source.symbol,
        raw: row.raw,
        rawHash: byteHash(row.raw),
        reason,
      }),
    );
    const report = reports.get(source.symbol);
    if (report) report.quarantinedRows++;
  }
  for (const bundle of bundles) {
    const { source } = bundle,
      report = reports.get(source.symbol);
    periodBounds(source.period);
    if (
      !report ||
      source.provider !== request.provider ||
      source.instrumentId !== report.instrumentId ||
      source.interval !== request.interval
    )
      throw new MarketImportError('INPUT');
    let latestOpen: UtcTimestamp | null = null;
    for (const row of bundle.rows) {
      let decoded: ImportedMarketBar;
      try {
        decoded = decode(source, row, step);
      } catch (error) {
        if (error instanceof RowRejection) {
          quarantineRow(source, row, error.reason);
          continue;
        }
        throw error;
      }
      if (decoded.bar.openAt < request.from || decoded.bar.openAt >= request.to) {
        report.outsideWindowRows++;
        continue;
      }
      if (latestOpen !== null && decoded.bar.openAt < latestOpen) {
        report.outOfOrderRows++;
        decoded.bar.qualityFlags.push('OUT_OF_ORDER');
      }
      if (latestOpen === null || decoded.bar.openAt > latestOpen) latestOpen = decoded.bar.openAt;
      const existing = candidates.get(decoded.bar.id) ?? [];
      existing.push(decoded);
      candidates.set(decoded.bar.id, existing);
    }
  }
  const bars: ImportedMarketBar[] = [];
  const batchKnownAt = bundles
    .map((bundle) => bundle.source.capturedAt)
    .sort()
    .at(-1);
  for (const group of candidates.values()) {
    const first = group[0];
    if (!first) continue;
    const report = reports.get(first.source.symbol);
    if (!report) throw new MarketImportError('INPUT');
    const signature = (value: ImportedMarketBar) =>
      canonicalHash([
        value.bar.open,
        value.bar.high,
        value.bar.low,
        value.bar.close,
        value.bar.volume,
        value.bar.closeAt,
      ]);
    if (new Set(group.map(signature)).size > 1) {
      for (const row of group) quarantineRow(row.source, row.row, 'CONFLICTING_DUPLICATE');
      report.conflictingRows += group.length;
      continue;
    }
    group.sort((a, b) =>
      a.source.capturedAt < b.source.capturedAt
        ? -1
        : a.source.capturedAt > b.source.capturedAt
          ? 1
          : `${a.source.uri}:${a.source.fileHash}` < `${b.source.uri}:${b.source.fileHash}`
            ? -1
            : a.source.uri === b.source.uri && a.source.fileHash === b.source.fileHash
              ? a.row.line - b.row.line
              : 1,
    );
    const winner = group[0];
    if (!winner) continue;
    report.duplicateRows += group.length - 1;
    report.acceptedBars++;
    if (winner.bar.researchUse === 'ELIGIBLE') {
      if (!batchKnownAt) throw new MarketImportError('INPUT');
      winner.bar.availableAt = batchKnownAt;
      report.eligibleBars++;
    } else report.descriptiveOnlyBars++;
    bars.push(winner);
  }
  bars.sort((a, b) =>
    a.bar.instrumentId < b.bar.instrumentId
      ? -1
      : a.bar.instrumentId > b.bar.instrumentId
        ? 1
        : a.bar.openAt < b.bar.openAt
          ? -1
          : a.bar.openAt > b.bar.openAt
            ? 1
            : 0,
  );
  for (const report of reports.values()) {
    const present = new Set(
      bars.filter((row) => row.source.symbol === report.symbol).map((row) => row.bar.openAt),
    );
    let missingStart: bigint | null = null,
      missingCount = 0;
    function finish(at: bigint) {
      if (missingStart !== null) {
        report.missingRanges.push({
          from: fromEpoch(missingStart, 'nanoseconds'),
          to: fromEpoch(at, 'nanoseconds'),
          bars: missingCount,
        });
        missingStart = null;
        missingCount = 0;
      }
    }
    for (let at = start; at < end; at += step) {
      if (!present.has(fromEpoch(at, 'nanoseconds'))) {
        report.missingBars++;
        missingStart ??= at;
        missingCount++;
      } else finish(at);
    }
    finish(end);
  }
  quarantine.sort((a, b) =>
    a.sourceUri < b.sourceUri
      ? -1
      : a.sourceUri > b.sourceUri
        ? 1
        : a.sourceHash < b.sourceHash
          ? -1
          : a.sourceHash > b.sourceHash
            ? 1
            : a.line - b.line,
  );
  return NormalizedMarketImportSchema.parse({
    schemaVersion: 'normalized-market-import.v1',
    normalizationVersion,
    request,
    sources: bundles.map((bundle) => bundle.source),
    bars,
    quarantine,
    coverage: [...reports.values()],
    rawBundles: bundles,
  });
}
