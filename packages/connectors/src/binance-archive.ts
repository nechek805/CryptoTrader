import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { dirname, resolve } from 'node:path';
import { fromBufferPromise } from 'yauzl';
import { z } from 'zod';
import {
  MarketImportRequestSchema,
  MarketSourceBundleSchema,
  UtcTimestampSchema,
} from '@crypto/contracts';
import type { MarketImportRequest, MarketSourceBundle } from '@crypto/contracts';
import {
  byteHash,
  instrumentFor,
  MarketImportError,
  parsePhysicalRows,
  periodBounds,
} from './market-common.js';
import type { MarketDataProvider } from './market-common.js';

const ArchiveInputSchema = z.strictObject({
  path: z.string().min(1),
  checksumPath: z.string().min(1).optional(),
  capturedAt: UtcTimestampSchema,
  marketType: z.literal('SPOT'),
  sourceUri: z.url(),
});
export type ArchiveInput = z.input<typeof ArchiveInputSchema>;
export const ArchiveInputListSchema = z.strictObject({
  schemaVersion: z.literal('archive-input-list.v1'),
  files: z.array(ArchiveInputSchema).min(1).max(100),
});
export async function loadArchiveInputs(path: string): Promise<ArchiveInput[]> {
  if ((await stat(path)).size > 1024 * 1024) throw new MarketImportError('LIMIT');
  const raw: unknown = JSON.parse(await readFile(path, 'utf8')),
    list = ArchiveInputListSchema.parse(raw),
    base = dirname(resolve(path));
  return list.files.map((file) => ({
    ...file,
    path: resolve(base, file.path),
    ...(file.checksumPath ? { checksumPath: resolve(base, file.checksumPath) } : {}),
  }));
}
const MAX_ARCHIVE = 16 * 1024 * 1024,
  MAX_MEMBER = 64 * 1024 * 1024;
