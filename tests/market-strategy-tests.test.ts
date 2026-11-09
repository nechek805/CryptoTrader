import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { MarketRowSchema, MarketInstrumentSchema } from '@crypto/contracts';
import { canonicalHash, canonicalJson, decimal } from '@crypto/core';
import {
  runMarketStrategy,
  runBtcTest,
  runBtcRevision,
  runBtcThirdRevision,
  verifyMarketReport,
  reconcileSpotJournal,
  diagnoseMarketTrades,
} from '@crypto/backtest';
import {
  verifyMarketHistory,
  marketInstrument,
  marketPublicGet,
  marketByteHash,
  saveMarketHistory,
  loadMarketHistory,
} from '@crypto/research';
import { D } from '../packages/backtest/src/spot-math.js';
import { marketHistoryFixture, legacyBtcFixture } from './helpers/market-history.js';
async function cleanup(root: string) {
  if (
    dirname(resolve(root)) !== resolve(tmpdir()) ||
    !root.split(/[\\/]/).at(-1)!.startsWith('market-strategies-')
  )
    throw new Error('Unsafe cleanup');
  await rm(root, { recursive: true, force: true });
}

describe('frozen strategies across explicit market instruments', () => {
  it.each(['V1', 'V2', 'V3'] as const)(
    'reproduces every legacy BTC %s decision, fill, summary and ledger',
    (strategy) => {
      const data = marketHistoryFixture(),
        result = runMarketStrategy(data, strategy, 'STANDARD'),
        old =
          strategy === 'V1'
            ? runBtcTest(legacyBtcFixture())
            : strategy === 'V2'
              ? runBtcRevision(legacyBtcFixture())
              : runBtcThirdRevision(legacyBtcFixture());
      expect(
        result.report.decisions.map(({ position, ...d }) => ({ ...d, btc: position })),
      ).toEqual(old.report.decisions);
      const { openBase, ...summary } = result.report.summary;
      expect({ ...summary, openBtc: openBase }).toEqual(old.report.summary);
      expect(result.report.trades).toEqual(old.report.trades);
      expect(result.journal).toEqual(old.journal);
      expect(verifyMarketReport(result.report, data).id).toBe(result.id);
    },
  );
  it.each(['V1', 'V2', 'V3'] as const)(
    'excludes all trading fees from %s execution, sizing, cost gates and benchmarks',
    (strategy) => {
      const data = marketHistoryFixture(),
        free = runMarketStrategy(data, strategy, 'ZERO'),
        standard = runMarketStrategy(data, strategy, 'STANDARD');
      expect(free.report.plan.feeMode).toBe('ZERO');
      expect(free.report.summary.fees).toBe('0');
      expect(free.report.trades.length).toBeGreaterThan(0);
      expect(free.report.trades.every((t) => t.fee === '0')).toBe(true);
      expect(new D(free.report.summary.slippage).gt(0)).toBe(true);
      expect(
        free.journal
          .flatMap((e) => e.postings)
          .filter((p) => p.account === 'FEES')
          .every((p) => new D(p.amount).isZero()),
      ).toBe(true);
      expect(new D(standard.report.summary.fees).gt(0)).toBe(true);
      expect(runMarketStrategy(data, strategy).id).toBe(standard.id);
      expect(free.report.summary.buyHoldEquity).not.toBe(standard.report.summary.buyHoldEquity);
      if (strategy !== 'V1') {
        const i = 300,
          price = new D(data.bars[i]!.close),
          atr = new D(free.report.decisions[i]!.atr!);
        expect(
          new D(free.report.decisions[i]!.rewardCostRatio!).eq(
            atr.mul(3).div(price.mul('0.0005').mul(2)).toDecimalPlaces(12),
          ),
        ).toBe(true);
      }
      expect(verifyMarketReport(free.report, data).id).toBe(free.id);
      expect(diagnoseMarketTrades(free.report).beforeFees).toBe(free.report.summary.netPnl);
    },
  );
  it.each(['ETH', 'SOL', 'TRX'] as const)(
    'uses %s units and its own tick/lot filters with balanced journals',
    (asset) => {
      const data = marketHistoryFixture(asset, asset === 'TRX' ? 0.002 : 1),
        result = runMarketStrategy(data, 'V1');
      expect(result.report.trades.length).toBeGreaterThan(0);
      for (const fill of result.report.trades) {
        expect(new D(fill.price).mod(data.instrument.filters.priceTick).isZero()).toBe(true);
        expect(new D(fill.quantity).mod(data.instrument.filters.quantityStep).isZero()).toBe(true);
      }
      expect(result.journal.flatMap((e) => e.postings).some((e) => e.asset === asset)).toBe(true);
      expect(result.journal.flatMap((e) => e.postings).some((e) => e.asset === 'BTC')).toBe(false);
      expect(() => reconcileSpotJournal(result.journal)).not.toThrow();
      const attribution = diagnoseMarketTrades(result.report);
      expect(
        new D(attribution.closedNet)
          .plus(attribution.openContribution)
          .eq(result.report.summary.netPnl),
      ).toBe(true);
    },
  );
  it('does not use future candles for earlier signals or fills', () => {
    const data = marketHistoryFixture('SOL'),
      changed = structuredClone(data);
    changed.bars = changed.bars.map((b, i) =>
      i < 400
        ? b
        : {
            ...b,
            open: decimal('500'),
            high: decimal('510'),
            low: decimal('490'),
            close: decimal('500'),
          },
    );
    const a = runMarketStrategy(data, 'V3'),
      b = runMarketStrategy(changed, 'V3');
    expect(b.report.decisions.slice(0, 400)).toEqual(a.report.decisions.slice(0, 400));
    expect(b.report.trades.filter((t) => t.index < 400)).toEqual(
      a.report.trades.filter((t) => t.index < 400),
    );
  });
  it('rejects altered reports on replay and gaps before any strategy runs', () => {
    const data = marketHistoryFixture('TRX', 0.002),
      result = runMarketStrategy(data, 'V2'),
      bad = structuredClone(result.report);
    bad.summary.netPnl = decimal('999');
    expect(() => verifyMarketReport(bad, data)).toThrow('replay mismatch');
    data.bars[2]!.at++;
    expect(() => runMarketStrategy(data, 'V1')).toThrow('Missing or duplicate');
  });
  it('does not report an incomplete or duplicated strategy set as a completed market', () => {
    const result = runMarketStrategy(marketHistoryFixture(), 'V1');
    const cell = {
      strategy: 'V1',
      reportId: result.id,
      summary: result.report.summary,
      attribution: diagnoseMarketTrades(result.report),
      exposureFraction: '0',
      gateCounts: {},
    };
    const row = {
      asset: 'BTC',
      datasetId: result.report.datasetId,
      status: 'COMPLETE',
      error: null,
      candles: 600,
      filters: marketHistoryFixture().instrument.filters,
      sources: [],
      cells: [cell, cell, cell],
      btcReferenceReproduced: true,
    };
    expect(MarketRowSchema.safeParse(row).success).toBe(false);
    expect(
      MarketRowSchema.safeParse({
        ...row,
        status: 'FAILED',
        error: 'Missing source',
        cells: [],
        btcReferenceReproduced: null,
      }).success,
    ).toBe(true);
    expect(
      MarketInstrumentSchema.safeParse({ ...marketHistoryFixture().instrument, symbol: 'ETHUSDT' })
        .success,
    ).toBe(false);
  });
});
describe('multi-market public provenance and immutable storage', () => {
  it('rejects wrong-symbol candles, changed metadata and mismatched raw prices', () => {
    const data = marketHistoryFixture('TRX', 0.002),
      wrong = structuredClone(data);
    wrong.captures[0]!.url = wrong.captures[0]!.url.replace('TRXUSDT', 'BTCUSDT');
    expect(() => verifyMarketHistory(wrong)).toThrow('provenance');
    const filter = structuredClone(data);
    filter.instrument.filters.quantityStep = decimal('0.00001');
    expect(() => verifyMarketHistory(filter)).toThrow('filters differ');
    const raw = structuredClone(data);
    raw.bars[0]!.volume = decimal('2');
    expect(() => verifyMarketHistory(raw)).toThrow('raw replay');
    expect(() => marketInstrument({ ...data.instrument.metadata, body: '{}' }, 'TRX')).toThrow(
      'provenance',
    );
  });
  it('rejects microsecond timestamps and historical availability invented from a download', () => {
    const data = marketHistoryFixture();
    data.bars[0]!.at *= 1000;
    expect(() => verifyMarketHistory(data)).toThrow();
    const future = marketHistoryFixture();
    future.captures[0]!.receivedAt = '2027-01-01T00:00:00.000Z';
    expect(() => verifyMarketHistory(future)).toThrow('provenance');
  });
  it('restricts public reads to fixed market endpoints and rejects provider failures', async () => {
    let calls = 0;
    const fetcher: typeof fetch = () => {
      calls++;
      return Promise.resolve(new Response('denied', { status: 451 }));
    };
    await expect(marketPublicGet('https://evil.test/api/v3/klines', fetcher)).rejects.toThrow(
      'URL rejected',
    );
    await expect(marketPublicGet('/api/v3/order', fetcher)).rejects.toThrow('URL rejected');
    expect(calls).toBe(0);
    await expect(marketPublicGet('/api/v3/exchangeInfo', fetcher)).rejects.toThrow('451');
    expect(calls).toBe(1);
  });
  it('round-trips asset-specific Parquet and catches changed Parquet despite a rewritten file checksum', async () => {
    const root = await mkdtemp(join(tmpdir(), 'market-strategies-'));
    try {
      const data = marketHistoryFixture('ETH'),
        saved = await saveMarketHistory(root, data);
      expect((await loadMarketHistory(root, saved.id)).dataset).toEqual(data);
      expect((await saveMarketHistory(root, data)).id).toBe(saved.id);
      const path = join(root, saved.id.slice(7), 'candles.parquet'),
        instance = await DuckDBInstance.create(':memory:', {
          threads: '1',
          autoload_known_extensions: 'false',
          autoinstall_known_extensions: 'false',
        }),
        connection = await instance.connect();
      try {
        await connection.run('CREATE TABLE altered AS SELECT * FROM read_parquet($path)', { path });
        await connection.run("UPDATE altered SET symbol='BTCUSDT'");
        await connection.run(
          `COPY altered TO '${path.replaceAll("'", "''")}' (FORMAT PARQUET, COMPRESSION UNCOMPRESSED)`,
        );
      } finally {
        connection.closeSync();
        instance.closeSync();
      }
      const sidecarPath = join(root, saved.id.slice(7), 'dataset.json'),
        sidecar = { dataset: data, parquetHash: marketByteHash(await readFile(path)) };
      await writeFile(sidecarPath, canonicalJson(sidecar));
      expect(canonicalHash(data)).toBe(saved.id);
      await expect(loadMarketHistory(root, saved.id)).rejects.toThrow();
    } finally {
      await cleanup(root);
    }
  });
});
