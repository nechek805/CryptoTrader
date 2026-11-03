import { Decimal } from 'decimal.js';
import {
  NewsEventSnapshotSchema,
  NewsSignalConfigSchema,
  NewsSignalQuerySchema,
  NewsSignalStateSchema,
  NewsRuleOpinionSchema,
  NewsSignalDecisionSchema,
  SignalCandidateSchema,
  UtcTimestampSchema,
  utcNanoseconds,
} from '@crypto/contracts';
import type {
  NewsSignalConfig,
  NewsSignalState,
  NewsRuleOpinion,
  NewsSignalDecision,
} from '@crypto/contracts';
import { canonicalHash, deepFreeze, deterministicId, fromEpoch } from '@crypto/core';
import { validateNewsEventSnapshot, buildNewsEventSnapshot } from '@crypto/news';
type Snapshot = ReturnType<typeof NewsEventSnapshotSchema.parse>;
const D = Decimal.clone({ precision: 80 });
export function defaultNewsSignalConfig() {
  return NewsSignalConfigSchema.parse({
    schemaVersion: 'news-signal-config.v1',
    algorithmVersion: 'conservative-news-rules.v1',
    declaredAt: '2026-01-01T00:00:00Z',
    symbols: [
      { asset: 'BTC', symbol: 'BTC/USDT' },
      { asset: 'ETH', symbol: 'ETH/USDT' },
    ],
    minimumIndependentOrigins: 2,
    requireExpectationMismatch: true,
    requireFirstSeen: true,
    maximumMarketAgeSeconds: 60,
    maximumReceiptLagSeconds: 300,
    holdValiditySeconds: 30,
    rules: [
      {
        id: 'news:security-incident-amount.v1',
        eventType: 'SECURITY_INCIDENT',
        side: 'SHORT',
        minimumReportedAmount: { value: '1000000', unit: 'USD' },
        horizonSeconds: 900,
        maximumFirstKnownAgeSeconds: 600,
      },
      {
        id: 'news:listing-amount.v1',
        eventType: 'LISTING',
        side: 'LONG',
        minimumReportedAmount: { value: '1000000', unit: 'USD' },
        horizonSeconds: 900,
        maximumFirstKnownAgeSeconds: 600,
      },
    ],
  });
}
export interface NewsSignalProvider {
  readonly providerHash: string;
  readonly config: NewsSignalConfig;
  initialState(): NewsSignalState;
  snapshotAt(at: unknown): Snapshot;
  evaluate(
    query: unknown,
    state: unknown,
  ): { state: NewsSignalState; decision: NewsSignalDecision };
}
class ConservativeNewsSignalProvider implements NewsSignalProvider {
  readonly config: NewsSignalConfig;
  readonly providerHash: string;
  readonly sourceHash: string;
  readonly #source: Snapshot;
  readonly #snapshots = new Map<string, Snapshot>();
  constructor(
    configInput: unknown,
    sourceInput: unknown,
    readonly codeVersion: string,
  ) {
    if (!codeVersion || codeVersion.length > 200)
      throw new Error('Invalid news strategy software version');
    this.config = NewsSignalConfigSchema.parse(configInput);
    const parsed = NewsEventSnapshotSchema.parse(sourceInput);
    if (
      parsed.input.graphRecords.length > 32 ||
      parsed.input.metadataRecords.length > 16 ||
      parsed.view.events.length > 16
    )
      throw new Error('News signal source work budget');
    this.#source = validateNewsEventSnapshot(parsed);
    this.sourceHash = canonicalHash(this.#source);
    this.providerHash = canonicalHash({
      config: this.config,
      codeVersion,
      graphConfig: this.#source.graphConfig,
      eventConfig: this.#source.config,
    });
    deepFreeze(this.config);
  }
  initialState() {
    return NewsSignalStateSchema.parse({
      schemaVersion: 'news-signal-state.v1',
      providerHash: this.providerHash,
      lastDecisionAt: null,
      slots: [],
    });
  }
  snapshotAt(atInput: unknown): Snapshot {
    const at = UtcTimestampSchema.parse(atInput);
    if (at > this.#source.request.decisionAt)
      throw new Error('News query exceeds frozen source cutoff');
    const old = this.#snapshots.get(at);
    if (old) return old;
    const result = buildNewsEventSnapshot(
      this.#source.graphConfig,
      this.#source.input.graphRecords,
      this.#source.input.metadataRecords,
      this.#source.config,
      { decisionAt: at, generatedAt: at },
      this.#source.codeVersion,
    );
    if (this.#snapshots.size >= 32) this.#snapshots.delete(this.#snapshots.keys().next().value!);
    this.#snapshots.set(at, result);
    return result;
  }
  evaluate(input: unknown, stateInput: unknown) {
    const q = NewsSignalQuerySchema.parse(input),
      state = NewsSignalStateSchema.parse(stateInput),
      cfg = this.config,
      binding = cfg.symbols.find((s) => s.symbol === q.symbol);
    if (
      !binding ||
      state.providerHash !== this.providerHash ||
      (state.lastDecisionAt !== null && state.lastDecisionAt > q.decisionAt)
    )
      throw new Error('News state, scope or decision clock mismatch');
    const freshness = q.freshness,
      { proofHash, ...guardBody } = freshness;
    if (
      proofHash !== canonicalHash(guardBody) ||
      freshness.symbol !== q.symbol ||
      freshness.decisionAt !== q.decisionAt ||
      (freshness.closeAt !== null && freshness.closeAt > q.decisionAt) ||
      (freshness.availableAt !== null && freshness.availableAt > q.decisionAt)
    )
      throw new Error('Invalid/future operational freshness veto');
    const snapshot = this.snapshotAt(q.decisionAt),
      snapshotHash = canonicalHash(snapshot),
      event = snapshot.view.events.find((e) => e.identity.id === q.eventId) ?? null,
      reasons: string[] = [],
      nodes = event
        ? snapshot.view.graph.nodes.filter((n) => event.identity.claimIds.includes(n.id))
        : [];
    const roots = event
      ? event.independence.groups
          .filter((g) => g.affirmative)
          .map(
            (g) =>
              g.rootClaimIds
                .map((id) => nodes.find((n) => n.id === id))
                .filter(
                  (n): n is NonNullable<typeof n> =>
                    n !== undefined &&
                    n.active &&
                    n.eligible &&
                    !n.retracted &&
                    n.polarity === 'AFFIRMED',
                )
                .sort((a, b) =>
                  a.knownAt < b.knownAt ? -1 : a.knownAt > b.knownAt ? 1 : a.id < b.id ? -1 : 1,
                )[0],
          )
          .filter((n) => n !== undefined)
      : [];
    const articleByClaim = new Map(
      snapshot.input.graphRecords.flatMap((r) =>
        r.action.kind === 'OBSERVE'
          ? r.action.extraction.claims.map(
              (c) =>
                [
                  c.id,
                  r.action.kind === 'OBSERVE' ? r.action.extraction.input.article : null,
                ] as const,
            )
          : [],
      ),
    );
    const publicationLags = roots.map((n) => {
        const published = articleByClaim.get(n.id)?.effectivePublishedAt;
        return !published || published > n.firstObservedAt
          ? null
          : Number(utcNanoseconds(n.knownAt) - utcNanoseconds(published)) / 1e9;
      }),
      publicationDelay =
        publicationLags.length && publicationLags.every((v) => v !== null)
          ? Math.max(...publicationLags)
          : null;
    const extracted = new Map(
        snapshot.input.graphRecords.flatMap((r) =>
          r.action.kind === 'OBSERVE'
            ? r.action.extraction.claims.map((c) => [c.id, c.candidate] as const)
            : [],
        ),
      ),
      types = [
        ...new Set(
          nodes.flatMap((n) => {
            const c = extracted.get(n.id);
            return c ? [c.eventType] : [];
          }),
        ),
      ],
      rule = types.length === 1 ? (cfg.rules.find((r) => r.eventType === types[0]) ?? null) : null;
    const direct =
        event?.assets.filter(
          (a) =>
            a.symbol === binding.asset &&
            a.relationship === 'DIRECT' &&
            a.ruleHash !== null &&
            a.knownAt <= q.decisionAt,
        ) ?? [],
      age = event
        ? Number(utcNanoseconds(q.decisionAt) - utcNanoseconds(event.firstKnownAt)) / 1e9
        : null;
    let severity: NewsRuleOpinion['severity'] = 'UNKNOWN';
    if (rule && roots.length) {
      const amounts = roots.map((n) =>
        extracted
          .get(n.id)
          ?.amounts.find((a) => a.value !== null && a.unit === rule.minimumReportedAmount.unit),
      );
      if (amounts.every((a) => a !== undefined))
        severity = amounts.every((a) => new D(a.value!).gte(rule.minimumReportedAmount.value))
          ? 'REPORTED_AMOUNT_THRESHOLD_MET'
          : 'BELOW_THRESHOLD';
    }
    const grade: NewsRuleOpinion['supportGrade'] =
      event?.status === 'DISPUTED'
        ? 'DISPUTED'
        : event?.status === 'RETRACTED'
          ? 'WITHDRAWN'
          : !event
            ? 'UNKNOWN'
            : roots.length >= cfg.minimumIndependentOrigins
              ? 'ATTRIBUTED_SUPPORT'
              : 'INSUFFICIENT';
    const holdUntil = fromEpoch(
        utcNanoseconds(q.decisionAt) + BigInt(cfg.holdValiditySeconds) * 1000000000n,
        'nanoseconds',
      ),
      eventExpiry =
        event && rule
          ? fromEpoch(
              utcNanoseconds(event.firstKnownAt) + BigInt(rule.horizonSeconds) * 1000000000n,
              'nanoseconds',
            )
          : null;
    if (q.decisionAt < cfg.declaredAt) reasons.push('RULES_NOT_YET_DECLARED');
    if (!event) reasons.push('EVENT_NOT_VISIBLE');
    if (event) {
      if (!event.active || event.identity.kind !== 'BASE')
        reasons.push('INACTIVE_OR_REVIEWED_IDENTITY');
      if (!event.replayEligible || event.availableAt === null || event.availableAt > q.decisionAt)
        reasons.push('UNRELIABLE_EVENT_AVAILABILITY');
      if (event.abstentionReasons.some((r) => !['UNVERIFIED'].includes(r)))
        reasons.push(...event.abstentionReasons.map((r) => `EVENT_${r}`));
      if (roots.length < cfg.minimumIndependentOrigins)
        reasons.push('INSUFFICIENT_INDEPENDENT_ORIGINS');
      if (grade === 'DISPUTED' || grade === 'WITHDRAWN') reasons.push(`EVIDENCE_${grade}`);
      if (!direct.length) reasons.push('NO_DIRECT_ASSET_MAPPING');
      if (cfg.requireFirstSeen && event.novelty.pattern !== 'FIRST_SEEN_IN_CORPUS')
        reasons.push('NOT_FIRST_SEEN_IN_CORPUS');
      if (cfg.requireExpectationMismatch && event.surprise.marker !== 'EXPECTATION_MISMATCH')
        reasons.push('NO_COMPARABLE_EXPECTATION_MISMATCH');
      if (rule && age! > rule.maximumFirstKnownAgeSeconds)
        reasons.push('FIRST_KNOWN_DELAY_EXCEEDED');
      if (eventExpiry !== null && eventExpiry <= q.decisionAt)
        reasons.push('EVENT_HORIZON_EXPIRED');
    }
    if (!rule) reasons.push('UNCLEAR_EVENT_IMPACT');
    if (roots.length && publicationDelay === null) reasons.push('UNRELIABLE_PUBLICATION_TIMESTAMP');
    if (publicationDelay !== null && publicationDelay > cfg.maximumReceiptLagSeconds)
      reasons.push('FIRST_KNOWN_PUBLICATION_LAG_EXCEEDED');
    if (severity !== 'REPORTED_AMOUNT_THRESHOLD_MET')
      reasons.push(
        severity === 'UNKNOWN' ? 'UNKNOWN_REPORTED_SEVERITY' : 'REPORTED_AMOUNT_BELOW_THRESHOLD',
      );
    const rootIds = roots.map((n) => n.id).sort(),
      sourceIds = [...new Set(nodes.map((n) => n.sourceId))].sort(),
      evidenceIds = [
        ...new Set([
          ...nodes.map((n) => n.id),
          ...direct.flatMap((a) => (a.ruleHash ? [a.ruleHash] : [])),
          ...(event?.surprise.expectationHash ? [event.surprise.expectationHash] : []),
          ...(event?.history.corrections.map((c) => c.recordHash) ?? []),
        ]),
      ].sort();
    const materialHash = canonicalHash({
      eventId: event?.identity.id ?? q.eventId,
      rootIds,
      grade,
      rule,
      assetRules: direct.map((a) => a.ruleHash).sort(),
      novelty: event?.novelty.pattern ?? 'UNKNOWN',
      surprise: event?.surprise ?? null,
      corrections: event?.history.corrections.map((c) => c.recordHash) ?? [],
      severity,
      status: event?.status ?? null,
    });
    const maxInputKnownAt =
      [
        ...snapshot.input.graphRecords.map((r) => r.recordedAt),
        ...snapshot.input.metadataRecords.map((r) => r.recordedAt),
      ]
        .sort()
        .at(-1) ?? null;
    const opinion = NewsRuleOpinionSchema.parse({
      schemaVersion: 'news-rule-opinion.v1',
      eventId: event?.identity.id ?? null,
      snapshotHash,
      decisionAt: q.decisionAt,
      symbol: q.symbol,
      ruleId: rule?.id ?? null,
      ruleHash: rule ? canonicalHash(rule) : null,
      conditionalSide: reasons.length ? 'HOLD' : rule!.side,
      supportGrade: grade,
      independentOrigins: roots.length,
      representativeRootIds: rootIds,
      sourceIds,
      evidenceIds,
      firstKnownAt: event?.firstKnownAt ?? null,
      availableAt: event?.availableAt ?? null,
      maxInputKnownAt,
      firstKnownAgeSeconds: age,
      maximumObservedPublicationDelaySeconds: publicationDelay,
      severity,
      novelty: event?.novelty.pattern ?? 'UNKNOWN',
      surprise: event?.surprise.marker ?? 'UNKNOWN',
      materialHash,
      reasons: [...new Set(reasons)],
      expiresAt: reasons.length ? holdUntil : eventExpiry!,
    });
    const blocked = [...opinion.reasons];
    if (
      freshness.status !== 'FRESH' ||
      freshness.barId === null ||
      freshness.closeAt === null ||
      freshness.availableAt === null ||
      freshness.sourceIds.length === 0 ||
      freshness.metadataIds.length === 0 ||
      utcNanoseconds(q.decisionAt) - utcNanoseconds(freshness.closeAt) >
        BigInt(cfg.maximumMarketAgeSeconds) * 1000000000n
    )
      blocked.push('OPERATIONAL_FRESHNESS_VETO');
    const prior = state.slots.find(
      (s) => s.eventId === event?.identity.id && s.symbol === q.symbol,
    );
    if (prior?.materialHash === materialHash && opinion.conditionalSide !== 'HOLD')
      blocked.push('NO_NEW_INDEPENDENT_EVIDENCE');
    const remainingSeconds =
      eventExpiry === null
        ? 0
        : Number((utcNanoseconds(eventExpiry) - utcNanoseconds(q.decisionAt)) / 1000000000n);
    if (opinion.conditionalSide !== 'HOLD' && remainingSeconds < 1)
      blocked.push('EVENT_HORIZON_TOO_SHORT');
    const side = blocked.length ? 'HOLD' : opinion.conditionalSide,
      next: NewsSignalState = { ...state, lastDecisionAt: q.decisionAt, slots: [...state.slots] };
    if (side !== 'HOLD' && event) {
      const slot = { eventId: event.identity.id, symbol: q.symbol, materialHash, side };
      next.slots = next.slots.filter((s) => s.eventId !== slot.eventId || s.symbol !== slot.symbol);
      next.slots.push(slot);
    }
    const body = {
      schemaVersion: 'signal-candidate.v1',
      strategyId: 'news:conservative-rules',
      version: '1',
      portfolio: 'NEWS_ONLY',
      symbol: q.symbol,
      decisionAt: q.decisionAt,
      dataCutoff: q.decisionAt,
      horizon: {
        value: side === 'HOLD' ? cfg.holdValiditySeconds : remainingSeconds,
        unit: 'seconds',
      },
      side,
      score: {
        status: 'MISSING',
        reason: 'Conditional untrained news rule; no expected-return score',
      },
      calibration: {
        status: 'MISSING',
        reason: 'Attributed evidence support is not a factual or return probability',
      },
      rationaleIds: [
        ...new Set([
          snapshotHash,
          ...(event ? [event.identity.id] : []),
          ...evidenceIds,
          ...sourceIds,
          proofHash,
        ]),
      ],
      validUntil: side === 'HOLD' ? holdUntil : eventExpiry!,
      reproducibility: {
        datasetHashes: [snapshotHash, proofHash],
        configHash: this.providerHash,
        codeVersion: this.codeVersion,
        modelVersion: 'conservative-news-rules.v1',
        randomSeed: 0,
        randomAlgorithm: 'mulberry32.v1',
        clockSemantics: 'utc-nanoseconds.v1',
        generatedAt: q.decisionAt,
        feeAssumptionsHash: canonicalHash({ execution: 'DISABLED', costModel: 'UNMODELED' }),
      },
    };
    const candidate = SignalCandidateSchema.parse({
        ...body,
        id: deterministicId('news-signal', { body, priorStateHash: canonicalHash(state) }),
      }),
      parsedState = NewsSignalStateSchema.parse(next),
      decision = NewsSignalDecisionSchema.parse({
        schemaVersion: 'news-signal-decision.v1',
        opinion,
        freshness,
        candidate,
        abstentionReasons: [...new Set(blocked)],
        stateHash: canonicalHash(parsedState),
      });
    deepFreeze(parsedState);
    deepFreeze(decision);
    return { state: parsedState, decision };
  }
}
export const NewsSignalProvider = ConservativeNewsSignalProvider;