const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let i = 0; i < 8; i++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = (crcTable[(value ^ byte) & 255] ?? 0) ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
export async function readSingleCsvZip(bytes: Buffer, expectedMember: string): Promise<Buffer> {
  if (bytes.length > MAX_ARCHIVE) throw new MarketImportError('LIMIT');
  try {
    const zip = await fromBufferPromise(bytes, {
      lazyEntries: true,
      autoClose: false,
      strictFileNames: true,
      validateEntrySizes: true,
    });
    try {
      if (zip.entryCount !== 1) throw new MarketImportError('ARCHIVE');
      let result: Buffer | undefined;
      for await (const entry of zip.eachEntry()) {
        if (
          entry.fileName !== expectedMember ||
          entry.isEncrypted() ||
          ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000 ||
          entry.uncompressedSize > MAX_MEMBER ||
          entry.compressedSize > MAX_ARCHIVE
        )
          throw new MarketImportError('ARCHIVE');
        const stream = await zip.openReadStreamPromise(entry),
          chunks: Buffer[] = [];
        let count = 0;
        for await (const chunk of stream) {
          if (!Buffer.isBuffer(chunk)) throw new MarketImportError('ARCHIVE');
          count += chunk.length;
          if (count > MAX_MEMBER) {
            stream.destroy();
            throw new MarketImportError('LIMIT');
          }
          chunks.push(chunk);
        }
        result = Buffer.concat(chunks);
        if (result.length !== entry.uncompressedSize || crc32(result) !== entry.crc32)
          throw new MarketImportError('ARCHIVE');
      }
      if (!result) throw new MarketImportError('ARCHIVE');
      return result;
    } finally {
      zip.close();
    }
  } catch (error) {
    if (error instanceof MarketImportError) throw error;
    throw new MarketImportError('ARCHIVE');
  }
}
async function checksumText(path: string, required: boolean): Promise<string | null> {
  try {
    if ((await stat(path)).size > 4096) throw new MarketImportError('CHECKSUM');
    return await readFile(path, 'utf8');
  } catch (error) {
    if (
      !required &&
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    )
      return null;
    throw new MarketImportError('CHECKSUM');
  }
}
/** Reads caller-supplied local archives only. No downloader or authenticated connector. */
export class BinanceArchiveMarketDataProvider implements MarketDataProvider {
  readonly id = 'binance-archive' as const;
  #files: ArchiveInput[];
  constructor(files: ArchiveInput[]) {
    this.#files = z.array(ArchiveInputSchema).min(1).max(100).parse(files);
  }
  async read(input: MarketImportRequest): Promise<MarketSourceBundle[]> {
    const request = MarketImportRequestSchema.parse(input);
    if (request.provider !== this.id) throw new MarketImportError('INPUT');
    const bundles: MarketSourceBundle[] = [];
    let total = 0,
      totalCsv = 0,
      totalRows = 0;
    for (const descriptor of this.#files) {
      const name = basename(descriptor.path),
        match = /^([A-Z0-9]+)-(\d+[smhd])-(\d{4}-\d{2}(?:-\d{2})?)\.zip$/.exec(name);
      if (!match) throw new MarketImportError('INPUT');
      const symbol = match[1] ?? '',
        interval = match[2],
        period = match[3] ?? '',
        bounds = periodBounds(period);
      if (
        !request.symbols.includes(symbol) ||
        interval !== request.interval ||
        bounds.start >= request.to ||
        bounds.end <= request.from
      )
        throw new MarketImportError('INPUT');
      const instrumentId = instrumentFor(symbol),
        info = await stat(descriptor.path);
      const sourceUri = `https://data.binance.vision/data/spot/${period.length === 10 ? 'daily' : 'monthly'}/klines/${symbol}/${interval}/${name}`;
      if (descriptor.sourceUri !== sourceUri) throw new MarketImportError('INPUT');
      if (!info.isFile() || info.size > MAX_ARCHIVE) throw new MarketImportError('LIMIT');
      const bytes = await readFile(descriptor.path);
      total += bytes.length;
      if (total > 128 * 1024 * 1024) throw new MarketImportError('LIMIT');
      const hash = byteHash(bytes),
        checksum = await checksumText(
          descriptor.checksumPath ?? `${descriptor.path}.CHECKSUM`,
          descriptor.checksumPath !== undefined,
        );
      if (checksum !== null) {
        const expected = /^([a-fA-F0-9]{64})[ \t]+\*?([^\r\n]+)$/.exec(checksum.trim());
        if (!expected || expected[2] !== name || `sha256:${expected[1]?.toLowerCase()}` !== hash)
          throw new MarketImportError('CHECKSUM');
      }
      const member = name.replace(/\.zip$/, '.csv'),
        csv = await readSingleCsvZip(bytes, member);
      totalCsv += csv.length;
      if (totalCsv > 128 * 1024 * 1024) throw new MarketImportError('LIMIT');
      const rows = parsePhysicalRows(csv, null);
      totalRows += rows.length;
      if (totalRows > 200000) throw new MarketImportError('LIMIT');
      const modern = period >= '2025-01';
      bundles.push(
        MarketSourceBundleSchema.parse({
          source: {
            schemaVersion: 'market-source.v1',
            provider: this.id,
            providerVersion: 'binance-vision-spot.v1',
            format: modern ? 'binance-spot-klines-us.v1' : 'binance-spot-klines-ms.v1',
            symbol,
            instrumentId,
            marketType: 'SPOT',
            interval,
            period,
            timestampUnit: modern ? 'microseconds' : 'milliseconds',
            capturedAt: descriptor.capturedAt,
            uri: sourceUri,
            fileHash: hash,
            member,
            memberHash: byteHash(csv),
            checksumStatus: checksum === null ? 'NOT_SUPPLIED' : 'VERIFIED',
            origin: 'PUBLIC_READ_ONLY',
            license: 'CC-BY-NC-SA-4.0',
            termsUrl:
              'https://github.com/binance/binance-public-data/blob/master/TERMS_AND_CONDITIONS.md',
          },
          rows,
        }),
      );
    }
    return bundles;
  }
}
