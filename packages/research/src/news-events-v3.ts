import { canonicalHash } from '@crypto/core';
import { Decimal } from 'decimal.js';
import { NewsV3Event, MacroExpectationSchema } from '../../contracts/src/news-research-v3.js';
import type { V3Event, MacroExpectation } from '../../contracts/src/news-research-v3.js';
import type {
  ResearchSnapshot,
  ResearchPlan,
  ResearchEvent,
} from '../../contracts/src/news-research.js';
import { NewsResearchSnapshot } from '../../contracts/src/news-research.js';
import { DecimalStringSchema } from '../../contracts/src/primitives.js';
import { newsHistoryClassify } from './news-history-study.js';

function macroFacts(
  sourceId: string,
  text: string,
  at: number | null,
  expectations: MacroExpectation[],
) {
  const metric =
    sourceId === 'bls-cpi'
      ? 'CPI_MOM'
      : sourceId === 'bls-employment'
        ? 'PAYROLL_CHANGE'
        : 'FED_TARGET_UPPER';
  const unit = metric === 'PAYROLL_CHANGE' ? 'PERSONS' : 'PERCENT';
  let actual: string | null = null;
  try {
    if (metric === 'CPI_MOM') {
      const m = /CPI for all items (increases|decreases|rises|falls)(?: by)?\s+([\d.]+)%/i.exec(
        text,
      );
      if (m)
        actual = DecimalStringSchema.parse(
          new Decimal(m[2]!).mul(/decreases|falls/i.test(m[1]!) ? -1 : 1).toFixed(),
        );
    } else if (metric === 'PAYROLL_CHANGE') {
      const m =
        /payroll employment\s*\(([+-]?\d[\d,]*)\)|payroll employment (rises|falls|increases|decreases)(?: by)?\s+([+-]?\d[\d,]*)/i.exec(
          text,
        );
      if (m)
        actual = DecimalStringSchema.parse(
          new Decimal((m[1] ?? m[3]!).replaceAll(',', ''))
            .mul(m[2] && /falls|decreases/i.test(m[2]) ? -1 : 1)
            .toFixed(),
        );
    }
  } catch {
    actual = null;
  }
  const expectation = expectations.find(
    (e) =>
      e.metric === metric &&
      e.releaseAt === at &&
      e.unit === unit &&
      e.publishedAt <= e.observedAt &&
      e.observedAt < e.releaseAt,
  );
  return {
    metric,
    unit,
    actual,
    consensus: expectation?.value ?? null,
    surprise:
      actual !== null && expectation
        ? DecimalStringSchema.parse(new Decimal(actual).minus(expectation.value).toFixed())
        : null,
    expectationHash: expectation ? canonicalHash(expectation) : null,
    expectationAvailableAt: expectation?.observedAt ?? null,
  };
}
/** Facts/status extraction only. News text cannot change execution policy or request tools. */
export function structureNewsV3(
  input: unknown,
  plan: ResearchPlan,
  forecastInput: MacroExpectation[] = [],
): V3Event[] {
  const snapshot = NewsResearchSnapshot.parse(input),
    forecasts = forecastInput.map((e) => MacroExpectationSchema.parse(e));
  if (snapshot.total !== snapshot.versions.length) throw new Error('Truncated V3 news snapshot');
  const sources = new Map(snapshot.sources.map((s) => [s.id, s])),
    seen = new Set<string>();
  return [...snapshot.versions]
    .sort(
      (a, b) =>
        (a.publishedAt ?? Infinity) - (b.publishedAt ?? Infinity) || a.id.localeCompare(b.id),
    )
    .map((v) => {
      const source = sources.get(v.sourceId);
      if (!source) throw new Error('Missing V3 source provenance');
      const text = v.title + '\n' + v.excerpt,
        legacy = newsHistoryClassify(v.sourceId, text);
      let kind: V3Event['kind'] = 'OTHER',
        stage: V3Event['stage'] = 'UNKNOWN',
        severity: V3Event['severity'] = 'UNKNOWN';
      let gate: V3Event['gate'] = 'ELIGIBLE_FOR_DESCRIPTIVE_ESTIMATION';
      const macro =
        ['bls-cpi', 'bls-employment'].includes(v.sourceId) || legacy.group.startsWith('MONETARY');
      if (macro) {
        kind = 'MACRO';
        stage = 'CONFIRMED';
      } else if (/hack|exploit|vulnerabilit|security (?:advisory|incident)|stolen/i.test(text))
        kind = 'SECURITY';
      else if (
        /outage|network halt|disruption|degraded|service unavailable|network incident/i.test(text)
      )
        kind = 'SERVICE';
      else if (/etf|lawsuit|enforcement|regulat|sec approv|charges|settlement/i.test(text))
        kind = 'REGULATORY';
      else if (
        /upgrade|protocol|mainnet|testnet|hard fork|pectra|glamsterdam|fusaka|eip-\d+/i.test(text)
      )
        kind = 'PROTOCOL';
      else if (/listing|listed|adoption|partnership|payment integration/i.test(text))
        kind = 'ADOPTION';
      const routine =
        /\bAMA\b|ask me anything|reddit|newsletter|weekly (?:update|roundup)|monthly (?:update|roundup)|research (?:update|report)|community call|join us|office hours|conference|devcon|grant|fellowship|ecosystem (?:support|program)/i.test(
          text,
        );
      // Material qualifiers precede broad positive keywords. Delay is never a default LONG.
      if (/\bpostpon|\bdelay(?:ed|ing)?\b|push(?:ed)? back/i.test(text)) {
        stage = 'POSTPONED';
        gate = 'HOLD_DELAY_OR_CANCELLATION';
      } else if (/cancel(?:led|ed|lation)|withdrawn|abandoned|retract/i.test(text)) {
        stage = 'CANCELLED';
        gate = 'HOLD_DELAY_OR_CANCELLATION';
      } else if (
        /not hacked|no (?:hack|exploit)|no evidence|did not|does not|not confirmed|denies/i.test(
          text,
        )
      ) {
        stage = 'NEGATED';
        gate = 'HOLD_UNCERTAIN_OR_RESOLVED';
      } else if (/\brumou?r|unconfirmed|alleged|reportedly|may have/i.test(text)) {
        stage = 'UNCONFIRMED';
        gate = 'HOLD_UNCERTAIN_OR_RESOLVED';
      } else if (/resolved|restored|recovered|incident ended/i.test(text)) {
        stage = 'RESOLVED';
        gate = 'HOLD_UNCERTAIN_OR_RESOLVED';
      } else if (routine) {
        stage = 'ROUTINE';
        kind = 'ROUTINE';
        severity = 'LOW';
        gate = 'HOLD_ROUTINE';
      } else if (/testnet|hoodi|sepolia|devnet|experimental|pre-?release|beta/i.test(text)) {
        stage = 'TESTNET';
        gate = 'HOLD_PLANNED_OR_TESTNET';
      } else if (
        /propos(?:al|ed)|draft|discussion|open for voting|candidate|planned|scheduled|upcoming|will (?:activate|launch|upgrade)|announcement/i.test(
          text,
        ) &&
        kind === 'PROTOCOL'
      ) {
        stage = 'PROPOSED';
        gate = 'HOLD_PLANNED_OR_TESTNET';
      } else if (
        kind === 'PROTOCOL' &&
        /activated|now live|went live|mainnet (?:activation|launch) completed|successfully (?:activated|upgraded)/i.test(
          text,
        )
      ) {
        stage = 'ACTIVATED';
        severity = 'MEDIUM';
      } else if (kind === 'SECURITY' || kind === 'SERVICE') {
        if (
          /confirmed|is (?:halted|unavailable)|stolen|funds (?:lost|drained)|emergency|critical vulnerability/i.test(
            text,
          )
        ) {
          stage = 'CONFIRMED';
          severity = 'HIGH';
        } else {
          stage = 'ANNOUNCED';
          gate = 'HOLD_UNCERTAIN_OR_RESOLVED';
        }
      } else if (kind === 'REGULATORY' || kind === 'ADOPTION') {
        if (
          /approved|approval granted|effective today|now available|has launched|has listed|officially listed/i.test(
            text,
          )
        ) {
          stage = 'CONFIRMED';
          severity = 'MEDIUM';
        } else {
          stage = 'ANNOUNCED';
          gate = 'HOLD_PLANNED_OR_TESTNET';
        }
      } else if (kind === 'PROTOCOL') {
        stage = 'ANNOUNCED';
        gate = 'HOLD_PLANNED_OR_TESTNET';
      }
      const facts = macro ? macroFacts(v.sourceId, text, v.publishedAt, forecasts) : null;
      if (macro && (!facts || facts.actual === null || facts.surprise === null))
        gate = 'HOLD_MISSING_EXPECTATIONS';
      if (kind === 'OTHER' || !legacy.assets.length) gate = 'HOLD_IRRELEVANT';
      if (!source.collectionApproved || !source.aiAllowed || !v.aiAllowed) gate = 'HOLD_PERMISSION';
      else if (v.publishedAt === null || v.timestampStatus !== 'VALID') gate = 'HOLD_UNDATED';
      else if (v.publishedAt < plan.from || v.publishedAt >= plan.to) gate = 'HOLD_IRRELEVANT';
      const group =
        macro && facts
          ? `${facts.metric}:${facts.surprise === null ? 'UNKNOWN' : new Decimal(facts.surprise).isZero() ? 'INLINE' : new Decimal(facts.surprise).gt(0) ? 'ABOVE' : 'BELOW'}`
          : `${kind}:${stage}`;
      const key = [
        v.independenceGroup,
        group,
        legacy.assets.join(','),
        v.publishedAt === null ? 'UNKNOWN' : Math.floor(v.publishedAt / 21600000),
      ].join('|');
      if (gate === 'ELIGIBLE_FOR_DESCRIPTIVE_ESTIMATION') {
        if (seen.has(key)) gate = 'HOLD_DUPLICATE';
        else seen.add(key);
      }
      return NewsV3Event.parse({
        id: canonicalHash({ version: 'structured-news.v3', versionId: v.id, group }),
        versionId: v.id,
        sourceId: v.sourceId,
        publisher: v.publisher,
        independenceGroup: v.independenceGroup,
        title: v.title,
        url: v.url,
        assets: legacy.assets,
        publishedAt: v.publishedAt,
        availableAt: Math.max(v.firstSeenAt, v.fetchedAt, v.availableAt),
        kind,
        stage,
        severity,
        attribution:
          source.category === 'OFFICIAL' || source.category === 'MACRO'
            ? 'OFFICIALLY_STATED'
            : source.category === 'RESEARCH'
              ? 'VENDOR_COMMENTARY'
              : 'UNVERIFIED',
        group,
        scope: macro ? 'MARKET_CONTEXT' : legacy.scope,
        gate,
        evidenceQuotes: [v.title, ...(v.excerpt ? [v.excerpt] : [])],
        macro: facts,
      });
    });
}
export function v3ReplayEvents(events: V3Event[], onlyEligible = true): ResearchEvent[] {
  return events
    .filter(
      (e) =>
        e.publishedAt !== null &&
        (!onlyEligible || e.gate === 'ELIGIBLE_FOR_DESCRIPTIVE_ESTIMATION'),
    )
    .map((e) => ({
      id: e.id,
      versionId: e.versionId,
      sourceId: e.sourceId,
      publisher: e.publisher,
      independenceGroup: e.independenceGroup,
      title: e.title,
      url: e.url,
      assets: e.assets,
      publishedAt: e.publishedAt!,
      availableAt: e.availableAt,
      group: e.group,
      fixedSide: 'HOLD',
      scope: e.scope,
      timing: 'DESCRIPTIVE_PUBLICATION_PROXY',
    }));
}
export function v3Coverage(
  events: V3Event[],
  snapshot: ResearchSnapshot,
  plan: ResearchPlan,
  asset: string,
) {
  void snapshot;
  const rows = events.filter(
    (e) =>
      e.assets.includes(asset as V3Event['assets'][number]) &&
      (e.publishedAt === null || (e.publishedAt >= plan.from && e.publishedAt < plan.to)),
  );
  const gates: Record<string, number> = {};
  for (const e of rows) gates[e.gate] = (gates[e.gate] ?? 0) + 1;
  return {
    relevant: rows.filter((e) => e.kind !== 'OTHER' && e.gate !== 'HOLD_IRRELEVANT').length,
    dated: rows.filter((e) => e.publishedAt !== null).length,
    eligible: rows.filter((e) => e.gate === 'ELIGIBLE_FOR_DESCRIPTIVE_ESTIMATION').length,
    independentGroups: new Set(
      rows.filter((e) => e.gate === 'ELIGIBLE_FOR_DESCRIPTIVE_ESTIMATION').map((e) => e.group),
    ).size,
    historicallyTimely: rows.filter(
      (e) => e.publishedAt !== null && e.availableAt <= e.publishedAt + plan.latencyMs,
    ).length,
    gates,
  };
}
