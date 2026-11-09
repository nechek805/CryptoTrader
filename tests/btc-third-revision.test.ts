import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { BtcDatasetSchema, BTC_PLAN_V3 } from '@crypto/contracts';
import { canonicalHash, decimal } from '@crypto/core';
import {
  runBtcRevision,
  runBtcThirdRevision,
  verifyBtcThirdRevision,
  compareThreeBtcStrategies,
  reconcileSpotJournal,
} from '@crypto/backtest';
import { D } from '../packages/backtest/src/spot-math.js';

/** Synthetic prices for causal gate checks, never substituted for public BTC history. */
function syntheticHistory() {
  const from = Date.UTC(2025, 0, 1),
    bars = Array.from({ length: 600 }, (_, i) => {
      const p = 150 + i * 0.1 + 8 * Math.sin(i / 12);
      return {
        at: from + i * 3600000,
        open: decimal(p.toFixed(4)),
        high: decimal((p + 0.8).toFixed(4)),
        low: decimal((p - 0.8).toFixed(4)),
        close: decimal(p.toFixed(4)),
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
    to: from + 600 * 3600000,
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
describe('BTC v3 candle-quality revision', () => {
  it('preserves every v2 decision, fill, summary and journal in compatibility mode', () => {
    const data = syntheticHistory(),
      v2 = runBtcRevision(data),
      compat = runBtcThirdRevision(data, 'FILTERED');
    for (const key of ['decisions', 'trades', 'summary', 'journalHash'] as const)
      expect(compat.report[key]).toEqual(v2.report[key]);
    expect(runBtcRevision(data).id).toBe(v2.id);
  });
  it('admits midpoint closes and retains sizing, next-open fills and balanced accounting', () => {
    const r = runBtcThirdRevision(syntheticHistory()),
      first = r.report.trades.find((t) => t.side === 'BUY')!,
      decision = r.report.decisions[first.index - 1]!;
    expect(r.report.plan).toEqual(BTC_PLAN_V3);
    expect(r.report.origin).toBe('SYNTHETIC');
    expect(decision.action).toBe('LONG');
    expect(decision.closeLocation).toBe('0.5');
    expect(new D(decision.signalRangeAtr!).lte(2)).toBe(true);
    expect(first.at).toBe(decision.at);
    expect(new D(first.quantity).mul(first.price).lte(new D(decision.equity).mul('.1'))).toBe(true);
    expect(() => reconcileSpotJournal(r.journal)).not.toThrow();
  });
  it('rejects a weak completed close where v2 would enter', () => {
    const data = syntheticHistory(),
      i = runBtcRevision(data).report.decisions.find((d) => d.action === 'LONG')!.index;
    const weak = {
      ...data,
      bars: data.bars.map((b, j) =>
        j === i
          ? {
              ...b,
              low: decimal(new D(b.close).minus('.1').toFixed(4)),
              high: decimal(new D(b.close).plus('1.5').toFixed(4)),
            }
          : b,
      ),
    };
    expect(runBtcRevision(weak).report.decisions[i]!.action).toBe('LONG');
    const d = runBtcThirdRevision(weak).report.decisions[i]!;
    expect(d.entryGate).toBe('WEAK_CLOSE_BLOCK');
    expect(d.action).toBe('HOLD');
  });
  it('rejects shock and zero-range candles without dividing by zero', () => {
    const data = syntheticHistory(),
      i = runBtcRevision(data).report.decisions.find((d) => d.action === 'LONG')!.index;
    const shock = {
      ...data,
      bars: data.bars.map((b, j) =>
        j === i
          ? {
              ...b,
              low: decimal(new D(b.close).minus(5).toFixed(4)),
              high: decimal(new D(b.close).plus(5).toFixed(4)),
            }
          : b,
      ),
    };
    expect(runBtcThirdRevision(shock).report.decisions[i]!.entryGate).toBe('SHOCK_BLOCK');
    const flat = {
        ...data,
        bars: data.bars.map((b, j) => (j === i ? { ...b, high: b.close, low: b.close } : b)),
      },
      d = runBtcThirdRevision(flat).report.decisions[i]!;
    expect(d.closeLocation).toBeNull();
    expect(d.entryGate).toBe('WEAK_CLOSE_BLOCK');
  });
  it('later data cannot alter earlier features, gates, signals or fills', () => {
    const data = syntheticHistory(),
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
      },
      a = runBtcThirdRevision(data).report,
      b = runBtcThirdRevision(changed).report;
    expect(b.decisions.slice(0, 400)).toEqual(a.decisions.slice(0, 400));
    expect(b.trades.filter((t) => t.index < 400)).toEqual(a.trades.filter((t) => t.index < 400));
  });
  it('retains the opening-price cost gate and explains a rejected gap', () => {
    const data = syntheticHistory(),
      first = runBtcThirdRevision(data).report.trades.find((t) => t.side === 'BUY')!;
    const gap = {
        ...data,
        bars: data.bars.map((b, i) =>
          i === first.index
            ? {
                ...b,
                open: decimal('1000'),
                high: decimal('1001'),
                low: decimal('999'),
                close: decimal('1000'),
              }
            : b,
        ),
      },
      r = runBtcThirdRevision(gap).report;
    expect(r.trades.some((t) => t.side === 'BUY' && t.index === first.index)).toBe(false);
    expect(r.decisions[first.index]!.executionNote).toContain('reward-to-cost');
  });
  it('resets balances and bounds chronological-window trading', () => {
    const data = syntheticHistory(),
      r = runBtcThirdRevision(data, 'QUALITY', { fromIndex: 300, toIndex: 500 }).report;
    expect(r.decisions.slice(0, 300).every((d) => d.cash === '10000' && d.btc === '0')).toBe(true);
    expect(r.trades.every((t) => t.index > 300 && t.index < 500)).toBe(true);
    expect(() => runBtcThirdRevision(data, 'QUALITY', { fromIndex: 0, toIndex: 601 })).toThrow();
  });
  it('records cumulative trials, prior-version proof and same-fill cost sensitivity', () => {
    const r = compareThreeBtcStrategies(syntheticHistory()),
      c = r.comparison;
    expect(c.candidateTrials).toBe(2);
    expect(c.strategyCount).toBe(3);
    expect(c.newCandidateTrials).toBe(1);
    expect(c.previousComparisonId).toBe(r.previous.id);
    expect(c.v2Reproduced).toBe(true);
    expect(c.originalReproduced).toBe(true);
    expect(c.doubleCostSameFills!.third).toBe(
      new D(c.third.summary.netPnl)
        .minus(c.third.summary.fees)
        .minus(c.third.summary.slippage)
        .toFixed(),
    );
    expect(c.original.summary.buyHoldEquity).toBe(c.third.summary.buyHoldEquity);
    expect(c.windows).toHaveLength(2);
    expect(canonicalHash(c)).toBe(r.id);
    expect(c.interpretation).toContain('PREVIOUSLY_SEEN');
  });
  it('reproduces v3 and rejects altered plan constants or results', () => {
    const data = syntheticHistory(),
      r = runBtcThirdRevision(data);
    expect(verifyBtcThirdRevision(r.report, data).id).toBe(r.id);
    expect(() =>
      verifyBtcThirdRevision(
        { ...r.report, plan: { ...r.report.plan, minCloseLocation: '0.1' } },
        data,
      ),
    ).toThrow();
    expect(() =>
      verifyBtcThirdRevision(
        { ...r.report, summary: { ...r.report.summary, netPnl: '1000' } },
        data,
      ),
    ).toThrow();
  });
});
