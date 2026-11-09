import { canonicalHash } from '@crypto/core';
import { MARKET_ASSETS } from '../../contracts/src/market-tests.js';
import type { MarketAsset, MarketHistory } from '../../contracts/src/market-tests.js';
import { NewsResearchPlan, NewsResearchSnapshot } from '../../contracts/src/news-research.js';
import type {
  ResearchEvent,
  ResearchPlan,
  ResearchSnapshot,
} from '../../contracts/src/news-research.js';

export const NEWS_HOUR = 3600000;
export function shiftNewsMonth(at: number, months: number) {
  const d = new Date(at),
    day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  d.setUTCDate(
    Math.min(day, new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()),
  );
  return d.getTime();
}
export function newsResearchPlan(
  to = Math.floor(Date.now() / NEWS_HOUR) * NEWS_HOUR,
  viewed = false,
) {
  if (to % NEWS_HOUR || to > Date.now() || to < Date.UTC(2020, 0, 1))
    throw new Error('Invalid news research window');
  const from = shiftNewsMonth(to, -6);
  return NewsResearchPlan.parse({
    version: 'news-history-protocol.v1',
    from,
    trainEnd: shiftNewsMonth(from, 3),
    validationEnd: shiftNewsMonth(from, 4),
    to,
    initialUsdt: '10000',
    targetUsdt: '100',
    allocation: '0.2',
    feeRate: '0.001',
    slippage: '0.0005',
    shortBorrowHourly: '0.000003',
    latencyMs: 300000,
    stopFraction: '0.025',
    targetFraction: '0.05',
    candidatesPerAsset: 36,
    holdoutPreviouslyViewed: viewed,
  });
}
const aliases: Record<MarketAsset, RegExp> = {
  BTC: /\bbitcoin\b|\bBTC\b/i,
  ETH: /\bethereum\b|\bether\b|\bETH\b/i,
  SOL: /\b[Ss]olana\b|\$SOL\b|\bSOL\b/,
  TRX: /\btron\b|\bTRX\b/i,
  BNB: /\bbinance coin\b|\bBNB\b/i,
  XRP: /\bxrp\b|\bxrpl\b|\bripple\b/i,
  DOGE: /\bdogecoin\b|\bDOGE\b/i,
  ADA: /\b[Cc]ardano\b|\$ADA\b|\bADA\b/,
  LINK: /\b[Cc]hainlink\b|\$LINK\b|\bLINK\b/,
  AVAX: /\bavalanche\b|\bAVAX\b/i,
};
/** Deterministic frozen taxonomy. No current LLM outputs, price features or provider instructions. */
export function newsHistoryClassify(sourceId: string, text: string) {
  let group = 'OTHER',
    fixedSide: ResearchEvent['fixedSide'] = 'HOLD';
  if (sourceId === 'bls-cpi') group = 'INFLATION_RELEASE';
  else if (sourceId === 'bls-employment') group = 'EMPLOYMENT_RELEASE';
  else if (
    sourceId === 'federal-reserve' &&
    /fomc|federal funds|interest rate|monetary policy/i.test(text)
  ) {
    group = 'MONETARY_POLICY';
    if (/lower(?:s|ed|ing)?|reduc(?:e|es|ed|ing)/i.test(text)) {
      group += ':EASING';
      fixedSide = 'LONG';
    } else if (/rais(?:e|es|ed|ing)|increas(?:e|es|ed|ing)/i.test(text)) {
      group += ':TIGHTENING';
      fixedSide = 'SHORT';
    }
  } else if (/hack|exploit|vulnerabilit|security advisory|security incident|stolen/i.test(text)) {
    group = 'SECURITY';
    fixedSide = 'SHORT';
  } else if (/outage|disruption|degraded|unavailable|incident|interruption/i.test(text)) {
    group = 'SERVICE_INCIDENT';
    fixedSide = 'SHORT';
  } else if (
    /lawsuit|charges|enforcement|settlement|fraud|securities and exchange|sec approves|etf/i.test(
      text,
    )
  ) {
    group = 'REGULATORY';
    fixedSide = /approv|dismiss/i.test(text) ? 'LONG' : 'SHORT';
  } else if (
    /upgrade|release|mainnet|protocol|hard fork|fusaka|glamsterdam|pectra|dencun|merge/i.test(text)
  ) {
    group = 'PROTOCOL';
    fixedSide = 'LONG';
  } else if (/listing|listed|launch|adoption|partnership/i.test(text)) {
    group = 'ADOPTION';
    fixedSide = 'LONG';
  }
  const uncertain =
    /\brumou?r|unconfirmed|alleged|not confirmed|no evidence|did not|does not|not hacked|no (?:hack|exploit)|resolved|resolv(?:e|ed|ing)/i.test(
      text,
    );
  if (uncertain) {
    group += ':UNCERTAIN_OR_RESOLVED';
    fixedSide = 'HOLD';
  }
  const context =
    group.startsWith('MONETARY') || group === 'INFLATION_RELEASE' || group === 'EMPLOYMENT_RELEASE';
  const assets = context ? [...MARKET_ASSETS] : MARKET_ASSETS.filter((a) => aliases[a].test(text));
  if (!context && sourceId === 'ethereum-updates' && !assets.includes('ETH')) assets.push('ETH');
  if (!context && sourceId === 'helius-blog' && !assets.includes('SOL')) assets.push('SOL');
  if (!context && sourceId === 'xrpl-blog' && !assets.includes('XRP')) assets.push('XRP');
  return {
    group,
    fixedSide,
    assets,
    scope: context ? ('MARKET_CONTEXT' as const) : ('DIRECT' as const),
  };
}
export function prepareNewsHistory(snapshotInput: unknown, plan: ResearchPlan) {
  const snapshot = NewsResearchSnapshot.parse(snapshotInput),
    sources = new Map(snapshot.sources.map((s) => [s.id, s]));
  if (snapshot.total !== snapshot.versions.length)
    throw new Error('News export is truncated; refuse partial corpus');
  const events: ResearchEvent[] = [],
    seen = new Set<string>();
  const coverage = {
    collected: snapshot.versions.length,
    datedInWindow: 0,
    undated: 0,
    permissionExcluded: 0,
    irrelevant: 0,
    deduplicated: 0,
    eligibleHistoricalVersions: 0,
    earliestFirstSeen: snapshot.versions.length
      ? Math.min(...snapshot.versions.map((v) => v.firstSeenAt))
      : null,
    bySource: snapshot.sources.map((s) => ({
      id: s.id,
      name: s.name,
      total: 0,
      datedInWindow: 0,
      eligible: 0,
    })),
  };
  for (const v of [...snapshot.versions].sort(
    (a, b) => (a.publishedAt ?? Infinity) - (b.publishedAt ?? Infinity) || a.id.localeCompare(b.id),
  )) {
    const source = sources.get(v.sourceId),
      row = coverage.bySource.find((s) => s.id === v.sourceId);
    if (!source || !row) throw new Error('News source provenance is missing');
    row.total++;
    if (!source.collectionApproved || !source.aiAllowed || !v.aiAllowed) {
      coverage.permissionExcluded++;
      continue;
    }
    if (v.publishedAt === null || v.timestampStatus !== 'VALID') {
      coverage.undated++;
      continue;
    }
    if (v.publishedAt < plan.from || v.publishedAt >= plan.to) continue;
    coverage.datedInWindow++;
    row.datedInWindow++;
    const historical =
      Math.max(v.firstSeenAt, v.fetchedAt, v.availableAt) <= v.publishedAt + plan.latencyMs;
    if (historical) {
      coverage.eligibleHistoricalVersions++;
      row.eligible++;
    }
    const classification = newsHistoryClassify(v.sourceId, v.title + '\n' + v.excerpt);
    if (!classification.assets.length || classification.group.startsWith('OTHER')) {
      coverage.irrelevant++;
      continue;
    }
    // One issuer/category/asset announcement per six-hour block: updates are not new independent votes.
    const key = [
      v.independenceGroup,
      classification.group,
      classification.assets.join(','),
      Math.floor(v.publishedAt / (6 * NEWS_HOUR)),
    ].join('|');
    if (seen.has(key)) {
      coverage.deduplicated++;
      continue;
    }
    seen.add(key);
    events.push({
      id: canonicalHash({ versionId: v.id, key }),
      versionId: v.id,
      sourceId: v.sourceId,
      publisher: v.publisher,
      independenceGroup: v.independenceGroup,
      url: v.url,
      title: v.title,
      publishedAt: v.publishedAt,
      availableAt: Math.max(v.firstSeenAt, v.fetchedAt, v.availableAt),
      ...classification,
      timing: 'DESCRIPTIVE_PUBLICATION_PROXY',
    });
  }
  return { events, coverage, snapshot };
}
export function eventEntryIndex(event: ResearchEvent, history: MarketHistory, delayMs: number) {
  return Math.ceil((event.publishedAt + delayMs - history.from) / NEWS_HOUR);
}
export function newsHistorySamples(
  events: ResearchEvent[],
  history: MarketHistory,
  horizon: number,
  from: number,
  to: number,
  latency: number,
) {
  const rows: { event: ResearchEvent; value: number; excess: number; controls: number }[] = [],
    last = new Map<string, number>();
  for (const event of events.filter((e) => e.assets.includes(history.instrument.asset))) {
    const index = eventEntryIndex(event, history, latency),
      entry = history.bars[index],
      exit = history.bars[index + horizon - 1];
    if (
      !entry ||
      !exit ||
      entry.at < from ||
      exit.at + NEWS_HOUR > to ||
      entry.at < (last.get(event.group) ?? 0)
    )
      continue;
    const value = Number(exit.close) / Number(entry.open) - 1;
    const controls: number[] = [];
    for (const days of [-21, -14, -7, 7, 14, 21]) {
      const j = index + days * 24,
        a = history.bars[j],
        b = history.bars[j + horizon - 1];
      if (!a || !b || a.at < from || b.at + NEWS_HOUR > to) continue;
      if (
        events.some(
          (e) =>
            e.assets.includes(history.instrument.asset) &&
            Math.abs(e.publishedAt - a.at) < horizon * NEWS_HOUR,
        )
      )
        continue;
      controls.push(Number(b.close) / Number(a.open) - 1);
    }
    if (!controls.length) continue;
    last.set(event.group, exit.at + NEWS_HOUR);
    rows.push({
      event,
      value,
      excess: value - controls.reduce((a, b) => a + b, 0) / controls.length,
      controls: controls.length,
    });
  }
  return rows;
}
export function sampleStats(values: number[]) {
  const mean = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  const standardError =
    values.length > 1
      ? Math.sqrt(
          values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1) / values.length,
        )
      : 0;
  return { mean, standardError };
}
export function snapshotNewsResearch(
  storeSources: ResearchSnapshot['sources'],
  versions: ResearchSnapshot['versions'],
  total: number,
  at = Date.now(),
) {
  return NewsResearchSnapshot.parse({ capturedAt: at, total, sources: storeSources, versions });
}
