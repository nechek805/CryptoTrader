import { describe, expect, it } from 'vitest';
import { PerformanceMetricsSchema } from '@crypto/contracts';
import {
  evaluationFixture,
  evaluationFixturePlan,
  evaluationSensitivity,
  evaluationUncertainty,
  measurePaper,
  measureBacktestEvaluation,
} from '@crypto/evaluation';
import { backtestFixture, runBacktest } from '@crypto/backtest';
import { canonicalHash } from '@crypto/core';

function dailyMetrics() {
  const f = evaluationFixture(),
    base = measurePaper(f.paper, f.plan.opportunityGrid);
  return base.map((m) =>
    PerformanceMetricsSchema.parse({
      ...m,
      closedTrades: 40,
      trades: Array.from({ length: 40 }, (_, i) => ({
        ...m.trades[0]!,
        id: `synthetic:statistic:${m.portfolio}:${i}`,
        symbol: 'BTC/USDT',
        openedAt: '2026-01-01T00:01:02Z',
        closedAt: '2026-01-01T00:03:01Z',
        netPnl: '1',
        grossPnl: '2',
        fees: '1',
        regime: 'TREND',
        newsCategory: 'UNKNOWN',
        volatilityTier: 'UNKNOWN',
        evidenceIds: ['synthetic:statistic'],
      })),
      daily: Array.from({ length: 30 }, (_, i) => ({
        day: `2026-01-${String(i + 1).padStart(2, '0')}`,
        startEquity: '10000',
        endEquity: '10000',
        netPnl: '0',
        netReturn:
          m.portfolio === 'BASELINE' || m.portfolio === 'MARKET_ONLY'
            ? '0'
            : String(((i % 5) - 1) / 1000),
        completeCalendarDay: true,
        sourceCoverage: 'COMPLETE',
      })),
    }),
  );
}
describe('Module 13 Iteration 2 uncertainty and bias checks', () => {
  it('warns insufficient evidence and one-tail-event dominance even with profitable metrics', () => {
    const f = evaluationFixture(),
      metrics = measurePaper(f.paper, f.plan.opportunityGrid),
      report = evaluationUncertainty(metrics, f.plan);
    expect(report.diagnostics.perArm.find((a) => a.portfolio === 'NEWS_ONLY')!.warnings).toEqual(
      expect.arrayContaining(['INSUFFICIENT_EVIDENCE', 'TAIL_EVENT_DOMINANCE']),
    );
    expect(report.pairedComparisons.every((p) => p.lower === null)).toBe(true);
  }, 60000);
  it('uses reproducible contiguous-day blocks and familywise intervals rather than independent shuffling', () => {
    const plan = evaluationFixturePlan(),
      metrics = dailyMetrics(),
      a = evaluationUncertainty(metrics, plan);
    expect(a.pairedComparisons[0]!.method).toBe('CIRCULAR_CONTIGUOUS_DAY_BLOCK_BOOTSTRAP');
    expect(a.pairedComparisons[0]!.blockCount).toBe(10);
    expect(a.pairedComparisons[0]!.status).toBe('CONDITIONAL_APPROXIMATION');
    expect(a.pairedComparisons[0]!.confidenceLevel).toBeCloseTo(1 - 0.05 / 3);
    expect(evaluationUncertainty(metrics, plan)).toEqual(a);
    expect(a.diagnostics.temporalSplits[0]!.embargoDays).toBe(3);
  }, 60000);
  it('rejects understated search families and blocks shorter than declared overlap', () => {
    const metrics = dailyMetrics(),
      p = evaluationFixturePlan();
    p.hyperparameterTrials = 100;
    expect(() => evaluationUncertainty(metrics, p)).toThrow(/family/);
    p.hyperparameterTrials = 1;
    p.overlapHorizonDays = 4;
    expect(() => evaluationUncertainty(metrics, p)).toThrow(/overlapping/);
  }, 60000);
  it('does not drop a missing day to manufacture a paired confidence interval', () => {
    const metrics = dailyMetrics(),
      p = evaluationFixturePlan();
    metrics.find((m) => m.portfolio === 'NEWS_ONLY')!.daily[5]!.netReturn = null;
    expect(evaluationUncertainty(metrics, p).pairedComparisons[0]!.status).toBe('MISSING_COVERAGE');
  }, 60000);
  it('replays predeclared costs/latency with identical candidates, new config hashes and retained outcomes', () => {
    const f = evaluationFixture(),
      result = evaluationSensitivity(f.paper, f.plan),
      hash = canonicalHash(f.paper.decisions.map((d) => d.request.risk.candidate));
    expect(result).toHaveLength(3);
    expect(result.every((r) => r.candidateSidesHash === hash)).toBe(true);
    expect(new Set(result.map((r) => r.configHash)).size).toBe(3);
    expect(
      result.find((r) => r.id === 'ENTRY_LAG')!.metrics.find((m) => m.portfolio === 'NEWS_ONLY')!
        .closedTrades,
    ).toBe(0);
  }, 60000);
  it('evaluates the verified Module 08 FIFO backtest without inventing paper observations', () => {
    const f = backtestFixture();
    f.scenarios = [];
    const r = runBacktest(f, 'synthetic:eval-test'),
      result = measureBacktestEvaluation(r);
    expect(result[0]!.outcomes[0]!.metrics.netPnl).toBe(r.cases[0]!.outcomes[0]!.metrics.netPnl);
    expect(result[0]!.outcomes[0]!.accounting).toBe('VERIFIED_FIFO_LOTS');
  }, 60000);
});
