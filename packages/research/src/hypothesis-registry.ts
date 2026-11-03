import {
  HypothesisRegistryInputSchema,
  HypothesisRegistryRequestSchema,
  HypothesisRegistryArtifactSchema,
} from '@crypto/contracts';
import type { HypothesisSample, HypothesisEvaluation } from '@crypto/contracts';
import { canonicalHash, deepFreeze } from '@crypto/core';
import { buildNewsEventSnapshot, validateNewsEventSnapshot } from '@crypto/news';
import { SnapshotEventStudy } from './event-study.js';
import { validateHypothesisCards } from './hypothesis-cards.js';
import { ControlDecimal as D, metric, pathReturn, shift } from './event-control-math.js';
import {
  hypothesisUnits,
  hypothesisStatistics,
  hypothesisPhaseSeed,
} from './hypothesis-statistics.js';

export function hypothesisEvidence(input: unknown) {
  const dataset = HypothesisRegistryInputSchema.shape.dataset.parse(input),
    snapshots = new Map(
      dataset.newsSnapshots.map((raw) => {
        const s = validateNewsEventSnapshot(raw);
        return [canonicalHash(s), s];
      }),
    );
  if (
    snapshots.size !== dataset.newsSnapshots.length ||
    new Set(dataset.observations.map((o) => o.id)).size !== dataset.observations.length
  )
    throw new Error('Duplicate hypothesis evidence');
  const frames = new Map<string, ReturnType<typeof buildNewsEventSnapshot>>();
  const observations = dataset.observations.map((o) => {
    if (o.kind === 'HISTORICAL_DESCRIPTIVE')
      return {
        observation: o,
        event: null,
        taxonomy: [o.eventGroup],
        firstSeenQuality: o.firstSeenQuality,
        availableAt: o.availableAt,
        lineageIds: [o.eventId],
        sourceIds: o.provenance.sourceIds,
        contextHash: null,
      };
    const snapshot = snapshots.get(o.snapshotHash);
    if (!snapshot || o.decisionAt > snapshot.request.decisionAt)
      throw new Error('Missing snapshot or decision beyond frozen cutoff');
    const key = `${o.snapshotHash}|${o.decisionAt}`;
    let frame = frames.get(key);
    if (!frame) {
      frame = buildNewsEventSnapshot(
        snapshot.graphConfig,
        snapshot.input.graphRecords,
        snapshot.input.metadataRecords,
        snapshot.config,
        { decisionAt: o.decisionAt, generatedAt: snapshot.request.generatedAt },
        snapshot.codeVersion,
      );
      frames.set(key, frame);
    }
    const event = frame.view.events.find((e) => e.identity.id === o.eventId);
    if (!event) throw new Error('Event not present at its declared decision');
    const claims = frame.input.graphRecords.flatMap((r) =>
        r.action.kind === 'OBSERVE'
          ? r.action.extraction.claims.filter((c) => event.identity.claimIds.includes(c.id))
          : [],
      ),
      firstSeenQuality =
        claims.length && claims.every((c) => c.canonical.availabilityBasis === 'OBSERVED')
          ? 'OBSERVED'
          : claims.length &&
              claims.every((c) =>
                ['OBSERVED', 'ARCHIVED_CAPTURE'].includes(c.canonical.availabilityBasis),
              )
            ? 'ARCHIVED_CAPTURE'
            : 'UNKNOWN';
    return {
      observation: o,
      event,
      taxonomy: [...new Set(claims.map((c) => c.candidate.eventType))].sort(),
      firstSeenQuality,
      availableAt: event.availableAt,
      lineageIds: [
        ...new Set([
          event.identity.id,
          ...event.identity.parentIds,
          ...event.identity.baseClusterIds,
        ]),
      ].sort(),
      sourceIds: [
        ...new Set(
          frame.view.graph.nodes
            .filter((n) => event.identity.claimIds.includes(n.id))
            .map((n) => n.sourceId),
        ),
      ].sort(),
      contextHash: canonicalHash(event),
    };
  });
  return { dataset, observations };
}
export function buildHypothesisRegistry(
  input: unknown,
  requestInput: unknown,
  codeVersion: string,
) {
  const parsed = HypothesisRegistryInputSchema.parse(input),
    cards = validateHypothesisCards(parsed.cards),
    request = HypothesisRegistryRequestSchema.parse(requestInput),
    { dataset, observations } = hypothesisEvidence(parsed.dataset),
    latest = [...new Map(cards.map((c) => [c.content.id, c])).values()],
    familySize = latest.length * 2;
  if (cards.some((c) => c.recordedAt > request.generatedAt))
    throw new Error('Registry generation precedes card recording');
  const first = dataset.newsSnapshots[0],
    prices = first
      ? new SnapshotEventStudy({
          schemaVersion: 'event-study-input.v1',
          newsSnapshot: first,
          bars: dataset.marketBars,
          marketSnapshots: dataset.marketSnapshots,
        })
      : null,
    synthetic =
      dataset.marketBars.every((b) => b.provenance.origin === 'FIXTURE') &&
      dataset.observations.every(
        (o) => o.kind !== 'HISTORICAL_DESCRIPTIVE' || o.provenance.origin === 'FIXTURE',
      ) &&
      dataset.newsSnapshots.every((s) =>
        s.input.graphRecords.every(
          (r) =>
            r.action.kind !== 'OBSERVE' ||
            r.action.extraction.input.article.version.document.provenance.origin === 'FIXTURE',
        ),
      );
  let priceWork = 0,
    resamplingWork = 0;
  const evaluations: HypothesisEvaluation[] = latest.map((card) => {
    const content = card.content,
      samples: HypothesisSample[] = [];
    for (const phase of ['SELECTION', 'VALIDATION'] as const) {
      const period = content.samplePeriod[phase === 'SELECTION' ? 'selection' : 'validation'];
      for (const e of observations) {
        const o = e.observation;
        if (
          o.decisionAt > request.analysisAsOf ||
          (o.kind === 'HISTORICAL_DESCRIPTIVE' && o.provenance.capturedAt > request.analysisAsOf)
        )
          continue;
        if (
          !e.taxonomy.some((t) => content.eventGroup.includes(t)) ||
          o.decisionAt < period.from ||
          o.decisionAt >= period.to
        )
          continue;
        const endAt = shift(o.decisionAt, content.horizonSeconds),
          base = {
            observationId: o.id,
            eventId: o.eventId,
            decisionAt: o.decisionAt,
            endAt,
            phase,
            firstSeenQuality: e.firstSeenQuality as HypothesisSample['firstSeenQuality'],
            availableAt: e.availableAt,
            lineageIds: e.lineageIds,
            eventContextHash: e.contextHash,
            sourceIds: e.sourceIds,
            grossReturn: null,
            netReturn: null,
            barIds: [],
            missingCloseTimes: [],
          };
        let status: HypothesisSample['status'] = 'COMPLETE';
        if (o.kind === 'HISTORICAL_DESCRIPTIVE') status = 'DESCRIPTIVE_ONLY';
        else if (
          !e.event?.active ||
          !e.event.replayEligible ||
          e.availableAt === null ||
          e.availableAt > o.decisionAt
        )
          status = 'UNAVAILABLE_AT_DECISION';
        else if (!content.eligibility.firstSeenQualities.some((q) => q === e.firstSeenQuality))
          status = 'QUALITY_EXCLUDED';
        else if (
          !content.eligibility.allowUnverified &&
          !['CORROBORATED', 'OFFICIALLY_STATED'].includes(e.event.status)
        )
          status = 'UNVERIFIED_EXCLUDED';
        else if (endAt > period.to) status = 'OUTCOME_OUTSIDE_PERIOD';
        else if (endAt > request.analysisAsOf) status = 'FUTURE_OUTCOME';
        if (status !== 'COMPLETE') {
          samples.push({ ...base, status });
          continue;
        }
        priceWork += content.horizonSeconds / content.intervalSeconds + 1;
        if (priceWork > 250000) throw new Error('Hypothesis price work budget exceeded');
        const path = prices?.observePath({
            series: content.series,
            from: o.decisionAt,
            to: endAt,
            intervalSeconds: content.intervalSeconds,
            analysisAsOf: request.analysisAsOf,
          }),
          r = path ? pathReturn(path) : null;
        samples.push({
          ...base,
          status: r === null ? 'MISSING_PRICES' : 'COMPLETE',
          grossReturn: r === null ? null : metric(r),
          netReturn:
            r === null ? null : metric(r.minus(new D(content.roundTripCostBps).div(10000))),
          barIds: path?.bars.map((b) => b.id) ?? [],
          missingCloseTimes: path?.missingCloseTimes ?? [],
        });
      }
    }
    const selection = samples.filter((s) => s.phase === 'SELECTION'),
      validation = samples.filter((s) => s.phase === 'VALIDATION'),
      reuseReasons: HypothesisEvaluation['reuseReasons'] = [],
      a = content.samplePeriod.selection,
      b = content.samplePeriod.validation;
    if (a.from < b.to && b.from < a.to) reuseReasons.push('PERIOD_OVERLAP');
    if (
      selection.some((s) =>
        validation.some((v) => s.lineageIds.some((id) => v.lineageIds.includes(id))),
      )
    )
      reuseReasons.push('LINEAGE_ACROSS_PERIODS');
    if (card.recordedAt > b.from) reuseReasons.push('FREEZE_AFTER_VALIDATION_START');
    if (reuseReasons.length && content.reuseDisclosure === null)
      throw new Error('Selection/validation reuse or retrospective freeze requires disclosure');
    const units = hypothesisUnits(selection).length + hypothesisUnits(validation).length;
    resamplingWork += units * request.bootstrapSamples;
    if (resamplingWork > 500000) throw new Error('Hypothesis resampling work budget exceeded');
    const stats = (rows: HypothesisSample[], phase: string) =>
        hypothesisStatistics(
          rows,
          content,
          request.bootstrapSamples,
          hypothesisPhaseSeed(request.seed, card.hash, phase),
          familySize,
        ),
      selectionStats = stats(selection, 'SELECTION'),
      validationStats = stats(validation, 'VALIDATION'),
      ci = validationStats.confidenceInterval,
      threshold = new D(content.tests.meanThreshold);
    let finding: HypothesisEvaluation['finding'] = 'UNTESTED';
    if (ci && content.expectedDirection !== 'UNSPECIFIED') {
      if (content.expectedDirection === 'UP')
        finding = new D(ci.lower).gt(threshold)
          ? 'SUPPORTED_IN_SAMPLE'
          : new D(ci.upper).lte(threshold)
            ? 'CONTRADICTED_IN_SAMPLE'
            : 'INCONCLUSIVE';
      else
        finding = new D(ci.upper).lt(threshold.neg())
          ? 'SUPPORTED_IN_SAMPLE'
          : new D(ci.lower).gte(threshold.neg())
            ? 'CONTRADICTED_IN_SAMPLE'
            : 'INCONCLUSIVE';
    }
    const finalStatus: HypothesisEvaluation['finalStatus'] =
      content.status === 'DRAFT'
        ? 'DRAFT'
        : content.status === 'RETIRED'
          ? 'RETIRED'
          : content.claimType === 'CAUSAL'
            ? 'CAUSAL_REVIEW_REQUIRED'
            : reuseReasons.length
              ? 'EXPLORATORY_REUSE'
              : finding === 'UNTESTED'
                ? 'INSUFFICIENT_DATA'
                : finding === 'CONTRADICTED_IN_SAMPLE'
                  ? 'NEGATIVE_FINDING'
                  : finding === 'INCONCLUSIVE'
                    ? 'INCONCLUSIVE'
                    : synthetic
                      ? 'SYNTHETIC_ONLY'
                      : 'ASSOCIATION_ONLY';
    return {
      cardId: content.id,
      cardHash: card.hash,
      revision: card.revision,
      independence: reuseReasons.length ? 'REUSE_DISCLOSED' : 'SEPARATE_PERIODS_AND_LINEAGE',
      reuseReasons,
      selection: selectionStats,
      validation: validationStats,
      samples,
      finding,
      finalStatus,
      contradictoryExamples: samples
        .filter((s) => {
          const value =
            content.tests.primaryMetric === 'GROSS_RETURN' ? s.grossReturn : s.netReturn;
          return (
            s.status === 'COMPLETE' &&
            value !== null &&
            (content.expectedDirection === 'UP'
              ? new D(value).lte(threshold)
              : content.expectedDirection === 'DOWN'
                ? new D(value).gte(threshold.neg())
                : false)
          );
        })
        .slice(0, 20)
        .map((s) => s.observationId),
    };
  });
  const artifact = HypothesisRegistryArtifactSchema.parse({
    schemaVersion: 'hypothesis-registry-artifact.v1',
    algorithmVersion: 'hypothesis-registry.v1',
    execution: 'DISABLED',
    interpretation: 'OBSERVATIONAL_RESEARCH_NOT_CAUSAL_OR_EXECUTABLE',
    clockSemantics: 'utc-nanoseconds.v1',
    randomAlgorithm: 'mulberry32.v1',
    codeVersion,
    input: { ...parsed, cards },
    inputHash: canonicalHash({ ...parsed, cards }),
    request,
    configHash: canonicalHash(request),
    synthetic,
    evaluations,
  });
  deepFreeze(artifact);
  return artifact;
}
