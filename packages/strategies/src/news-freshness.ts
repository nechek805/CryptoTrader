import { NewsFreshnessRequestSchema, NewsFreshnessSchema, utcNanoseconds } from '@crypto/contracts';
import { canonicalHash, deepFreeze, isAvailableAt } from '@crypto/core';
import { MarketEligibility } from './eligibility.js';
/** Operational veto only. No prices, returns, volatility or market model output escapes. */
export function deriveNewsFreshness(input: unknown) {
  const q = NewsFreshnessRequestSchema.parse(input),
    eligibility = new MarketEligibility(q.source),
    known = q.bars
      .filter(
        (b) =>
          b.instrumentId === q.source.series.instrumentId &&
          b.exchange === q.source.series.exchange &&
          b.marketType === q.source.series.marketType &&
          b.closeAt <= q.decisionAt &&
          isAvailableAt(b, q.decisionAt),
      )
      .sort((a, b) =>
        a.closeAt < b.closeAt
          ? 1
          : a.closeAt > b.closeAt
            ? -1
            : (a.availableAt ?? '') < (b.availableAt ?? '')
              ? 1
              : -1,
      ),
    bar = known[0] ?? null,
    metadata = bar ? eligibility.bar(bar, q.decisionAt) : null;
  const ids = new Set<string>(),
    versions = new Set<string>();
  for (const b of q.bars) {
    const key = `${b.exchange}|${b.instrumentId}|${b.marketType}|${b.interval.value}:${b.interval.unit}|${b.closeAt}|${b.availableAt}`;
    if (ids.has(b.id) || versions.has(key)) throw new Error('Ambiguous freshness evidence');
    ids.add(b.id);
    versions.add(key);
  }
  const body = {
    schemaVersion: 'news-freshness-veto.v1' as const,
    policy: 'VETO_ONLY_NO_DIRECTION_OR_PRICE_V1' as const,
    symbol: q.source.series.instrumentId,
    decisionAt: q.decisionAt,
    status:
      bar === null
        ? ('MISSING' as const)
        : metadata === null
          ? ('INELIGIBLE' as const)
          : utcNanoseconds(q.decisionAt) - utcNanoseconds(bar.closeAt) >
              BigInt(q.maximumAgeSeconds) * 1000000000n
            ? ('STALE' as const)
            : ('FRESH' as const),
    barId: bar?.id ?? null,
    closeAt: bar?.closeAt ?? null,
    availableAt:
      bar === null
        ? null
        : metadata?.availableAt && metadata.availableAt > bar.availableAt!
          ? metadata.availableAt
          : bar.availableAt,
    sourceIds: bar ? [...bar.provenance.sourceIds].sort() : [],
    metadataIds: metadata ? [metadata.id] : [],
  };
  const receipt = NewsFreshnessSchema.parse({ ...body, proofHash: canonicalHash(body) });
  deepFreeze(receipt);
  return receipt;
}
