import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile, stat, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MarketImportRequestSchema,
  MarketSourceBundleSchema,
  MarketBarSchema,
} from '@crypto/contracts';
import {
  FixtureMarketDataProvider,
  BinanceArchiveMarketDataProvider,
  byteHash,
  readSingleCsvZip,
} from '@crypto/connectors';
import type { ArchiveInput } from '@crypto/connectors';
import {
  normalizeMarketImport,
  writeMarketSnapshot,
  readMarketParquet,
  verifyMarketSnapshot,
} from '@crypto/research';
import { canonicalHash, decisionView, toEpoch, utc } from '@crypto/core';

const request = MarketImportRequestSchema.parse({
  schemaVersion: 'market-import-request.v1',
  provider: 'fixture',
  symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
  interval: '1m',
  from: '2026-01-01T00:00:00Z',
  to: '2026-01-01T00:05:00Z',
});
const tempDirectories: string[] = [],
  execFileAsync = promisify(execFile);
async function temporaryDirectory() {
  const path = await mkdtemp(join(tmpdir(), 'crypto-market-'));
  tempDirectories.push(path);
  return path;
}
afterEach(async () => {
  for (const path of tempDirectories.splice(0)) {
    if (
      dirname(resolve(path)) !== resolve(tmpdir()) ||
      !basename(path).startsWith('crypto-market-')
    )
      throw new Error('Unsafe test cleanup target');
    await rm(path, { recursive: true, force: true });
  }
});
const fixtureImport = async () =>
  normalizeMarketImport(request, await new FixtureMarketDataProvider().read(request));
function kline(time: string, unit: 'milliseconds' | 'microseconds' = 'microseconds') {
  const epoch = toEpoch(utc(time), unit),
    duration = unit === 'milliseconds' ? 60000n : 60000000n;
  return `${epoch},100.00,102.00,99.00,101.00,10.00,${epoch + duration - 1n},1000.00,4,5.00,500.00,0`;
}
async function archive(period: string, csv: string, checksum = true): Promise<ArchiveInput> {
  const directory = await temporaryDirectory(),
    name = `BTCUSDT-1m-${period}`,
    path = join(directory, `${name}.zip`);
  const bytes = zipSync(
    { [`${name}.csv`]: strToU8(`${csv}\n`) },
    { mtime: new Date('2026-01-01T00:00:00Z') },
  );
  await writeFile(path, bytes);
  if (checksum) await writeFile(`${path}.CHECKSUM`, `${byteHash(bytes).slice(7)}  ${name}.zip\n`);
  return {
    path,
    capturedAt: '2026-01-02T00:00:00Z',
    marketType: 'SPOT',
    sourceUri: `https://data.binance.vision/data/spot/${period.length === 10 ? 'daily' : 'monthly'}/klines/BTCUSDT/1m/${name}.zip`,
  };
}
const archiveRequest = (from: string, to: string) =>
  MarketImportRequestSchema.parse({
    ...request,
    provider: 'binance-archive',
    symbols: ['BTCUSDT'],
    from,
    to,
  });

