import {
  EventControlsRequestSchema,
  EventControlsResultSchema,
  utcNanoseconds,
} from '@crypto/contracts';
import type {
  EventControls,
  EventControlsResult,
  EventStudyPricePath,
  EventStudySeries,
} from '@crypto/contracts';
import { canonicalHash, deepFreeze, deterministicId, SeededRandom } from '@crypto/core';
import { newsEventResearchInputs } from '@crypto/news';
import { SnapshotEventStudy } from './event-study.js';
import {
  ControlDecimal as D,
  metric,
  shift,
  elapsed,
  pathReturn,
  pathVolatility,
  returnPoints,
  fitFactor,
  lagCorrelation,
  recovery,
} from './event-control-math.js';

const key = (s: EventStudySeries) => `${s.exchange}|${s.instrumentId}|${s.marketType}`;
const coverage = (p: EventStudyPricePath) => ({
  complete: p.missingCloseTimes.length === 0,
  expectedBars: elapsed(p.request.from, p.request.to) / p.request.intervalSeconds,
  observedBars: p.bars.filter((b) => b.closeAt > p.request.from).length,
  barIds: p.bars.map((b) => b.id),
  missingCloseTimes: p.missingCloseTimes,
  excludedBarIds: p.excludedBarIds,
});
type ResultEvent = EventControlsResult['events'][number];
function summarize(events: ResultEvent[], horizon: number) {
  const taxonomy = new Map<string, ResultEvent[]>();
  for (const e of events) {
    const k = e.taxonomy.join('+');
    const list = taxonomy.get(k) ?? [];
    list.push(e);
    taxonomy.set(k, list);
  }
  const taxonomyGroups = [...taxonomy.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([, rows]) => {
      const complete = rows.flatMap((e) => e.responses).filter((r) => r.absoluteReturn !== null);
      return {
        taxonomy: rows[0]!.taxonomy,
        observations: rows.length,
        uniqueEvents: new Set(rows.map((e) => e.eventId)).size,
        completeResponses: complete.length,
        meanAbsoluteReturn: complete.length
          ? metric(D.sum(...complete.map((r) => r.absoluteReturn!)).div(complete.length))
          : null,
      };
    });
  // Connected lineage components keep repeated/split identities from looking independent.
  const groups: ResultEvent[][] = [];
  for (const e of events) {
    const overlaps = groups.filter((g) =>
      g.some(
        (v) => v.eventId === e.eventId || v.lineageIds.some((id) => e.lineageIds.includes(id)),
      ),
    );
    if (!overlaps.length) groups.push([e]);
    else {
      const merged = [e, ...overlaps.flat()];
      for (const g of overlaps) groups.splice(groups.indexOf(g), 1);
      groups.push(merged);
    }
  }
  const complete = (rows: ResultEvent[]) =>
      rows
        .flatMap((e) => e.responses)
        .flatMap((r) => (r.absoluteReturn === null ? [] : [new D(r.absoluteReturn)])),
    mass = (rows: ResultEvent[]) => (complete(rows).length ? D.sum(...complete(rows)) : null),
    total = mass(events),
    concentrationGroups = groups
      .map((g) => {
        const eventIds = [...new Set(g.map((e) => e.eventId))].sort(),
          value = mass(g);
        return {
          groupId: deterministicId('event-concentration', eventIds),
          eventIds,
          observations: g.length,
          completeResponses: complete(g).length,
          absoluteMovement: value === null ? null : metric(value),
          share:
            total === null || total.isZero() || value === null ? null : metric(value.div(total)),
        };
      })
      .sort((a, b) => (a.groupId < b.groupId ? -1 : 1));
  let overlappingObservationPairs = 0;
  for (let i = 0; i < events.length; i++)
    for (let j = i + 1; j < events.length; j++) {
      const a = events[i]!,
        b = events[j]!;
      if (
        a.decisionAt < shift(b.decisionAt, horizon) &&
        b.decisionAt < shift(a.decisionAt, horizon)
      )
        overlappingObservationPairs++;
    }
  const shares = concentrationGroups.flatMap((g) => (g.share === null ? [] : [new D(g.share)]));
  return {
    taxonomyGroups,
    concentration: {
      selectedObservations: events.length,
      uniqueEventIds: new Set(events.map((e) => e.eventId)).size,
      overlappingObservationPairs,
      completeResponses: complete(events).length,
      herfindahl: shares.length ? metric(D.sum(...shares.map((s) => s.pow(2)))) : null,
      largestShare: shares.length ? metric(D.max(...shares)) : null,
      groups: concentrationGroups,
    },
  };
}

