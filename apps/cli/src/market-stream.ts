import { resolve } from 'node:path';
import { StreamConfigSchema } from '@crypto/contracts';
import {
  BinancePublicStream,
  runMarketStream,
  syntheticStreamConfig,
  syntheticStreamSteps,
} from '@crypto/connectors';
import { replayStreamRecording, writeStreamRecording } from '@crypto/research';
import { workingTreeVersion } from './database-fixtures.js';

export async function marketStreamCommand(args: string[]): Promise<void> {
  const command = args[0],
    flags = new Map<string, string>();
  const allowed =
    command === 'stream'
      ? ['--provider', '--symbol', '--duration-ms', '--out']
      : command === 'replay'
        ? ['--recording']
        : [];
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index],
      value = args[index + 1];
    if (!flag || !allowed.includes(flag) || flags.has(flag) || !value || value.startsWith('--'))
      throw new Error('Invalid stream flags');
    flags.set(flag, value);
  }
  if (command === 'replay') {
    const path = flags.get('--recording');
    if (!path) throw new Error('Missing recording');
    const result = await replayStreamRecording(resolve(path));
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: 'stream-replay-report.v1', verified: true, count: result.manifest.count, metadataHash: result.metadataHash, finalHash: result.manifest.finalHash })}\n`,
    );
    return;
  }
  const config = StreamConfigSchema.parse({
    ...syntheticStreamConfig,
    provider: flags.get('--provider') ?? 'synthetic',
    symbol: flags.get('--symbol') ?? 'BTCUSDT',
  });
  if (
    config.provider === 'synthetic' &&
    (flags.has('--duration-ms') || config.symbol !== 'BTCUSDT')
  )
    throw new Error('Synthetic script is fixed BTCUSDT');
  const duration = flags.get('--duration-ms') ?? '5000';
  if (!/^\d+$/.test(duration) || Number(duration) < 100 || Number(duration) > 60000)
    throw new Error('Invalid duration');
  const result = await writeStreamRecording(
    config,
    config.provider === 'synthetic'
      ? syntheticStreamSteps()
      : runMarketStream(config, new BinancePublicStream(config), Number(duration)),
    resolve(flags.get('--out') ?? 'data/market-streams'),
    await workingTreeVersion(),
  );
  process.stdout.write(
    `${JSON.stringify({ schemaVersion: 'stream-capture-report.v1', provider: config.provider, symbol: config.symbol, execution: 'DISABLED', directory: result.directory, metadataHash: result.metadataHash, count: result.manifest.count, usableObservations: result.records.filter((r) => r.view.usable).length, faults: result.records.filter((r) => r.step.input.kind === 'FAULT').map((r) => r.step.input), finalStatus: result.records.at(-1)?.view.status }, null, 2)}\n`,
  );
}
