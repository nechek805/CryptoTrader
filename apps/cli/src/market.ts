import { resolve } from 'node:path';
import { MarketImportRequestSchema } from '@crypto/contracts';
import {
  BinanceArchiveMarketDataProvider,
  FixtureMarketDataProvider,
  loadArchiveInputs,
  MarketImportError,
} from '@crypto/connectors';
import { ResearchDatabase } from '@crypto/db';
import { normalizeMarketImport, persistMarketImport, writeMarketSnapshot } from '@crypto/research';
import { workingTreeVersion } from './database-fixtures.js';
import { marketStreamCommand } from './market-stream.js';
import { marketQualityCommand } from './market-quality.js';

function parseFlags(args: string[]): Map<string, string | boolean> {
  const known = new Set([
      '--provider',
      '--symbols',
      '--from',
      '--to',
      '--interval',
      '--out',
      '--archives',
      '--persist',
    ]),
    flags = new Map<string, string | boolean>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!flag || !known.has(flag) || flags.has(flag)) throw new MarketImportError('INPUT');
    if (flag === '--persist') {
      flags.set(flag, true);
      continue;
    }
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new MarketImportError('INPUT');
    flags.set(flag, value);
  }
  return flags;
}
async function main() {
  if (['quality', 'verify-quality', 'serve-fixture'].includes(process.argv[2] ?? ''))
    return marketQualityCommand(process.argv.slice(2));
  if (process.argv[2] === 'stream' || process.argv[2] === 'replay')
    return marketStreamCommand(process.argv.slice(2));
  if (process.argv[2] !== 'import') throw new MarketImportError('INPUT');
  const flags = parseFlags(process.argv.slice(3));
  const symbols = flags.get('--symbols');
  const request = MarketImportRequestSchema.parse({
    schemaVersion: 'market-import-request.v1',
    provider: flags.get('--provider'),
    symbols: typeof symbols === 'string' ? symbols.split(',') : [],
    from: flags.get('--from'),
    to: flags.get('--to'),
    interval: flags.get('--interval') ?? '1m',
  });
  const manifest = flags.get('--archives');
  if (request.provider === 'fixture' && manifest !== undefined)
    throw new MarketImportError('INPUT');
  const provider =
    request.provider === 'fixture'
      ? new FixtureMarketDataProvider()
      : new BinanceArchiveMarketDataProvider(
          await loadArchiveInputs(typeof manifest === 'string' ? manifest : ''),
        );
  const imported = normalizeMarketImport(request, await provider.read(request)),
    codeVersion = await workingTreeVersion();
  const output = flags.get('--out'),
    snapshot = await writeMarketSnapshot(
      imported,
      typeof output === 'string' ? output : resolve('data/market'),
      codeVersion,
    );
  let persistence;
  if (flags.get('--persist') === true) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new MarketImportError('PERSISTENCE');
    const db = new ResearchDatabase({
      connectionString,
      schema: process.env.DATABASE_SCHEMA ?? 'crypto_research',
    });
    try {
      persistence = await persistMarketImport(db, imported, snapshot, codeVersion);
    } catch {
      throw new MarketImportError('PERSISTENCE');
    } finally {
      await db.close();
    }
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 'market-import-report.v1',
        provider: request.provider,
        snapshotId: snapshot.manifest.id,
        directory: snapshot.directory,
        metadataHash: snapshot.metadataHash,
        parquetHash: snapshot.manifest.parquetHash,
        datasetHash: snapshot.manifest.datasetHash,
        acceptedBars: imported.bars.length,
        quarantinedRows: imported.quarantine.length,
        coverage: imported.coverage,
        ...(persistence ? { persistence } : {}),
      },
      null,
      2,
    )}\n`,
  );
}
void main().catch((error) => {
  const code = error instanceof MarketImportError ? error.code : 'INPUT';
  const label =
    process.argv[2] === 'import'
      ? 'import'
      : ['stream', 'replay'].includes(process.argv[2] ?? '')
        ? 'stream/replay'
        : 'quality/query';
  process.stderr.write(
    `Market ${label} failed: ${code}. Check command flags, input integrity, network and output configuration.\n`,
  );
  process.exitCode = 1;
});
