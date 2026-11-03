import { createHash } from 'node:crypto';
import { FixedIntervalSchema, SymbolMappingSchema } from '@crypto/contracts';
import type { FixedInterval, MarketImportRequest, MarketSourceBundle } from '@crypto/contracts';
import { fromEpoch, toEpoch, utc } from '@crypto/core';
import { parse } from 'csv-parse/sync';
import { z } from 'zod';

export interface MarketDataProvider {
  readonly id: 'fixture' | 'binance-archive';
  read(request: MarketImportRequest): Promise<MarketSourceBundle[]>;
}
export class MarketImportError extends Error {
  constructor(
    readonly code:
      'INPUT' | 'LIMIT' | 'CHECKSUM' | 'ARCHIVE' | 'MANIFEST' | 'OUTPUT' | 'PERSISTENCE',
  ) {
    super(`Market import failed: ${code}`);
    this.name = 'MarketImportError';
  }
}
export const defaultSymbolMappings = [
  { providerSymbol: 'BTCUSDT', instrumentId: 'BTC/USDT' },
  { providerSymbol: 'ETHUSDT', instrumentId: 'ETH/USDT' },
  { providerSymbol: 'SOLUSDT', instrumentId: 'SOL/USDT' },
];
export function instrumentFor(symbol: string, mappings: unknown = defaultSymbolMappings): string {
  const items = z.array(SymbolMappingSchema).parse(mappings),
    mapping = items.find((item) => item.providerSymbol === symbol);
  if (!mapping || new Set(items.map((item) => item.providerSymbol)).size !== items.length)
    throw new MarketImportError('INPUT');
  return mapping.instrumentId;
}
export function byteHash(data: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(data).digest('hex')}`;
}
export function intervalNanoseconds(value: FixedInterval): bigint {
  const interval = FixedIntervalSchema.parse(value),
    count = BigInt(interval.slice(0, -1)),
    unit = interval.slice(-1);
  return count * ({ s: 1n, m: 60n, h: 3600n, d: 86400n }[unit] ?? 0n) * 1000000000n;
}
export function periodBounds(period: string) {
  if (!/^\d{4}-\d{2}(?:-\d{2})?$/.test(period)) throw new MarketImportError('INPUT');
  const daily = period.length === 10,
    start = utc(`${period}${daily ? '' : '-01'}T00:00:00Z`);
  let end;
  if (daily) end = fromEpoch(toEpoch(start, 'nanoseconds') + 86400000000000n, 'nanoseconds');
  else {
    const year = Number(period.slice(0, 4)),
      month = Number(period.slice(5));
    end = utc(
      `${month === 12 ? year + 1 : year}-${String(month === 12 ? 1 : month + 1).padStart(2, '0')}-01T00:00:00Z`,
    );
  }
  return { start, end };
}
export function parsePhysicalRows(data: Uint8Array, header: string | null) {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    throw new MarketImportError('INPUT');
  }
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.length > 200001) throw new MarketImportError('LIMIT');
  if (header !== null && lines[0]?.replace(/\r$/, '') !== header)
    throw new MarketImportError('INPUT');
  return lines.slice(header === null ? 0 : 1).map((original, index) => {
    const raw = original.replace(/\r$/, '');
    if (Buffer.byteLength(raw, 'utf8') > 8192) throw new MarketImportError('LIMIT');
    let fields: string[] | null;
    try {
      const decoded: unknown = parse(raw, {
        columns: false,
        relax_column_count: true,
        max_record_size: 8192,
      });
      const rows = z.array(z.array(z.string())).parse(decoded);
      fields = rows.length === 1 ? (rows[0] ?? null) : null;
    } catch {
      fields = null;
    }
    return { line: index + (header === null ? 1 : 2), raw, fields };
  });
}
