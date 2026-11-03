import { lstat, readFile } from 'node:fs/promises';
import {
  marketBaselineFixture,
  writeMarketBaseline,
  verifyMarketBaseline,
  marketBaselineMarkdown,
} from '@crypto/backtest';
import type { MarketStrategyConfig } from '@crypto/contracts';
import { workingTreeVersion } from './database-fixtures.js';
export async function marketBaselinesCli(args: string[]) {
  const command = args[0],
    allowed =
      command === 'market-fixture'
        ? ['--out', '--asset', '--regime', '--strategy']
        : command === 'market-matrix'
          ? ['--out']
          : command === 'market-run'
            ? ['--manifest', '--out']
            : command === 'market-reproduce'
              ? ['--directory', '--out']
              : command === 'market-verify' || command === 'market-report'
                ? ['--directory']
                : null;
  if (!allowed) throw new Error('Invalid market baseline command');
  const options = new Map<string, string>();
  for (let i = 1; i < args.length; i += 2) {
    const k = args[i]!,
      v = args[i + 1];
    if (!allowed.includes(k) || options.has(k) || !v || v.startsWith('--'))
      throw new Error('Invalid market baseline option');
    options.set(k, v);
  }
  const required = (k: string) => {
    const v = options.get(k);
    if (!v) throw new Error('Required market baseline option');
    return v;
  };
  if (command === 'market-verify' || command === 'market-report') {
    const v = await verifyMarketBaseline(required('--directory'));
    process.stdout.write(
      command === 'market-report'
        ? marketBaselineMarkdown(v.report)
        : `${JSON.stringify({ valid: true, directory: v.directory, hash: v.hash, execution: v.report.execution })}\n`,
    );
    return;
  }
  const code = await workingTreeVersion(),
    root = options.get('--out') ?? 'data/market-baselines';
  const publish = async (m: unknown, version = code) => {
    const v = await writeMarketBaseline(m, root, version);
    process.stdout.write(
      `${JSON.stringify({ directory: v.directory, hash: v.hash, synthetic: v.report.manifest.backtest.input.market.sources.every((s) => s.origin === 'SYNTHETIC'), execution: v.report.execution, asset: v.report.manifest.backtest.series.asset, regime: v.report.manifest.regime, provider: v.report.manifest.provider.kind, ...(v.report.execution === 'SIMULATED' ? { metrics: v.report.outcomes[0]!.metrics } : {}) })}\n`,
    );
  };
  if (command === 'market-matrix') {
    for (const asset of ['BTC', 'ETH', 'SOL'] as const) {
      for (const regime of ['TREND', 'WHIPSAW', 'REVERSAL'] as const)
        for (const kind of [
          'CASH',
          'BUY_AND_HOLD',
          'MA_CROSSOVER',
          'BREAKOUT',
          'ZSCORE_REVERSION',
        ] as const)
          await publish(marketBaselineFixture(asset, regime, kind));
      await publish(marketBaselineFixture(asset, 'REVERSAL', 'SYMMETRIC_MA_FIXTURE'));
    }
    return;
  }
  if (command === 'market-reproduce') {
    const v = await verifyMarketBaseline(required('--directory'));
    await publish(
      v.report.manifest,
      v.report.execution === 'DISABLED'
        ? v.report.replay.manifest.codeVersion
        : v.report.codeVersion,
    );
    return;
  }
  if (command === 'market-run') {
    const path = required('--manifest'),
      s = await lstat(path);
    if (!s.isFile() || s.size > 64 * 1024 * 1024) throw new Error('Invalid market manifest');
    const bytes = await readFile(path);
    if (bytes.length > 64 * 1024 * 1024) throw new Error('Market manifest limit');
    await publish(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    return;
  }
  const asset = options.get('--asset') ?? 'BTC',
    regime = options.get('--regime') ?? 'TREND',
    kind = options.get('--strategy') ?? 'MA_CROSSOVER';
  if (!['BTC', 'ETH', 'SOL'].includes(asset) || !['TREND', 'WHIPSAW', 'REVERSAL'].includes(regime))
    throw new Error('Unknown synthetic fixture');
  // The fixture builder validates the complete discriminated configuration before use.
  const cfg = marketBaselineFixture(
    asset as 'BTC' | 'ETH' | 'SOL',
    regime as 'TREND' | 'WHIPSAW' | 'REVERSAL',
    kind as MarketStrategyConfig['kind'],
  );
  await publish(cfg);
}
