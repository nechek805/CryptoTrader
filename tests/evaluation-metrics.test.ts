import { describe, expect, it } from 'vitest';
import { PerformanceInputSchema } from '@crypto/contracts';
import { canonicalHash, fromEpoch } from '@crypto/core';
import { measurePerformance, measurePaper, formatEvaluationMetric } from '@crypto/evaluation';
import { paperSoakFixture, replayPaper } from '@crypto/paper';
const at = (s: number) => fromEpoch(1767225600n + BigInt(s), 'seconds');
function fixture() {
  return PerformanceInputSchema.parse({
    schemaVersion: 'performance-input.v1',
    portfolio: 'NEWS_ONLY',
    sourceHash: canonicalHash('synthetic:hand-calculated'),
    initialEquity: '1000',
    startAt: at(0),
    endAt: at(100),
    curve: [
      {
        at: at(0),
        equity: '1000',
        exposureFraction: '0',
        positionOpen: false,
        validUntil: at(100),
      },
      {
        at: at(10),
        equity: '1000',
        exposureFraction: '0.1',
        positionOpen: true,
        validUntil: at(100),
      },
      {
        at: at(100),
        equity: '1010',
        exposureFraction: '0',
        positionOpen: false,
        validUntil: at(100),
      },
    ],
    trades: [
      {
        id: 'synthetic:win',
        symbol: 'BTC/USDT',
        openedAt: at(10),
        closedAt: at(100),
        netPnl: '10',
        grossPnl: '12',
        fees: '2',
        regime: 'RANGE',
        newsCategory: 'UNKNOWN',
        volatilityTier: 'UNKNOWN',
        evidenceIds: ['synthetic:fill'],
      },
    ],
    fills: [{ id: 'synthetic:fill', at: at(100), notional: '100', fee: '2', slippageCost: '1' }],
    acceptedOrders: 1,
    filledOrders: 1,
    rejectedSignals: 0,
    holds: 0,
    declaredOpportunities: 1,
    observedOpportunities: 1,
  });
}
describe('Module 13 Iteration 1 reproducible metrics', () => {
  it('matches hand calculations with nonuniform timestamps and no infinite ratios', () => {
    const r = measurePerformance(fixture());
    expect(r.netPnl).toBe('10');
    expect(r.netReturn).toBe('0.01');
    expect(r.grossPnlBeforeFees).toBe('12');
    expect(r.fees).toBe('2');
    expect(r.profitFactor).toBeNull();
    expect(formatEvaluationMetric(r.profitFactor)).toBe('N/A');
    expect(r.recoveryFactor).toBeNull();
    expect(r.winRate).toBe('1');
    expect(r.timeInMarketFraction).toBe('0.9');
    expect(r.timeWeightedExposure).toBe('0.09');
    expect(r.dailyReturnVolatility).toBeNull();
    expect(JSON.stringify(r)).not.toContain('Infinity');
  });
  it('handles zero trades and zero activity safely', () => {
    const f = fixture();
    f.trades = [];
    f.fills = [];
    f.acceptedOrders = 0;
    f.filledOrders = 0;
    f.curve = [f.curve[0]!, { ...f.curve[0]!, at: at(100) }];
    const r = measurePerformance(f);
    expect(r.netPnl).toBe('0');
    expect(r.closedTrades).toBe(0);
    expect(r.winRate).toBeNull();
    expect(r.expectancyAfterFees).toBeNull();
    expect(r.fillRate).toBeNull();
    expect(r.timeInMarketFraction).toBe('0');
  });
  it('rejects a negative equity attempt and duplicate timestamps', () => {
    const f = fixture();
    f.curve[2]!.equity = '-1' as never;
    expect(() => measurePerformance(f)).toThrow();
    f.curve[2]!.equity = '1010' as never;
    f.curve[1]!.at = at(0);
    expect(() => measurePerformance(f)).toThrow(/clocks/);
  });
  it('does not interpolate unobserved stale holdings or present a complete drawdown', () => {
    const f = fixture();
    f.curve[1]!.validUntil = at(20);
    const r = measurePerformance(f);
    expect(r.netReturn).toBe('0.01');
    expect(r.maxDrawdown).toBeNull();
    expect(r.timeWeightedExposure).toBeNull();
    expect(r.knownValuationFraction).toBe('0.2');
    expect(r.daily[0]!.sourceCoverage).toBe('MISSING_OR_STALE');
  });
  it('reconciles each paper arm to final cash plus holdings and retains losses', () => {
    const f = paperSoakFixture(),
      paper = replayPaper(f.config, f.events),
      metrics = measurePaper(paper, [{ at: at(61), symbol: 'BTC/USDT' }]);
    expect(metrics.find((m) => m.portfolio === 'BASELINE')!.netPnl).toBe('0');
    for (const m of metrics.filter((m) => m.portfolio !== 'BASELINE')) {
      expect(m.netPnl).toBe('-61.09693233');
      expect(m.closedTrades).toBe(1);
      expect(m.profitFactor).toBe('0');
      expect(m.maxDrawdown).toBeNull();
      expect(m.trades[0]!.netPnl).toBe(m.netPnl);
    }
  }, 60000);
});