/** Bounded, descriptive controls. All prices use the same exact-close availability gate. */
export class SnapshotEventControls implements EventControls {
  readonly study: SnapshotEventStudy;
  constructor(input: unknown) {
    this.study = new SnapshotEventStudy(input);
  }
  run(input: unknown) {
    const request = EventControlsRequestSchema.parse(input),
      { study, controls } = request,
      cache = new Map<string, EventStudyPricePath>();
    let work = 0;
    const path = (
      series: EventStudySeries,
      from: typeof study.analysisAsOf,
      to: typeof study.analysisAsOf,
    ) => {
      const id = `${key(series)}|${from}|${to}`;
      let p = cache.get(id);
      if (!p) {
        work += elapsed(from, to) / study.intervalSeconds + 1;
        if (work > 250000) throw new Error('Controls work budget exceeded');
        p = this.study.observePath({
          series,
          from,
          to,
          intervalSeconds: study.intervalSeconds,
          analysisAsOf: study.analysisAsOf,
        });
        cache.set(id, p);
      }
      return p;
    };
    const allSeries = [
        ...new Map(
          [...study.assets, request.factor, ...request.basket.map((b) => b.series)].map((s) => [
            key(s),
            s,
          ]),
        ).values(),
      ],
      frame = (at: typeof study.analysisAsOf) =>
        new Map(
          allSeries.map((series) => [
            key(series),
            {
              pre: path(
                series,
                shift(at, -(request.fitLookbackBars + 1) * study.intervalSeconds),
                shift(at, -study.intervalSeconds),
              ),
              post: path(series, at, shift(at, request.horizonSeconds)),
            },
          ]),
        ),
      whole = (f: ReturnType<typeof frame>) =>
        [...f.values()].every(
          (p) => !p.pre.missingCloseTimes.length && !p.post.missingCloseTimes.length,
        ),
      blackouts = [
        ...this.study.input.newsSnapshot.input.graphRecords
          .filter((r) => r.action.kind === 'OBSERVE' && r.recordedAt <= study.analysisAsOf)
          .map((r) => r.recordedAt),
        ...study.events.map((e) => e.decisionAt),
      ],
      events: ResultEvent[] = [],
      excludedByTaxonomy: EventControlsResult['excludedByTaxonomy'] = [];
    for (const selection of study.events) {
      const event = newsEventResearchInputs(
        this.study.input.newsSnapshot,
        selection.decisionAt,
      ).events.find((e) => e.identity.id === selection.eventId);
      if (!event) throw new Error('Event unavailable at decision');
      const taxonomy = [
        ...new Set(
          this.study.input.newsSnapshot.input.graphRecords.flatMap((r) =>
            r.recordedAt <= selection.decisionAt && r.action.kind === 'OBSERVE'
              ? r.action.extraction.claims
                  .filter((c) => event.identity.claimIds.includes(c.id))
                  .map((c) => c.candidate.eventType)
              : [],
          ),
        ),
      ].sort();
      if (
        request.taxonomyFilter.length &&
        !taxonomy.some((t) => request.taxonomyFilter.includes(t))
      ) {
        excludedByTaxonomy.push(selection);
        continue;
      }
      const samplingSeed =
          (controls.seed ^ Number.parseInt(canonicalHash(selection).slice(7, 15), 16)) >>> 0,
        random = new SeededRandom(samplingSeed),
        observed = frame(selection.decisionAt),
        factor = observed.get(key(request.factor))!,
        cohortComplete = whole(observed),
        eventVol = pathVolatility(factor.pre),
        candidates: ResultEvent['candidates'] = [],
        eligible: {
          at: typeof study.analysisAsOf;
          f: ReturnType<typeof frame>;
          vol: ReturnType<typeof metric>;
        }[] = [];
      for (let at = controls.from; at <= controls.to; at = shift(at, controls.strideSeconds)) {
        let status: ResultEvent['candidates'][number]['status'] = 'ELIGIBLE_NOT_SAMPLED';
        const begin = shift(at, -(request.fitLookbackBars + 1) * study.intervalSeconds),
          end = shift(at, request.horizonSeconds);
        if (!cohortComplete) status = 'EVENT_INCOMPLETE';
        else if (end > this.study.input.newsSnapshot.request.decisionAt)
          status = 'AFTER_NEWS_CUTOFF';
        else if (
          blackouts.some(
            (t) =>
              shift(t, -controls.blackoutSeconds) <= end &&
              shift(t, request.horizonSeconds + controls.blackoutSeconds) >= begin,
          )
        )
          status = 'NEWS_BLACKOUT';
        else if (controls.timeOfDayToleranceSeconds !== null) {
          const day = 86400000000000n,
            difference = (utcNanoseconds(at) % day) - (utcNanoseconds(selection.decisionAt) % day),
            absolute = difference < 0n ? -difference : difference,
            circular = absolute < day - absolute ? absolute : day - absolute;
          if (circular > BigInt(controls.timeOfDayToleranceSeconds) * 1000000000n)
            status = 'TIME_OF_DAY_MISMATCH';
        }
        if (status === 'ELIGIBLE_NOT_SAMPLED') {
          const f = frame(at),
            vol = pathVolatility(f.get(key(request.factor))!.pre);
          if (!whole(f) || vol === null) status = 'INCOMPLETE_COVERAGE';
          else if (
            controls.volatilityTolerance !== null &&
            (eventVol === null || vol.minus(eventVol).abs().gt(controls.volatilityTolerance))
          )
            status = 'VOLATILITY_MISMATCH';
          else eligible.push({ at, f, vol: metric(vol) });
        }
        candidates.push({ at, status });
      }
      for (let i = eligible.length - 1; i > 0; i--) {
        const j = random.nextInt(i + 1);
        [eligible[i], eligible[j]] = [eligible[j]!, eligible[i]!];
      }
      const selected = eligible.slice(0, controls.sampleCount),
        selectedTimes = new Set(selected.map((s) => s.at));
      for (const c of candidates) if (selectedTimes.has(c.at)) c.status = 'SELECTED';
      const samples: ResultEvent['controls'] = selected.map((c) => ({
        at: c.at,
        preFactorVolatility: c.vol,
        evidenceBarIds: [
          ...new Set(
            [...c.f.values()].flatMap((p) => [...p.pre.bars, ...p.post.bars].map((b) => b.id)),
          ),
        ].sort(),
        responses: study.assets.map((series) => {
          const r = pathReturn(c.f.get(key(series))!.post)!;
          return { asset: series.asset, grossReturn: metric(r), absoluteReturn: metric(r.abs()) };
        }),
      }));
      const basket = request.basket.map((b) => ({
          r: pathReturn(observed.get(key(b.series))!.post),
          weight: b.weightBps,
        })),
        basketReturn = basket.some((b) => b.r === null)
          ? null
          : D.sum(...basket.map((b) => b.r!.mul(b.weight).div(10000)));
      work +=
        study.assets.length *
        request.lags.length *
        (request.fitLookbackBars + request.horizonSeconds / study.intervalSeconds);
      if (work > 250000) throw new Error('Controls work budget exceeded');
      const responses: ResultEvent['responses'] = study.assets.map((series) => {
        const p = observed.get(key(series))!,
          gross = pathReturn(p.post),
          fit = fitFactor(p.pre, factor.pre),
          factorReturn = pathReturn(factor.post);
        let btcBetaAdjustedReturn = null,
          marketModelAdjustedReturn = null,
          factorAdjustmentStatus: ResultEvent['responses'][number]['factorAdjustmentStatus'] =
            'INCOMPLETE';
        if (gross !== null && factorReturn !== null) {
          factorAdjustmentStatus = 'UNFITTED';
          if (fit.beta !== null && fit.alpha !== null) {
            btcBetaAdjustedReturn = metric(gross.minus(new D(fit.beta).mul(factorReturn)));
            const predicted = returnPoints(factor.post).map((p) =>
              new D(1).plus(fit.alpha).plus(new D(fit.beta).mul(p.value)),
            );
            if (predicted.some((p) => p.lte(0))) factorAdjustmentStatus = 'INVALID_PROJECTION';
            else {
              marketModelAdjustedReturn = metric(
                gross.minus(predicted.reduce((a, b) => a.mul(b), new D(1)).minus(1)),
              );
              factorAdjustmentStatus = 'COMPUTED';
            }
          }
        }
        const atLeastAsLarge =
          gross === null
            ? 0
            : samples.filter((s) =>
                new D(s.responses.find((r) => r.asset === series.asset)!.absoluteReturn!).gte(
                  metric(gross.abs()),
                ),
              ).length;
        return {
          series,
          coverage: coverage(p.post),
          grossReturn: gross === null ? null : metric(gross),
          netReturn:
            gross === null ? null : metric(gross.minus(new D(study.roundTripCostBps).div(10000))),
          absoluteReturn: gross === null ? null : metric(gross.abs()),
          fit,
          btcBetaAdjustedReturn,
          marketModelAdjustedReturn,
          factorAdjustmentStatus,
          relativeToBasket:
            gross === null || basketReturn === null ? null : metric(gross.minus(basketReturn)),
          recovery: recovery(p.post),
          lags: request.lags.flatMap((lag) => [
            lagCorrelation(p.pre, factor.pre, lag, 'PRE_EVENT'),
            lagCorrelation(p.post, factor.post, lag, 'POST_EVENT'),
          ]),
          baseline: {
            selectedControls: samples.length,
            atLeastAsLarge,
            frequency:
              gross === null || !samples.length
                ? null
                : metric(new D(atLeastAsLarge).div(samples.length)),
          },
        };
      });
      let overlappingControlPairs = 0;
      for (let i = 0; i < samples.length; i++)
        for (let j = i + 1; j < samples.length; j++)
          if (
            samples[i]!.at < shift(samples[j]!.at, request.horizonSeconds) &&
            samples[j]!.at < shift(samples[i]!.at, request.horizonSeconds)
          )
            overlappingControlPairs++;
      events.push({
        eventId: event.identity.id,
        decisionAt: selection.decisionAt,
        lineageIds: [
          ...new Set([
            ...event.identity.baseClusterIds,
            ...event.identity.parentIds,
            event.identity.id,
          ]),
        ].sort(),
        taxonomy,
        eventContextHash: canonicalHash(event),
        cohortComplete,
        samplingSeed,
        overlappingControlPairs,
        factorCoverage: coverage(factor.post),
        basketReturn: basketReturn === null ? null : metric(basketReturn),
        responses,
        candidates,
        controls: samples,
      });
    }
    const result = EventControlsResultSchema.parse({
      schemaVersion: 'event-controls-result.v1',
      execution: 'DISABLED',
      interpretation: 'DESCRIPTIVE_ASSOCIATION_NOT_CAUSAL_OR_EXECUTABLE',
      baselineScope: 'NO_OBSERVED_NEWS_IN_FROZEN_CORPUS_NOT_PROOF_OF_NO_EVENT',
      inputHash: this.study.inputHash,
      configHash: canonicalHash(request),
      request,
      events,
      excludedByTaxonomy,
      ...summarize(events, request.horizonSeconds),
    });
    deepFreeze(result);
    return result;
  }
}
