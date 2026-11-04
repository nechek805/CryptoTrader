import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { BTC_PLAN, BtcDatasetSchema } from '@crypto/contracts';
import { canonicalHash, decimal } from '@crypto/core';
import {
  runBtcTest,
  validateBtcHistory,
  verifyBtcReport,
  reconcileSpotJournal,
} from '@crypto/backtest';
import {
  decodeBtcBatch,
  downloadBtcHistory,
  sixMonthWindow,
  storeBtcDataset,
  loadBtcDataset,
  verifyBtcDataset,
} from '@crypto/research';
const HOUR = 3600000;
async function cleanTest(root: string) {
  const target = resolve(root);
  if (
    dirname(target) !== resolve(tmpdir()) ||
    !target.split(/[\\/]/).at(-1)!.startsWith('btc-test-')
  )
    throw new Error('Unsafe test cleanup');
  await rm(target, { recursive: true, force: true });
}
/** Deliberately synthetic OHLC test fixture; never substituted for public history. */
function syntheticHistory(count = 120) {
  const from = Date.UTC(2025, 0, 1),
    bars = Array.from({ length: count }, (_, i) => {
      const price = i < 55 ? 100 : 100 + (i - 54) * 0.5;
      return {
        at: from + i * HOUR,
        open: decimal(String(price)),
        high: decimal(String(price + 1)),
        low: decimal(String(price - 1)),
        close: decimal(String(price)),
        volume: decimal('1000'),
      };
    });
  const body = JSON.stringify(
    bars.map((b) => [
      b.at,
      b.open,
      b.high,
      b.low,
      b.close,
      b.volume,
      b.at + HOUR - 1,
      '100000',
      10,
      '500',
      '50000',
      '0',
    ]),
  );
  return BtcDatasetSchema.parse({
    version: 'btc-history.v1',
    origin: 'SYNTHETIC',
    symbol: 'BTCUSDT',
    interval: '1h',
    from,
    to: from + count * HOUR,
    capturedAt: '2026-01-01T00:00:00.000Z',
    historicalAvailability: 'UNKNOWN',
    bars,
    captures: [
      {
        url: `https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1h&startTime=${from}&endTime=${from + count * HOUR - 1}&limit=1000`,
        receivedAt: '2026-01-01T00:00:00.000Z',
        body,
        hash: `sha256:${createHash('sha256').update(body).digest('hex')}`,
      },
    ],
  });
}
describe('real-hourly BTC retrospective research', () => {
  it('uses six calendar months, clamps month ends and excludes unfinished hours', () => {
    expect(sixMonthWindow(Date.UTC(2026, 10, 3, 18, 59))).toEqual({
      from: Date.UTC(2026, 4, 3, 18),
      to: Date.UTC(2026, 10, 3, 18),
    });
    expect(sixMonthWindow(Date.UTC(2026, 7, 31, 10))).toEqual({
      from: Date.UTC(2026, 1, 28, 10),
      to: Date.UTC(2026, 7, 31, 10),
    });
  });
  it('rejects wrong timestamp units, malformed OHLC, duplicates, gaps and unfinished candles', () => {
    const d = syntheticHistory();
    expect(() => validateBtcHistory(d)).not.toThrow();
    const wrong = JSON.parse(d.captures[0]!.body) as unknown[][];
    wrong[0]![0] = 123;
    expect(() => decodeBtcBatch(JSON.stringify(wrong))).toThrow();
    expect(() => validateBtcHistory({ ...d, bars: d.bars.slice(1) })).toThrow();
    expect(() =>
      validateBtcHistory({
        ...d,
        bars: d.bars.map((b, i) => (i === 3 ? { ...b, at: b.at - HOUR } : b)),
      }),
    ).toThrow();
    expect(() =>
      validateBtcHistory({ ...d, capturedAt: new Date(d.to - HOUR).toISOString() }),
    ).toThrow();
    expect(() =>
      validateBtcHistory({
        ...d,
        bars: d.bars.map((b, i) => (i === 3 ? { ...b, low: '10000' } : b)),
      }),
    ).toThrow();
  });
  it('keeps actual receipt provenance UNKNOWN and detects raw-body or normalized-price tampering', () => {
    const d = syntheticHistory();
    expect(verifyBtcDataset(d).historicalAvailability).toBe('UNKNOWN');
    expect(() =>
      verifyBtcDataset({ ...d, captures: d.captures.map((c) => ({ ...c, body: c.body + ' ' })) }),
    ).toThrow();
    expect(() =>
      verifyBtcDataset({
        ...d,
        bars: d.bars.map((b, i) => (i === 2 ? { ...b, close: '100.5' } : b)),
      }),
    ).toThrow();
    expect(() =>
      verifyBtcDataset({
        ...d,
        captures: d.captures.map((c) => ({ ...c, url: 'http://127.0.0.1/private' })),
      }),
    ).toThrow();
  });
  it('decides only after a completed candle, fills next open, sizes within caps and never opens shorts', () => {
    const d = syntheticHistory(),
      { report, journal } = runBtcTest(d),
      first = report.trades[0]!;
    const decision = report.decisions.find((x) => x.action === 'LONG')!;
    expect(first.index).toBe(decision.index + 1);
    expect(first.at).toBe(decision.at);
    expect(Number(first.price)).toBeGreaterThan(Number(d.bars[first.index]!.open));
    expect(Number(first.quantity) * Number(first.price)).toBeLessThanOrEqual(1000);
    expect(
      Number(first.quantity) *
        (Number(first.price) - Number(first.stop) + Number(first.price) * 0.003),
    ).toBeLessThanOrEqual(25.01);
    expect(report.decisions.slice(0, 49).every((d) => d.action === 'WARMUP')).toBe(true);
    expect(report.decisions.every((d) => Number(d.btc) >= 0 && Number(d.cash) >= 0)).toBe(true);
    expect(report.origin).toBe('SYNTHETIC');
    expect(report.plan).toEqual(BTC_PLAN);
    expect(canonicalHash(journal)).toBe(report.journalHash);
    expect(() => reconcileSpotJournal(journal)).not.toThrow();
  });
  it('future candle changes cannot change any earlier decision or fill', () => {
    const d = syntheticHistory(160),
      altered = {
        ...d,
        bars: d.bars.map((b, i) =>
          i >= 100
            ? {
                ...b,
                open: decimal('500'),
                high: decimal('501'),
                low: decimal('499'),
                close: decimal('500'),
              }
            : b,
        ),
      };
    const a = runBtcTest(d).report,
      b = runBtcTest(altered).report;
    expect(b.decisions.slice(0, 100)).toEqual(a.decisions.slice(0, 100));
    expect(b.trades.filter((t) => t.index < 100)).toEqual(a.trades.filter((t) => t.index < 100));
  });
  it('takes the stop first for ambiguous bars and handles downward gaps adversely', () => {
    const d = syntheticHistory(),
      first = runBtcTest(d).report.trades[0]!,
      at = first.index + 1;
    const both = {
      ...d,
      bars: d.bars.map((b, i) =>
        i === at ? { ...b, high: decimal('200'), low: decimal('50') } : b,
      ),
    };
    const exit = runBtcTest(both).report.trades.find((t) => t.side === 'SELL')!;
    expect(exit.index).toBe(at);
    expect(exit.reason).toContain('STOP');
    expect(Number(exit.price)).toBeLessThan(Number(first.stop));
    const gap = {
      ...d,
      bars: d.bars.map((b, i) =>
        i === at
          ? {
              ...b,
              open: decimal('50'),
              high: decimal('51'),
              low: decimal('49'),
              close: decimal('50'),
            }
          : b,
      ),
    };
    expect(
      Number(runBtcTest(gap).report.trades.find((t) => t.side === 'SELL')!.price),
    ).toBeLessThan(50);
  });
  it('never fills a last-candle order and refuses tiny illiquid entries', () => {
    const d = syntheticHistory(100),
      flat = d.bars.map((b) => ({
        ...b,
        open: decimal('100'),
        high: decimal('101'),
        low: decimal('99'),
        close: decimal('100'),
      }));
    flat[99] = { ...flat[99]!, high: decimal('102'), close: decimal('102') };
    const r = runBtcTest({ ...d, bars: flat }).report;
    expect(r.decisions[99]!.action).toBe('LONG');
    expect(r.trades).toHaveLength(0);
    expect(r.decisions[99]!.reason).toContain('No following candle');
    expect(
      runBtcTest({ ...d, bars: d.bars.map((b) => ({ ...b, volume: decimal('0.00001') })) }).report
        .trades,
    ).toHaveLength(0);
  });
  it('accounts costs, returns and drawdown reproducibly without changing frozen reports', () => {
    const d = syntheticHistory(),
      a = runBtcTest(d),
      b = runBtcTest(d);
    expect(a.id).toBe(b.id);
    expect(a.report.engineHash).toMatch(/^sha256:/);
    expect(Number(a.report.summary.fees)).toBeGreaterThan(0);
    expect(verifyBtcReport(a.report, d).id).toBe(a.id);
    expect(() =>
      verifyBtcReport({ ...a.report, summary: { ...a.report.summary, finalEquity: '999999' } }, d),
    ).toThrow();
    expect(a.report.interpretation).toBe('RETROSPECTIVE_ASSUMPTIONS_NOT_FORWARD_VERIFIED');
  });
  it('round-trips immutable exact-decimal Parquet and fails on file corruption', async () => {
    const root = await mkdtemp(join(tmpdir(), 'btc-test-'));
    try {
      const a = await storeBtcDataset(root, syntheticHistory());
      expect((await loadBtcDataset(root, a.id)).dataset).toEqual(a.dataset);
      expect((await storeBtcDataset(root, syntheticHistory())).id).toBe(a.id);
      const path = join(root, a.id.slice(7), 'candles.parquet'),
        bytes = await readFile(path);
      bytes[10] = bytes[10]! ^ 1;
      await writeFile(path, bytes);
      await expect(loadBtcDataset(root, a.id)).rejects.toThrow('integrity');
    } finally {
      await cleanTest(root);
    }
  });
  it('fails closed for provider errors and clock mismatch without substituting synthetic data', async () => {
    const failed = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('blocked', { status: 451 }));
    await expect(downloadBtcHistory(() => {}, failed)).rejects.toThrow('451');
    expect(failed).toHaveBeenCalledTimes(1);
    const skew = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ serverTime: Date.now() - 600000 })));
    await expect(downloadBtcHistory(() => {}, skew)).rejects.toThrow('clocks disagree');
  });
});
