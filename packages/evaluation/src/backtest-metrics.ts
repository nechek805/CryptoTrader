import { Decimal } from 'decimal.js';
import { PerformanceInputSchema, utcNanoseconds } from '@crypto/contracts';
import { canonicalHash, fromEpoch } from '@crypto/core';
import { validateBacktestReport } from '@crypto/backtest';
import type { StrategyFactory } from '@crypto/backtest';
import { measurePerformance, metricAmount } from './metrics.js';
const D = Decimal.clone({ precision: 256 });
/** Preserve the Module 08 FIFO lot accounting and exact verified simulation evidence. */
export function measureBacktestEvaluation(input: unknown, factory?: StrategyFactory) {
  const report = validateBacktestReport(input, factory);
  return report.cases.map((c) => ({
    caseId: c.id,
    outcomes: c.outcomes.map((o) => {
      const p = o.simulation.request,
        candidates = o.replay.candidates,
        orders = o.simulation.orders,
        admitted = orders.filter((o) => o.order.status !== 'REJECTED'),
        source = PerformanceInputSchema.parse({
          schemaVersion: 'performance-input.v1',
          portfolio: p.portfolios[0]!,
          sourceHash: canonicalHash(o),
          initialEquity: o.metrics.initialEquity,
          startAt: p.startAt,
          endAt: p.endAt,
          curve: o.equity.map((e) => {
            const bar = o.simulation.input.bars.find((b) => b.id === e.markBarId),
              open = new D(e.quantity).gt(0);
            return {
              at: e.at,
              equity: e.equity,
              exposureFraction: e.exposureFraction,
              positionOpen: open,
              validUntil: !open
                ? p.endAt
                : e.equity === null || !bar
                  ? null
                  : fromEpoch(
                      utcNanoseconds(bar.closeAt) + BigInt(report.manifest.maxMarkAgeMs) * 1000000n,
                      'nanoseconds',
                    ),
            };
          }),
          trades: o.trades.map((t) => ({
            id: t.id,
            symbol: report.manifest.series.instrumentId,
            openedAt: t.openedAt,
            closedAt: t.closedAt,
            netPnl: t.netPnl,
            grossPnl: t.grossPnl,
            fees: metricAmount(new D(t.entryFees).plus(t.exitFees)),
            regime: 'UNKNOWN',
            newsCategory: 'UNKNOWN',
            volatilityTier: 'UNKNOWN',
            evidenceIds: [t.buyFillId, t.sellFillId],
          })),
          fills: o.simulation.fills.map((f) => ({
            id: f.fill.id,
            at: f.fill.filledAt,
            notional: f.fill.notional,
            fee: f.fill.fee,
            slippageCost: metricAmount(
              new D(f.fill.price).minus(f.referencePrice).abs().mul(f.fill.quantity),
            ),
          })),
          acceptedOrders: admitted.length,
          filledOrders: admitted.filter((o) => new D(o.filledQuantity).gt(0)).length,
          rejectedSignals: orders.filter((o) => o.order.status === 'REJECTED').length,
          holds: candidates.filter((c) => c.side === 'HOLD').length,
          declaredOpportunities: o.replay.manifest.decisionCount,
          observedOpportunities: o.replay.manifest.decisionCount,
        });
      return {
        role: o.role,
        accounting: 'VERIFIED_FIFO_LOTS',
        metrics: measurePerformance(source),
      };
    }),
  }));
}