describe('golden offline normalization', () => {
  it('holds a normalized batch until every contributing file capture is known', async () => {
    const bundles = await new FixtureMarketDataProvider().read(request);
    const changed = bundles.map((bundle, index) =>
      index === 1
        ? MarketSourceBundleSchema.parse({
            ...bundle,
            source: { ...bundle.source, capturedAt: '2026-01-03T00:00:00Z' },
          })
        : bundle,
    );
    const imported = normalizeMarketImport(request, changed);
    expect(
      decisionView(
        MarketBarSchema,
        imported.bars.map((row) => row.bar),
        utc('2026-01-02T00:00:00Z'),
      ).records,
    ).toHaveLength(0);
    expect(imported.bars.every((row) => row.bar.availableAt === utc('2026-01-03T00:00:00Z'))).toBe(
      true,
    );
  });
  it('reports gaps, duplicates, out-of-order rows, bad prices, negative volume and unit mismatches', async () => {
    const result = await fixtureImport();
    expect(result.bars).toHaveLength(9);
    expect(result.quarantine).toHaveLength(7);
    expect(
      result.coverage.map((row) => ({
        symbol: row.symbol,
        accepted: row.acceptedBars,
        missing: row.missingBars,
        quarantined: row.quarantinedRows,
        duplicates: row.duplicateRows,
        conflicts: row.conflictingRows,
        outOfOrder: row.outOfOrderRows,
        outside: row.outsideWindowRows,
      })),
    ).toEqual([
      {
        symbol: 'BTCUSDT',
        accepted: 3,
        missing: 2,
        quarantined: 1,
        duplicates: 1,
        conflicts: 0,
        outOfOrder: 2,
        outside: 0,
      },
      {
        symbol: 'ETHUSDT',
        accepted: 1,
        missing: 4,
        quarantined: 5,
        duplicates: 0,
        conflicts: 2,
        outOfOrder: 0,
        outside: 0,
      },
      {
        symbol: 'SOLUSDT',
        accepted: 5,
        missing: 0,
        quarantined: 1,
        duplicates: 0,
        conflicts: 0,
        outOfOrder: 0,
        outside: 1,
      },
    ]);
    expect(result.coverage[0]?.missingRanges).toEqual([
      { from: utc('2026-01-01T00:03:00Z'), to: utc('2026-01-01T00:05:00Z'), bars: 2 },
    ]);
    expect(result.quarantine.map((row) => row.reason)).toEqual(
      expect.arrayContaining([
        'INVALID_OHLCV',
        'CONFLICTING_DUPLICATE',
        'TIMESTAMP_UNIT',
        'CSV_SYNTAX',
        'IDENTITY_MISMATCH',
      ]),
    );
    expect(canonicalHash(result.bars)).toBe(
      'sha256:acfeef280261e4efe1c36d71f7a0cc0e8cee6a09b79ebbbcf860e84fe83c7328',
    );
  });
  it('preserves invalid raw evidence, keeps both conflicts out, and never forward-fills a missing price', async () => {
    const result = await fixtureImport();
    expect(result.quarantine.some((row) => row.raw.endsWith('unterminated'))).toBe(true);
    const conflicts = result.quarantine.filter((row) => row.reason === 'CONFLICTING_DUPLICATE');
    expect(conflicts).toHaveLength(2);
    expect(new Set(conflicts.map((row) => row.rawHash)).size).toBe(2);
    expect(
      result.bars.some(
        (row) => row.source.symbol === 'ETHUSDT' && row.bar.openAt === utc('2026-01-01T00:01:00Z'),
      ),
    ).toBe(false);
    expect(result.bars.find((row) => row.source.symbol === 'SOLUSDT')?.bar.volume).toBe(
      '9007199254740993.000000000000000001',
    );
    expect(
      result.bars.every(
        (row) =>
          row.source.fileHash.startsWith('sha256:') && row.source.uri.startsWith('fixture://'),
      ),
    ).toBe(true);
  });
  it('normalizes bundle/request order and sorts output without discarding disorder diagnostics', async () => {
    const provider = new FixtureMarketDataProvider(),
      bundles = await provider.read(request),
      expected = normalizeMarketImport(request, bundles);
    const reversed = MarketImportRequestSchema.parse({
      ...request,
      symbols: [...request.symbols].reverse(),
    });
    expect(normalizeMarketImport(reversed, [...bundles].reverse())).toEqual(expected);
    const btc = expected.bars.filter((row) => row.source.symbol === 'BTCUSDT');
    expect(btc.map((row) => row.bar.openAt)).toEqual([
      utc('2026-01-01T00:00:00Z'),
      utc('2026-01-01T00:01:00Z'),
      utc('2026-01-01T00:02:00Z'),
    ]);
    expect(btc[1]?.bar.qualityFlags).toContain('OUT_OF_ORDER');
  });
  it('gates fixture observations at file capture rather than pretending the offline file was known at each close', async () => {
    const imported = await fixtureImport(),
      bars = imported.bars.map((row) => row.bar);
    expect(decisionView(MarketBarSchema, bars, utc('2026-01-01T00:05:00Z')).records).toHaveLength(
      0,
    );
    expect(decisionView(MarketBarSchema, bars, utc('2026-01-02T00:00:00Z')).records).toHaveLength(
      9,
    );
  });
  it('rejects unaligned/unbounded requests, unknown symbols and inconsistent provider metadata', async () => {
    const bundles = await new FixtureMarketDataProvider().read(request);
    expect(() =>
      normalizeMarketImport({ ...request, from: utc('2026-01-01T00:00:00.000000001Z') }, bundles),
    ).toThrow('LIMIT');
    expect(() =>
      normalizeMarketImport({ ...request, to: utc('2027-01-01T00:00:00Z') }, bundles),
    ).toThrow('LIMIT');
    expect(() => normalizeMarketImport({ ...request, symbols: ['UNKNOWNUSDT'] }, [])).toThrow(
      'INPUT',
    );
    const first = bundles[0];
    if (!first) throw new Error();
    expect(
      MarketSourceBundleSchema.safeParse({
        ...first,
        source: { ...first.source, origin: 'PUBLIC_READ_ONLY' },
      }).success,
    ).toBe(false);
  });
});

