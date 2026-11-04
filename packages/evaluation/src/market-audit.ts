import type { PaperReport, PaperQuote } from '@crypto/contracts';
import { PaperReportSchema, utcNanoseconds } from '@crypto/contracts';
import { PaperBroker } from '@crypto/paper';
import { metricAmount } from './metrics.js';
import { Decimal } from 'decimal.js';
const D = Decimal.clone({ precision: 256 });
/** Reconstruct accepted source state; rejected/crossed/skewed/legally invalid quotes never become benchmarks. */
export function auditPaperMarket(r: PaperReport, cadenceSeconds: number) {
  r = PaperReportSchema.parse(r);
  if (!Number.isInteger(cadenceSeconds) || cadenceSeconds < 1 || cadenceSeconds > 3600)
    throw new Error('Invalid audit cadence');
  const broker = new PaperBroker(r.config),
    timeline: { at: bigint; quotes: (PaperQuote | null)[]; news: boolean; newsUntil: bigint }[] =
      [],
    news = new Map<string, { at: bigint; healthy: boolean }>();
  let manualNews = true,
    first: PaperQuote | null = null,
    fatalNews = false;
  for (const { event: e } of r.log) {
    broker.consume(e);
    if (e.kind === 'HEARTBEAT') {
      const s = r.config.newsSources.find((s) => s.id === e.sourceId);
      news.set(e.sourceId, {
        at: utcNanoseconds(e.observedAt ?? e.at),
        healthy: !!s && s.licenseReviewHash === e.licenseReviewHash && e.healthy,
      });
    }
    if (e.kind === 'SAFETY') {
      if (e.code === 'NEWS_OUTAGE') manualNews = false;
      if (e.code === 'NEWS_RESTORED') manualNews = true;
      if (['LICENSE_CHANGED', 'SOURCE_VALIDATION_FAILED', 'INVALID_METADATA'].includes(e.code))
        fatalNews = true;
    }
    const quotes = r.config.instruments.map((i) => broker.quoteAt(i.symbol));
    if (!first && quotes[0]) first = quotes[0];
    const newsUntil = r.config.newsSources.reduce((last, s) => {
      const h = news.get(s.id),
        expiry = h ? h.at + BigInt(s.heartbeatTtlSeconds) * 1000000000n : 0n;
      return expiry < last ? expiry : last;
    }, utcNanoseconds(r.config.endAt));
    timeline.push({
      at: utcNanoseconds(e.at),
      quotes,
      newsUntil,
      news:
        manualNews &&
        !fatalNews &&
        r.config.newsSources.every((s) => {
          const h = news.get(s.id);
          return (
            h?.healthy && utcNanoseconds(e.at) - h.at <= BigInt(s.heartbeatTtlSeconds) * 1000000000n
          );
        }),
    });
  }
  let expected = 0,
    marketKnown = 0,
    newsKnown = 0,
    cursor = -1;
  const stride = BigInt(cadenceSeconds) * 1000000000n;
  for (let at = utcNanoseconds(r.config.startAt); at < utcNanoseconds(r.now); at += stride) {
    if (++expected > 1000000) throw new Error('Evaluation market calendar budget');
    while (cursor + 1 < timeline.length && timeline[cursor + 1]!.at <= at) cursor++;
    const state = timeline[cursor];
    if (
      state &&
      state.quotes.every(
        (q) =>
          q &&
          at - utcNanoseconds(q.observedAt) <= BigInt(r.config.maxQuoteAgeSeconds) * 1000000000n,
      )
    )
      marketKnown++;
    if (state?.news && at <= state.newsUntil && r.config.newsSources.length) newsKnown++;
  }
  const last = broker.quoteAt(r.config.instruments[0]!.symbol),
    valid = r.config.instruments.length === 1 && first !== null && last !== null,
    cost = first
      ? new D(first.ask)
          .mul(new D(1).plus(new D(r.config.slippageBps).div(10000)))
          .mul(new D(1).plus(r.config.takerRate))
      : null,
    proceeds = last
      ? new D(last.bid)
          .mul(new D(1).minus(new D(r.config.slippageBps).div(10000)))
          .mul(new D(1).minus(r.config.takerRate))
      : null;
  return {
    expected,
    marketKnown,
    newsKnown,
    marketCoverage: expected ? metricAmount(new D(marketKnown).div(expected)) : null,
    newsCoverage:
      expected && r.config.newsSources.length ? metricAmount(new D(newsKnown).div(expected)) : null,
    benchmarks: {
      cashNetReturn: '0' as const,
      buyAndHoldNetReturn:
        valid && cost && proceeds ? metricAmount(proceeds.div(cost).minus(1)) : null,
      policy: 'FIRST_COMMON_QUOTE_TO_FINAL_VALID_MARK_WITH_FROZEN_COSTS' as const,
      reason: valid
        ? 'Fractional passive quote comparator with frozen spread/slippage/fees; not lot fills'
        : 'Missing, stale, invalid or legally ineligible common endpoint',
    },
  };
}
