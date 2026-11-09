import { Decimal } from 'decimal.js';
import { canonicalHash } from '@crypto/core';
import { MARKET_ASSETS } from '../../contracts/src/market-tests.js';
import { NewsV4Event } from '../../contracts/src/news-research-v4.js';
import type { V4Event } from '../../contracts/src/news-research-v4.js';
import type {
  ResearchSnapshot,
  ResearchPlan,
  ResearchEvent,
} from '../../contracts/src/news-research.js';
import type { LiveNewsVersion } from '../../contracts/src/live-news.js';
import { newsHistoryClassify } from './news-history-study.js';
import { structureNewsV3 } from './news-events-v3.js';
import { exchangeHeadlineSymbols } from '../../connectors/src/free-news-sources.js';

export const historicalSourceRole = (source: string) =>
  ({
    'bls-cpi-history': 'bls-cpi',
    'bls-employment-history': 'bls-employment',
    'fed-statements-history': 'federal-reserve',
    'sec-crypto-history': 'sec',
  })[source] ?? source;
/** Numeric facts only; lagged-release comparisons below are explicitly not market consensus. */
export function v4MacroActual(v: Pick<LiveNewsVersion, 'sourceId' | 'title' | 'excerpt'>) {
  const role = historicalSourceRole(v.sourceId),
    text = v.title + ' ' + v.excerpt;
  let metric: 'CPI_MOM' | 'PAYROLL_CHANGE' | 'FED_TARGET_UPPER',
    actual: string | null = null;
  try {
    if (role === 'bls-cpi') {
      metric = 'CPI_MOM';
      const m =
        /(?:CPI for all items|Consumer Price Index for All Urban Consumers\s*\(CPI-U\))\s+(increases|decreases|rises|falls|increased|decreased|rose|fell)\s+(\d+(?:\.\d+)?)\s*(?:%|percent)/i.exec(
          text,
        );
      if (m)
        actual = new Decimal(m[2]!)
          .mul(/decreases|falls|decreased|fell/i.test(m[1]!) ? -1 : 1)
          .toFixed();
      else if (/CPI-U\)\s+was unchanged/i.test(text)) actual = '0';
    } else if (role === 'bls-employment') {
      metric = 'PAYROLL_CHANGE';
      const m =
        /payroll employment\s*\(([+-]?\d[\d,]*)\)|payroll employment\s+(rises|falls|increases|decreases|increased|decreased|rose|fell)(?: by)?\s+([+-]?\d[\d,]*)/i.exec(
          text,
        );
      if (m)
        actual = new Decimal((m[1] ?? m[3]!).replaceAll(',', ''))
          .mul(m[2] && /falls|decreases|decreased|fell/i.test(m[2]) ? -1 : 1)
          .toFixed();
    } else {
      metric = 'FED_TARGET_UPPER';
      const m =
        /target range[^.!?]{0,120}?\bto\s+(\d+(?:\.\d+)?)(?:\s*[- ]\s*(\d)\s*\/\s*(\d))?\s+percent/i.exec(
          text,
        );
      if (m)
        actual = new Decimal(m[1]!).plus(m[2] && m[3] ? new Decimal(m[2]).div(m[3]) : 0).toFixed();
    }
  } catch {
    return {
      metric:
        role === 'bls-cpi'
          ? ('CPI_MOM' as const)
          : role === 'bls-employment'
            ? ('PAYROLL_CHANGE' as const)
            : ('FED_TARGET_UPPER' as const),
      actual: null,
    };
  }
  return { metric, actual };
}
export function legacyHistoryEvents(
  snapshot: ResearchSnapshot,
  plan: ResearchPlan,
): ResearchEvent[] {
  const sources = new Map(snapshot.sources.map((s) => [s.id, s])),
    seen = new Set<string>(),
    events: ResearchEvent[] = [];
  for (const v of [...snapshot.versions].sort(
    (a, b) => (a.publishedAt ?? Infinity) - (b.publishedAt ?? Infinity) || a.id.localeCompare(b.id),
  )) {
    const source = sources.get(v.sourceId);
    if (
      !source?.collectionApproved ||
      !source.aiAllowed ||
      !v.aiAllowed ||
      v.publishedAt === null ||
      v.timestampStatus !== 'VALID' ||
      v.publishedAt < plan.from ||
      v.publishedAt >= plan.to
    )
      continue;
    const c = newsHistoryClassify(historicalSourceRole(v.sourceId), v.title + ' ' + v.excerpt);
    if (!c.assets.length || c.group === 'OTHER') continue;
    const key = [
      v.independenceGroup,
      c.group,
      c.assets.join(','),
      Math.floor(v.publishedAt / 21600000),
    ].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    events.push({
      id: canonicalHash({ v: v.id, group: c.group }),
      versionId: v.id,
      sourceId: v.sourceId,
      publisher: v.publisher,
      independenceGroup: v.independenceGroup,
      title: v.title,
      url: v.url,
      publishedAt: v.publishedAt,
      availableAt: v.availableAt,
      ...c,
      timing: 'DESCRIPTIVE_PUBLICATION_PROXY',
    });
  }
  return events;
}
export function legacyV3Events(snapshot: ResearchSnapshot, plan: ResearchPlan) {
  const seen = new Set<string>();
  return snapshot.versions
    .map((v) => {
      const source = snapshot.sources.find((s) => s.id === v.sourceId)!;
      const role = historicalSourceRole(v.sourceId);
      // Source-role normalization only: permissions, article identity and real source attribution are preserved.
      const e = structureNewsV3(
        {
          capturedAt: snapshot.capturedAt,
          total: 1,
          sources: [{ ...source, id: role }],
          versions: [{ ...v, sourceId: role }],
        },
        plan,
      )[0]!;
      return { ...e, sourceId: v.sourceId };
    })
    .sort(
      (a, b) =>
        (a.publishedAt ?? Infinity) - (b.publishedAt ?? Infinity) ||
        a.versionId.localeCompare(b.versionId),
    )
    .map((e) => {
      if (e.gate !== 'ELIGIBLE_FOR_DESCRIPTIVE_ESTIMATION') return e;
      const key = [
        e.independenceGroup,
        e.group,
        e.assets.join(','),
        Math.floor(e.publishedAt! / 21600000),
      ].join('|');
      if (seen.has(key)) return { ...e, gate: 'HOLD_DUPLICATE' as const };
      seen.add(key);
      return e;
    });
}
export function structureNewsV4(snapshot: ResearchSnapshot, plan: ResearchPlan): V4Event[] {
  const sources = new Map(snapshot.sources.map((s) => [s.id, s])),
    seen = new Set<string>();
  const numericHistory = new Map<string, { id: V4Event['id']; at: number; actual: string }[]>();
  // Original government-release captures take precedence over duplicated RSS summaries on a release day.
  const sorted = [...snapshot.versions].sort(
    (a, b) =>
      (a.publishedAt ?? Infinity) - (b.publishedAt ?? Infinity) ||
      Number(b.sourceId.endsWith('-history')) - Number(a.sourceId.endsWith('-history')) ||
      a.id.localeCompare(b.id),
  );
  return sorted.map((v) => {
    const source = sources.get(v.sourceId)!;
    if (!source) throw new Error('V4 source provenance missing');
    const text = v.title + ' ' + v.excerpt,
      role = historicalSourceRole(v.sourceId),
      c = newsHistoryClassify(role, text),
      facts = v4MacroActual(v);
    const macro =
      ['bls-cpi', 'bls-employment', 'federal-reserve'].includes(role) &&
      (['bls-cpi', 'bls-employment'].includes(role) || c.group.startsWith('MONETARY'));
    let kind: V4Event['kind'] = macro ? 'MACRO' : 'OTHER',
      stage: V4Event['stage'] = macro ? 'CONFIRMED' : 'UNKNOWN',
      severity: V4Event['severity'] = 'UNKNOWN',
      gate: V4Event['gate'] = 'ELIGIBLE_FOR_DESCRIPTIVE_ESTIMATION',
      featureSign: V4Event['featureSign'] = 1,
      featureKind: V4Event['featureKind'] = 'EVENT_STATUS';
    let assets = c.assets,
      baseline: V4Event['baseline'] = null;
    if (source.adapter === 'BYBIT_JSON')
      assets = [...new Set([...assets, ...exchangeHeadlineSymbols(v.title)])];
    if (source.id === 'xrpl-ledger-amendments') assets = ['XRP'];
    if (source.id === 'solana-public-incidents') assets = ['SOL'];
    if (source.id === 'coinbase-public-incidents' && !assets.length) assets = [...MARKET_ASSETS];
    if (!macro) {
      if (/hack|exploit|stolen|security incident/i.test(text)) kind = 'SECURITY';
      else if (/outage|halt|incident|disruption|unavailable/i.test(text)) kind = 'SERVICE';
      else if (/etf|\bSEC\b|lawsuit|enforcement|charges|regulat|settlement/i.test(text))
        kind = 'REGULATORY';
      else if (/delist|listing|listed|adoption|partnership/i.test(text)) kind = 'ADOPTION';
      else if (/upgrade|protocol|mainnet|amendment|hard fork/i.test(text)) kind = 'PROTOCOL';
      if (/postpon|cancel|delay(?:ed)?|withdrawn|abandoned/i.test(text)) {
        stage = 'POSTPONED';
        gate = 'HOLD_DELAY_OR_CANCELLATION';
      } else if (
        /not hacked|no evidence|no exploit|unconfirmed|rumou?r|alleged|investigating|reportedly|resolved|restored|monitoring|not confirmed/i.test(
          text,
        )
      ) {
        stage = 'UNCONFIRMED';
        gate = 'HOLD_UNCERTAIN_OR_RESOLVED';
      } else if (
        /\bAMA\b|join us|giveaway|airdrop|prize pool|\bearn\b|competition|campaign|weekly|newsletter|office hours|conference|grants|fellowship/i.test(
          text,
        )
      ) {
        stage = 'ROUTINE';
        gate = 'HOLD_ROUTINE';
      } else if (kind === 'PROTOCOL') {
        if (/testnet|beta|propos|scheduled|will|voting|release/i.test(text)) {
          stage = 'PROPOSED';
          gate = 'HOLD_PLANNED_OR_TESTNET';
        } else if (/activated|now live|successfully upgraded/i.test(text)) {
          stage = 'ACTIVATED';
          severity = 'MEDIUM';
        } else {
          stage = 'ANNOUNCED';
          gate = 'HOLD_PLANNED_OR_TESTNET';
        }
      } else if (kind === 'SECURITY' || kind === 'SERVICE') {
        if (
          /confirmed|stolen|funds (?:lost|drained)|network halt|network is down|critical vulnerability/i.test(
            text,
          )
        ) {
          stage = 'CONFIRMED';
          featureSign = -1;
          severity = 'HIGH';
        } else {
          stage = 'ANNOUNCED';
          gate = 'HOLD_UNCERTAIN_OR_RESOLVED';
        }
      } else if (kind === 'REGULATORY') {
        if (
          /approved|approval granted|dismissed|charges|sues|files (?:a )?lawsuit|enforcement action/i.test(
            text,
          ) &&
          !/proposal|proposes|seeks|may|could|consider/i.test(text)
        ) {
          stage = 'CONFIRMED';
          featureSign = /approved|approval granted|dismissed/i.test(text) ? 1 : -1;
          severity = 'MEDIUM';
        } else {
          stage = 'PROPOSED';
          gate = 'HOLD_PLANNED_OR_TESTNET';
        }
      } else if (kind === 'ADOPTION') {
        if (
          source.adapter === 'BYBIT_JSON' &&
          /delist|new listing|now listed|listing of|will list/i.test(text)
        ) {
          stage = 'ANNOUNCED';
          featureSign = /delist/i.test(text) ? -1 : 1;
          severity = 'MEDIUM';
        } else {
          stage = 'ANNOUNCED';
          gate = 'HOLD_PLANNED_OR_TESTNET';
        }
      } else gate = 'HOLD_IRRELEVANT';
    }
    const id = canonicalHash({ version: 'news-event.v4', versionId: v.id });
    const permittedMetadata =
      ['BYBIT_JSON', 'STATUSPAGE_JSON', 'XRPL_LEDGER'].includes(source.adapter) &&
      [
        'bybit-public-announcements',
        'solana-public-incidents',
        'coinbase-public-incidents',
        'xrpl-ledger-amendments',
      ].includes(source.id);
    if (!source.collectionApproved || (!permittedMetadata && (!source.aiAllowed || !v.aiAllowed)))
      gate = 'HOLD_PERMISSION';
    if (source.adapter === 'GDELT_DOC') {
      gate = 'HOLD_UNCERTAIN_OR_RESOLVED';
      featureKind = 'NONE';
      featureSign = 0;
    } else if (v.publishedAt === null || v.timestampStatus !== 'VALID') gate = 'HOLD_UNDATED';
    else if (v.publishedAt < plan.from || v.publishedAt >= plan.to || !assets.length)
      gate = 'HOLD_IRRELEVANT';
    const group = macro
      ? facts.metric + ':LAGGED_RELEASE_DEVIATION'
      : kind + ':' + (kind === 'ADOPTION' ? 'OFFICIAL_LISTING_ANNOUNCEMENT' : stage);
    const dedupKey = macro
      ? [v.independenceGroup, facts.metric, Math.floor((v.publishedAt ?? 0) / 86400000)].join('|')
      : [
          v.independenceGroup,
          group,
          assets.join(','),
          source.adapter === 'STATUSPAGE_JSON'
            ? new URL(v.url).pathname
            : Math.floor((v.publishedAt ?? 0) / 21600000),
        ].join('|');
    if (gate === 'ELIGIBLE_FOR_DESCRIPTIVE_ESTIMATION') {
      if (seen.has(dedupKey)) gate = 'HOLD_DUPLICATE';
      else seen.add(dedupKey);
    }
    if (macro && gate === 'ELIGIBLE_FOR_DESCRIPTIVE_ESTIMATION') {
      featureKind = 'LAGGED_RELEASE_DEVIATION';
      featureSign = 0;
      const priors = (numericHistory.get(facts.metric) ?? [])
        .filter((p) => p.at < v.publishedAt!)
        .slice(-3);
      if (facts.actual === null || priors.length < 3) gate = 'HOLD_MISSING_EXPECTATIONS';
      else {
        const median = [...priors].sort((a, b) => new Decimal(a.actual).cmp(b.actual))[1]!.actual;
        const delta = new Decimal(facts.actual).minus(median);
        baseline = {
          method: 'MEDIAN_OF_PREVIOUS_THREE_ORIGINAL_RELEASES_NOT_MARKET_CONSENSUS',
          value: median as NonNullable<V4Event['baseline']>['value'],
          previousEventIds: priors.map((p) => p.id),
          latestPriorPublicationAt: Math.max(...priors.map((p) => p.at)),
        };
        featureSign = delta.gt(0) ? 1 : delta.lt(0) ? -1 : 0;
        if (featureSign === 0) gate = 'HOLD_UNCERTAIN_OR_RESOLVED';
      }
      if (facts.actual !== null) {
        const old = numericHistory.get(facts.metric) ?? [];
        old.push({ id, at: v.publishedAt!, actual: facts.actual });
        numericHistory.set(facts.metric, old);
      }
    }
    return NewsV4Event.parse({
      id,
      versionId: v.id,
      sourceId: v.sourceId,
      publisher: v.publisher,
      independenceGroup: v.independenceGroup,
      title: v.title,
      url: v.url,
      assets,
      publishedAt: v.publishedAt,
      availableAt: Math.max(v.firstSeenAt, v.fetchedAt, v.availableAt),
      kind,
      stage,
      severity,
      attribution:
        source.category === 'OFFICIAL' || source.category === 'MACRO'
          ? 'OFFICIALLY_STATED'
          : 'UNVERIFIED',
      group,
      scope: macro || source.id === 'coinbase-public-incidents' ? 'MARKET_CONTEXT' : c.scope,
      gate,
      evidenceQuotes: [v.title, ...(v.excerpt ? [v.excerpt] : [])],
      macro: macro
        ? {
            metric: facts.metric,
            unit: facts.metric === 'PAYROLL_CHANGE' ? 'PERSONS' : 'PERCENT',
            actual: facts.actual,
            consensus: null,
            surprise: null,
            expectationHash: null,
            expectationAvailableAt: null,
          }
        : null,
      featureSign,
      featureKind,
      baseline,
    });
  });
}
