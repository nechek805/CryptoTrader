import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildEventStudyApp } from '@crypto/api';
import { verifyNewsEventSnapshot } from '@crypto/news';
import {
  eventStudyFixture,
  readMarketParquet,
  SnapshotEventStudy,
  verifyEventStudyArtifact,
  verifyMarketSnapshot,
  writeEventStudyArtifact,
} from '@crypto/research';
import { workingTreeVersion } from './database-fixtures.js';
import { eventControlsCommand } from './event-controls.js';
import { hypothesesCommand } from './hypotheses.js';

async function localJson(path: string) {
  const info = await lstat(path);
  if (!info.isFile() || info.size > 16384) throw new Error('Invalid request file');
  const bytes = await readFile(path);
  if (bytes.length > 16384) throw new Error('Request file limit');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
}
async function main(args: string[]) {
  if (args[0]?.startsWith('hypothesis')) {
    await hypothesesCommand(args);
    return;
  }
  if (args[0]?.startsWith('controls')) {
    await eventControlsCommand(args);
    return;
  }
  const command = args[0],
    options = new Map<string, string>(),
    allowed =
      command === 'fixture'
        ? ['--out']
        : command === 'run'
          ? ['--news-snapshot', '--market-snapshot', '--request', '--out']
          : command === 'serve'
            ? ['--artifact', '--port']
            : command === 'verify' || command === 'report'
              ? ['--artifact']
              : [];
  if (!['fixture', 'run', 'verify', 'report', 'serve'].includes(command ?? ''))
    throw new Error('Expected fixture, run, verify, report or serve');
  for (let i = 1; i < args.length; i += 2) {
    const key = args[i]!,
      value = args[i + 1];
    if (!allowed.includes(key) || options.has(key) || !value || value.startsWith('--'))
      throw new Error('Invalid option');
    options.set(key, value);
  }
  const required = (key: string) => {
    const value = options.get(key);
    if (!value) throw new Error('Required option missing');
    return value;
  };
  if (command === 'verify' || command === 'report' || command === 'serve') {
    const verified = await verifyEventStudyArtifact(required('--artifact'));
    if (command === 'serve') {
      const portText = options.get('--port') ?? '3010',
        port = Number(portText);
      if (!/^\d{1,5}$/.test(portText) || port < 1 || port > 65535) throw new Error('Invalid port');
      const app = buildEventStudyApp(new SnapshotEventStudy(verified.artifact.input));
      await app.listen({ host: '127.0.0.1', port });
      for (const signal of ['SIGINT', 'SIGTERM'] as const)
        process.once(signal, () => {
          void app.close();
        });
      process.stdout.write(
        `Event study API: http://127.0.0.1:${port}/research/event-study (execution DISABLED)\n`,
      );
    } else if (command === 'verify')
      process.stdout.write(`${JSON.stringify({ hash: verified.hash, valid: true })}\n`);
    else {
      const result = verified.artifact.result;
      process.stdout.write(
        `# Descriptive event study\n\nArtifact: ${verified.hash}\n\nUTC 24/7 exact closes; decimal fractions; no causal or execution claim.\nNet = gross minus ${result.request.roundTripCostBps} bps assumed round-trip cost; absolute = |gross|; adjusted = gross minus benchmark gross.\nBenchmark: ${result.request.benchmark.exchange}, ${result.request.benchmark.instrumentId}, ${result.request.benchmark.marketType}.\n\n`,
      );
      for (const event of result.events) {
        process.stdout.write(
          `Event ${event.event.identity.id}; frozen decision ${event.decisionAt}; confidence ${event.event.confidence.grade}.\n\n| Asset | Window | Status | Gross | Net | Absolute | Benchmark adjusted |\n| --- | --- | --- | --- | --- | --- | --- |\n`,
        );
        for (const response of event.responses)
          for (const w of response.windows)
            process.stdout.write(
              `| ${response.series.asset} | ${w.label} | ${w.status} | ${w.grossReturn ?? 'missing'} | ${w.netReturn ?? 'missing'} | ${w.absoluteReturn ?? 'missing'} | ${w.benchmarkAdjustedReturn ?? 'missing'} |\n`,
            );
        process.stdout.write(
          '\nOHLC excursions, close-only drawdown and unannualized sqrt(sum(log returns squared)):\n\n| Asset / source | Window | Adverse | Favorable | Volatility | Drawdown | Observed / expected bars |\n| --- | --- | --- | --- | --- | --- | --- |\n',
        );
        for (const response of event.responses)
          for (const w of response.windows)
            process.stdout.write(
              `| ${response.series.asset} / ${response.series.exchange} / ${response.series.instrumentId} / ${response.series.marketType} | ${w.label} | ${w.maxAdverseExcursion ?? 'missing'} | ${w.maxFavorableExcursion ?? 'missing'} | ${w.realizedVolatility ?? 'missing'} | ${w.maxDrawdown ?? 'missing'} | ${w.observedBars} / ${w.expectedBars} |\n`,
            );
        process.stdout.write(
          '\nExact timestamps and selected/excluded evidence IDs are retained in the artifact.\n\n',
        );
      }
    }
    return;
  }
  const fixture = command === 'fixture' ? await eventStudyFixture() : null;
  let input: unknown, request: unknown;
  if (fixture) ({ input, request } = fixture);
  else {
    const news = await verifyNewsEventSnapshot(required('--news-snapshot')),
      market = await verifyMarketSnapshot(required('--market-snapshot'));
    input = {
      schemaVersion: 'event-study-input.v1',
      newsSnapshot: news.artifact,
      marketSnapshots: [market.manifest],
      bars: (await readMarketParquet(join(market.directory, 'bars.parquet'))).map((r) => r.bar),
    };
    request = await localJson(required('--request'));
  }
  const result = await writeEventStudyArtifact(
    input,
    request,
    options.get('--out') ?? 'data/event-studies',
    await workingTreeVersion(),
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        path: result.path,
        hash: result.hash,
        execution: 'DISABLED',
        synthetic:
          result.artifact.input.bars.every((b) => b.provenance.origin === 'FIXTURE') &&
          result.artifact.input.newsSnapshot.input.graphRecords.every(
            (r) =>
              r.action.kind !== 'OBSERVE' ||
              r.action.extraction.input.article.version.document.provenance.origin === 'FIXTURE',
          ),
        events: result.artifact.result.events.length,
        completeWindows: result.artifact.result.events
          .flatMap((e) => e.responses)
          .flatMap((r) => r.windows)
          .filter((w) => w.status === 'COMPLETE').length,
      },
      null,
      2,
    )}\n`,
  );
}
main(process.argv.slice(2)).catch(() => {
  process.stderr.write(
    'Event study failed: invalid request, unavailable event, or incompatible local artifact.\n',
  );
  process.exitCode = 1;
});