describe('versioned local public archive adapter', () => {
  it('handles the documented ms/us boundary explicitly and checks ZIP sidecars', async () => {
    const files = [
      await archive('2024-12-31', kline('2024-12-31T23:59:00Z', 'milliseconds')),
      await archive('2025-01-01', kline('2025-01-01T00:00:00Z')),
    ];
    const window = archiveRequest('2024-12-31T23:59:00Z', '2025-01-01T00:01:00Z');
    const bundles = await new BinanceArchiveMarketDataProvider(files).read(window),
      result = normalizeMarketImport(window, bundles);
    expect(result.bars).toHaveLength(2);
    expect(result.quarantine).toHaveLength(0);
    expect(result.sources.map((source) => source.timestampUnit)).toEqual([
      'milliseconds',
      'microseconds',
    ]);
    expect(result.sources.every((source) => source.checksumStatus === 'VERIFIED')).toBe(true);
    expect(result.bars.map((row) => row.bar.closeAt)).toEqual([
      utc('2025-01-01T00:00:00Z'),
      utc('2025-01-01T00:01:00Z'),
    ]);
    expect(
      result.bars.every(
        (row) => row.bar.availableAt === null && row.bar.researchUse === 'DESCRIPTIVE_ONLY',
      ),
    ).toBe(true);
    expect(
      decisionView(
        MarketBarSchema,
        result.bars.map((row) => row.bar),
        utc('2030-01-01T00:00:00Z'),
      ).records,
    ).toHaveLength(0);
  });
  it('supports monthly members and never infers units from timestamp magnitude', async () => {
    const file = await archive(
      '2025-01',
      [kline('2025-01-01T00:00:00Z'), kline('2025-01-01T00:01:00Z', 'milliseconds')].join('\n'),
      false,
    );
    const window = archiveRequest('2025-01-01T00:00:00Z', '2025-01-01T00:02:00Z');
    const result = normalizeMarketImport(
      window,
      await new BinanceArchiveMarketDataProvider([file]).read(window),
    );
    expect(result.bars).toHaveLength(1);
    expect(result.quarantine[0]?.reason).toBe('TIMESTAMP_OR_PERIOD');
    expect(result.sources[0]?.checksumStatus).toBe('NOT_SUPPLIED');
    expect(result.coverage[0]?.missingBars).toBe(1);
  });
  it('refuses bad or missing supplied checksums and mismatched source attribution', async () => {
    const file = await archive('2025-01-01', kline('2025-01-01T00:00:00Z'));
    const provider = () => new BinanceArchiveMarketDataProvider([file]),
      window = archiveRequest('2025-01-01T00:00:00Z', '2025-01-01T00:01:00Z');
    await writeFile(`${file.path}.CHECKSUM`, `${'0'.repeat(64)}  ${basename(file.path)}\n`);
    await expect(provider().read(window)).rejects.toMatchObject({ code: 'CHECKSUM' });
    await expect(
      new BinanceArchiveMarketDataProvider([
        { ...file, checksumPath: join(dirname(file.path), 'missing') },
      ]).read(window),
    ).rejects.toMatchObject({ code: 'CHECKSUM' });
    await expect(
      new BinanceArchiveMarketDataProvider([
        { ...file, sourceUri: file.sourceUri.replace('/spot/', '/futures/um/') },
      ]).read(window),
    ).rejects.toMatchObject({ code: 'INPUT' });
  });
  it('rejects archive traversal, multiple members, corrupt CRCs and oversized claims without extraction', async () => {
    const name = 'BTCUSDT-1m-2025-01-01.csv',
      csv = kline('2025-01-01T00:00:00Z');
    const traversal = Buffer.from(zipSync({ [`../${name}`]: strToU8(csv) }));
    await expect(readSingleCsvZip(traversal, name)).rejects.toMatchObject({ code: 'ARCHIVE' });
    const multiple = Buffer.from(zipSync({ [name]: strToU8(csv), 'extra.csv': strToU8(csv) }));
    await expect(readSingleCsvZip(multiple, name)).rejects.toMatchObject({ code: 'ARCHIVE' });
    const badCrc = Buffer.from(zipSync({ [name]: strToU8(csv) }, { level: 0 }));
    const where = badCrc.indexOf(Buffer.from('100.00'));
    if (where < 0) throw new Error();
    badCrc[where] = 0x39;
    await expect(readSingleCsvZip(badCrc, name)).rejects.toMatchObject({ code: 'ARCHIVE' });
    const large = Buffer.from(zipSync({ [name]: strToU8(csv) })),
      central = large.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    if (central < 0) throw new Error();
    large.writeUInt32LE(64 * 1024 * 1024 + 1, central + 24);
    await expect(readSingleCsvZip(large, name)).rejects.toMatchObject({ code: 'ARCHIVE' });
  });
});
describe('immutable deterministic Parquet snapshots', () => {
  it('bounds metadata reads before allocating oversized artifact content', async () => {
    const imported = await fixtureImport(),
      saved = await writeMarketSnapshot(imported, await temporaryDirectory(), 'fixture-code.v1');
    await truncate(join(saved.directory, 'manifest.json'), 64 * 1024 * 1024 + 1);
    await expect(verifyMarketSnapshot(saved.directory)).rejects.toMatchObject({ code: 'LIMIT' });
  });
  it('round-trips exact domain strings through actual Parquet and has a stable golden byte hash', async () => {
    const imported = await fixtureImport(),
      root = await temporaryDirectory(),
      saved = await writeMarketSnapshot(imported, root, 'fixture-code.v1');
    expect((await readFile(join(saved.directory, 'bars.parquet'))).subarray(0, 4).toString()).toBe(
      'PAR1',
    );
    expect(saved.manifest.parquetHash).toBe(
      'sha256:410aa71af1dd7047eb9977a3ffffeb61155de3fedd27f95611ef319c44706c38',
    );
    expect(await readMarketParquet(join(saved.directory, 'bars.parquet'))).toEqual(imported.bars);
    expect((await verifyMarketSnapshot(saved.directory)).metadataHash).toBe(saved.metadataHash);
  });
  it('produces identical bytes/metadata in separate roots and reuses an existing immutable snapshot', async () => {
    const imported = await fixtureImport(),
      root = await temporaryDirectory(),
      other = await temporaryDirectory();
    const first = await writeMarketSnapshot(imported, root, 'fixture-code.v1'),
      before = await stat(join(first.directory, 'bars.parquet'));
    const second = await writeMarketSnapshot(imported, other, 'fixture-code.v1'),
      third = await writeMarketSnapshot(imported, root, 'fixture-code.v1');
    expect(second.manifest).toEqual(first.manifest);
    expect(third.metadataHash).toBe(first.metadataHash);
    expect((await stat(join(third.directory, 'bars.parquet'))).mtimeMs).toBe(before.mtimeMs);
  });
  it('detects tampering and refuses to overwrite a conflicting content-addressed snapshot', async () => {
    const imported = await fixtureImport(),
      saved = await writeMarketSnapshot(imported, await temporaryDirectory(), 'fixture-code.v1');
    const path = join(saved.directory, 'bars.parquet'),
      bad = Buffer.from('tampered');
    await writeFile(path, bad);
    await expect(verifyMarketSnapshot(saved.directory)).rejects.toMatchObject({ code: 'OUTPUT' });
    await expect(
      writeMarketSnapshot(imported, dirname(saved.directory), 'fixture-code.v1'),
    ).rejects.toMatchObject({ code: 'OUTPUT' });
    expect(await readFile(path)).toEqual(bad);
  });
  it('publishes an empty valid Parquet table with full gap reporting when the requested range has no data', async () => {
    const emptyRequest = MarketImportRequestSchema.parse({
      ...request,
      from: '2026-01-02T00:00:00Z',
      to: '2026-01-02T00:01:00Z',
    });
    const imported = normalizeMarketImport(
      emptyRequest,
      await new FixtureMarketDataProvider().read(emptyRequest),
    );
    expect(imported.bars).toHaveLength(0);
    expect(imported.coverage.every((report) => report.missingBars === 1)).toBe(true);
    const saved = await writeMarketSnapshot(
      imported,
      await temporaryDirectory(),
      'fixture-code.v1',
    );
    expect(await readMarketParquet(join(saved.directory, 'bars.parquet'))).toEqual([]);
  });
  it('runs the user CLI and rejects unsupported secret/live flags without reflecting their values', async () => {
    const root = await temporaryDirectory(),
      args = [
        '--import',
        'tsx',
        'apps/cli/src/market.ts',
        'import',
        '--provider',
        'fixture',
        '--symbols',
        'BTCUSDT,ETHUSDT,SOLUSDT',
        '--from',
        '2026-01-01T00:00:00Z',
        '--to',
        '2026-01-01T00:05:00Z',
        '--out',
        root,
      ];
    const response = await execFileAsync(process.execPath, args, { env: { ...process.env } });
    const report: unknown = JSON.parse(response.stdout);
    expect(report).toMatchObject({ acceptedBars: 9, quarantinedRows: 7, provider: 'fixture' });
    let stderr = '';
    try {
      await execFileAsync(process.execPath, [...args, '--api-key', 'do-not-echo-secret']);
    } catch (error) {
      if (error && typeof error === 'object' && 'stderr' in error) stderr = String(error.stderr);
    }
    expect(stderr).toContain('Market import failed');
    expect(stderr).not.toContain('do-not-echo-secret');
  });
});
