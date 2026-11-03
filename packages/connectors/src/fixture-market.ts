import { readFile } from 'node:fs/promises';
import { MarketImportRequestSchema, MarketSourceBundleSchema } from '@crypto/contracts';
import type { MarketImportRequest, MarketSourceBundle } from '@crypto/contracts';
import { byteHash, instrumentFor, parsePhysicalRows } from './market-common.js';
import type { MarketDataProvider } from './market-common.js';

export const fixtureHeader =
  'symbol,market_type,interval,timestamp_unit,open_time,open,high,low,close,volume,close_time,observed_at';
export class FixtureMarketDataProvider implements MarketDataProvider {
  readonly id = 'fixture' as const;
  async read(input: MarketImportRequest): Promise<MarketSourceBundle[]> {
    const request = MarketImportRequestSchema.parse(input);
    if (request.provider !== 'fixture' || request.interval !== '1m')
      throw new Error('Unsupported fixture request');
    const bundles: MarketSourceBundle[] = [];
    for (const symbol of [...request.symbols].sort()) {
      const instrumentId = instrumentFor(symbol),
        name = `${symbol}-1m-2026-01-01.csv`;
      const bytes = await readFile(
        new URL(`../../../tests/fixtures/market/${name}`, import.meta.url),
      );
      bundles.push(
        MarketSourceBundleSchema.parse({
          source: {
            schemaVersion: 'market-source.v1',
            provider: this.id,
            providerVersion: 'fixture-market.v1',
            format: 'fixture-ohlcv.v1',
            symbol,
            instrumentId,
            marketType: 'SPOT',
            interval: '1m',
            period: '2026-01-01',
            timestampUnit: 'milliseconds',
            capturedAt: '2026-01-02T00:00:00Z',
            uri: `fixture://market/${name}`,
            fileHash: byteHash(bytes),
            member: name,
            memberHash: byteHash(bytes),
            checksumStatus: 'NOT_SUPPLIED',
            origin: 'FIXTURE',
            license: 'SYNTHETIC',
            termsUrl: 'fixture://locally-authored',
          },
          rows: parsePhysicalRows(bytes, fixtureHeader),
        }),
      );
    }
    return bundles;
  }
}
