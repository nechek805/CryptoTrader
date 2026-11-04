import { Decimal } from 'decimal.js';
import { PerformanceInputSchema, utcNanoseconds } from '@crypto/contracts';
import type {
  EvaluationPlan,
  PerformanceInput,
  PerformanceMetrics,
  PaperReport,
} from '@crypto/contracts';
import { canonicalHash, fromEpoch } from '@crypto/core';
import { verifyPaperReport } from '@crypto/paper';
import { measurePerformance, metricAmount } from './metrics.js';
import { auditPaperMarket } from './market-audit.js';
const D = Decimal.clone({ precision: 256 });
export function paperPerformanceInputs(
  paperInput: unknown,
  grid: EvaluationPlan['opportunityGrid'],
): PerformanceInput[] {
  const r = verifyPaperReport(paperInput),
    paperHash = canonicalHash(r),
    quotes = new Map(
      r.log.filter((l) => l.event.kind === 'QUOTE').map((l) => [l.event.id, l.event]),
    );
  return (['BASELINE', 'NEWS_ONLY', 'MARKET_ONLY', 'FUSION'] as const).map((portfolio) => {
    const collapsed = new Map(
        r.equity.filter((e) => e.portfolio === portfolio).map((e) => [e.at, e]),
      ),
      orders = r.orders.filter((o) => o.order.portfolio === portfolio && o.parentOrderId === null),
      decisions = r.decisions.filter((d) => d.request.risk.candidate.portfolio === portfolio),
      fills = r.fills.filter((f) => f.fill.portfolio === portfolio),
      trades = orders.flatMap((o) => {
        if (new D(o.filledQuantity).isZero() || !new D(o.positionRemaining).isZero()) return [];
        const exits = fills.filter((f) => f.parentOrderId === o.order.id),
          entries = fills.filter((f) => f.fill.orderId === o.order.id),
          decision = decisions.find((d) => d.id === o.decisionId);
        if (!exits.length || !decision) return [];
        const net = exits.reduce((s, f) => s.plus(f.realizedNetPnl!), new D(0)),
          fees = [...entries, ...exits].reduce((s, f) => s.plus(f.fill.fee), new D(0));
        return [
          {
            id: o.order.id,
            symbol: o.order.symbol,
            openedAt: entries[0]!.fill.filledAt,
            closedAt: exits.at(-1)!.fill.filledAt,
            netPnl: metricAmount(net),
            grossPnl: metricAmount(net.plus(fees)),
            fees: metricAmount(fees),
            regime: decision.request.regime.kind,
            newsCategory: 'UNKNOWN',
            volatilityTier: 'UNKNOWN',
            evidenceIds: [...entries, ...exits].flatMap((f) => f.fill.evidenceIds),
          },
        ];
      }),
      curve = [...collapsed.values()].map((e) => {
        const positionOpen = e.holdingsValue === null || new D(e.holdingsValue).gt(0),
          expiries = e.sourceQuoteIds.flatMap((id) => {
            const q = quotes.get(id);
            return q && q.kind === 'QUOTE'
              ? [
                  fromEpoch(
                    utcNanoseconds(q.observedAt) +
                      BigInt(r.config.maxQuoteAgeSeconds) * 1000000000n,
                    'nanoseconds',
                  ),
                ]
              : [];
          });
        return {
          at: e.at,
          equity: e.equity,
          exposureFraction: e.exposureFraction,
          positionOpen,
          validUntil: !positionOpen ? r.config.endAt : (expiries.sort()[0] ?? null),
        };
      }),
      accepted = orders.filter((o) => o.order.status !== 'REJECTED'),
      observed = grid.filter((g) =>
        decisions.some(
          (d) =>
            d.request.risk.candidate.decisionAt === g.at &&
            d.request.risk.candidate.symbol === g.symbol,
        ),
      ).length;
    return PerformanceInputSchema.parse({
      schemaVersion: 'performance-input.v1',
      portfolio,
      sourceHash: paperHash,
      initialEquity: r.config.initialCash,
      startAt: r.config.startAt,
      endAt: r.now,
      curve,
      trades,
      fills: fills.map((f) => ({
        id: f.fill.id,
        at: f.fill.filledAt,
        notional: f.fill.notional,
        fee: f.fill.fee,
        slippageCost: f.slippageCost,
      })),
      acceptedOrders: accepted.length,
      filledOrders: accepted.filter((o) => new D(o.filledQuantity).gt(0)).length,
      rejectedSignals: orders.filter(
        (o) =>
          o.order.status === 'REJECTED' &&
          decisions.find((d) => d.id === o.decisionId)?.request.risk.candidate.side !== 'HOLD',
      ).length,
      holds: decisions.filter((d) => d.request.risk.candidate.side === 'HOLD').length,
      declaredOpportunities: grid.length,
      observedOpportunities: observed,
    });
  });
}
export function measurePaper(
  paperInput: unknown,
  grid: EvaluationPlan['opportunityGrid'],
): PerformanceMetrics[] {
  return paperPerformanceInputs(paperInput, grid).map(measurePerformance);
}
/** Passive quote-to-quote return on the same actual period; missing endpoint marks remain unknown. */
export function paperPassiveBenchmark(r: PaperReport) {
  return auditPaperMarket(r, 60).benchmarks;
}
