import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { BtcDatasetSchema, BTC_PLAN_V2 } from '@crypto/contracts';
import { canonicalHash, decimal } from '@crypto/core';
import {
  runBtcTest,
  runBtcRevision,
  compareBtcStrategies,
  diagnoseBtcTrades,
  verifyBtcRevision,
  reconcileSpotJournal,
} from '@crypto/backtest';
import { D } from '../packages/backtest/src/spot-math.js';

/** Synthetic price regimes for temporal and execution failure checks; no real-market claims. */
function syntheticRegime(regime: 'UP' | 'DOWN' | 'QUIET' | 'MONOTONIC' = 'UP', count = 600) {
  const from = Date.UTC(2025, 0, 1),
    bars = Array.from({ length: count }, (_, i) => {
      const price =
          regime === 'QUIET'
            ? 100 + i * 0.001 + Math.sin(i / 12) * 0.02
            : regime === 'MONOTONIC'
              ? 100 + i * 0.1
              : 150 + i * (regime === 'UP' ? 0.1 : -0.05) + 8 * Math.sin(i / 12),
        spread = regime === 'QUIET' ? 0.001 : 0.8;
      return {
        at: from + i * 3600000,
        open: decimal(price.toFixed(4)),
        high: decimal((price + spread).toFixed(4)),
        low: decimal((price - spread).toFixed(4)),
        close: decimal(price.toFixed(4)),
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
      b.at + 3599999,
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
    to: from + count * 3600000,
    capturedAt: '2026-01-01T00:00:00.000Z',
    historicalAvailability: 'UNKNOWN',
    captures: [
      {
        url: 'https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1h',
        receivedAt: '2026-01-01T00:00:00.000Z',
        body,
        hash: `sha256:${createHash('sha256').update(body).digest('hex')}`,
      },
    ],
    bars,
  });
}
describe('versioned BTC revision and fair comparisons', () => {
  it('reproduces every original decision, fill, metric and journal without changing v1', () => {
    const d = syntheticRegime(),
      a = runBtcTest(d),
      b = runBtcRevision(d, 'ORIGINAL');
    expect(b.report.decisions).toEqual(a.report.decisions);
    expect(b.report.trades).toEqual(a.report.trades);
    expect(b.report.summary).toEqual(a.report.summary);
    expect(b.report.journalHash).toBe(a.report.journalHash);
    expect(runBtcTest(d).id).toBe(a.id);
    expect(b.id).not.toBe(a.id);
  });
  it('requires full trend context and a fresh crossover, then records passing gates', () => {
    const r = runBtcRevision(syntheticRegime()).report;
    expect(r.trades.length).toBeGreaterThan(0);
    expect(r.plan).toEqual(BTC_PLAN_V2);
    expect(r.decisions.slice(0, 223).every((d) => d.action === 'WARMUP')).toBe(true);
    for (const d of r.decisions.filter((d) => d.action === 'LONG')) {
      expect(d.entryGate).toBe('PASS');
      expect(d.trendRising).toBe(true);
      expect(new D(d.rewardCostRatio!).gte(3)).toBe(true);
      expect(d.index).toBeGreaterThanOrEqual(223);
    }
    expect(runBtcRevision(syntheticRegime('MONOTONIC')).report.trades).toHaveLength(0);
  });
  it('rejects bearish-regime and cost-dominated entries instead of inventing profitability', () => {
    const down = syntheticRegime('DOWN'),
      quiet = syntheticRegime('QUIET');
    expect(runBtcTest(down).report.trades.length).toBeGreaterThan(0);
    const a = runBtcRevision(down).report,
      b = runBtcRevision(quiet).report;
    expect(a.trades).toHaveLength(0);
    expect(a.decisions.some((d) => d.entryGate === 'TREND_BLOCK')).toBe(true);
    expect(b.trades).toHaveLength(0);
    expect(b.decisions.some((d) => d.entryGate === 'COST_BLOCK')).toBe(true);
    expect(b.summary.netPnl).toBe('0');
  });
  it('future data cannot alter earlier indicators, gate decisions or fills', () => {
    const data = syntheticRegime(),
      changed = {
        ...data,
        bars: data.bars.map((b, i) =>
          i >= 400
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
    const a = runBtcRevision(data).report,
      b = runBtcRevision(changed).report;
    expect(b.decisions.slice(0, 400)).toEqual(a.decisions.slice(0, 400));
    expect(b.trades.filter((t) => t.index < 400)).toEqual(a.trades.filter((t) => t.index < 400));
  });
  it('resets temporal-window balances, warms on past context and never trades outside the window', () => {
    const d = syntheticRegime(),
      r = runBtcRevision(d, 'FILTERED', { fromIndex: 300, toIndex: 500 }).report;
    expect(r.decisions).toHaveLength(500);
    expect(r.decisions.slice(0, 300).every((d) => d.cash === '10000' && d.btc === '0')).toBe(true);
    expect(r.trades.every((t) => t.index > 300 && t.index < 500)).toBe(true);
    expect(() => runBtcRevision(d, 'FILTERED', { fromIndex: 500, toIndex: 300 })).toThrow();
    expect(() => runBtcRevision(d, 'FILTERED', { fromIndex: 0, toIndex: 601 })).toThrow();
  });
  it('retains next-open execution, cost/risk caps and adverse-first protective exits', () => {
    const data = syntheticRegime(),
      first = runBtcRevision(data).report.trades.find((t) => t.side === 'BUY')!;
    const at = first.index + 1,
      changed = {
        ...data,
        bars: data.bars.map((b, i) =>
          i === at ? { ...b, high: decimal('1000'), low: decimal('1') } : b,
        ),
      };
    const r = runBtcRevision(changed),
      entryDecision = r.report.decisions[first.index - 1]!;
    expect(entryDecision.action).toBe('LONG');
    expect(first.at).toBe(entryDecision.at);
    expect(new D(first.price).mul(first.quantity).lte(new D(entryDecision.equity).mul('.1'))).toBe(
      true,
    );
    expect(r.report.trades.find((t) => t.side === 'SELL')!.reason).toContain('STOP');
    expect(() => reconcileSpotJournal(r.journal)).not.toThrow();
  });
  it('rejects a new opening-price gap that invalidates the cost filter and explains the rejection', () => {
    const data = syntheticRegime(),
      buy = runBtcRevision(data).report.trades.find((t) => t.side === 'BUY')!;
    const gap = {
      ...data,
      bars: data.bars.map((b, i) =>
        i === buy.index
          ? {
              ...b,
              open: decimal('1000'),
              high: decimal('1001'),
              low: decimal('999'),
              close: decimal('1000'),
            }
          : b,
      ),
    };
    const r = runBtcRevision(gap).report;
    expect(r.decisions[buy.index - 1]!.action).toBe('LONG');
    expect(r.trades.some((t) => t.side === 'BUY' && t.index === buy.index)).toBe(false);
    expect(r.decisions[buy.index]!.executionNote).toContain('reward-to-cost');
  });
  it('reconciles attribution and preserves the true candidate count and research interpretation', () => {
    const data = syntheticRegime(),
      comparison = compareBtcStrategies(data),
      r = comparison.original.report,
      a = diagnoseBtcTrades(r);
    expect(new D(a.closedNet).plus(a.openContribution).eq(r.summary.netPnl)).toBe(true);
    expect(new D(a.beforeFees).eq(new D(r.summary.netPnl).plus(r.summary.fees))).toBe(true);
    expect(a.groups.reduce((s, g) => s + g.count, 0)).toBe(r.summary.closedTrades);
    expect(comparison.comparison.candidateTrials).toBe(1);
    expect(comparison.comparison.originalReproduced).toBe(true);
    expect(comparison.comparison.interpretation).toContain('PREVIOUSLY_SEEN_HISTORY');
    expect(comparison.comparison.windows[1]!.fromIndex).toBe(400);
    expect(comparison.comparison.original.summary.buyHoldEquity).toBe(
      comparison.comparison.revised.summary.buyHoldEquity,
    );
    expect(canonicalHash(comparison.comparison)).toBe(comparison.id);
  });
  it('replays the revised version deterministically and rejects altered plans/results', () => {
    const data = syntheticRegime(),
      r = runBtcRevision(data);
    expect(verifyBtcRevision(r.report, data).id).toBe(r.id);
    expect(() =>
      verifyBtcRevision({ ...r.report, summary: { ...r.report.summary, netPnl: '999' } }, data),
    ).toThrow();
    expect(() =>
      verifyBtcRevision({ ...r.report, plan: { ...r.report.plan, feeRate: '0' } }, data),
    ).toThrow();
  });
});
