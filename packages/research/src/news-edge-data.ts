import { NewsEdgeInputSchema, NewsEdgeRowSchema, utcNanoseconds } from '@crypto/contracts';
import type { EventStudySeries, NewsEdgeRow, UtcTimestamp } from '@crypto/contracts';
import { canonicalHash, deterministicId } from '@crypto/core';
import { buildNewsEventSnapshot, validateNewsEventSnapshot } from '@crypto/news';
import { hypothesisEvidence } from './hypothesis-registry.js';
import { SnapshotEventStudy } from './event-study.js';
import { ControlDecimal as D, metric, pathReturn, shift } from './event-control-math.js';

/** Materialize only the corpus actually knowable at the declared fitting cutoff. */
export function freezeNewsEdgeInput(input: unknown) {
  const parsed = NewsEdgeInputSchema.parse(input),
    asOf = parsed.plan.analysisAsOf;
  if (
    parsed.dataset.newsSnapshots.length > 8 ||
    parsed.dataset.observations.length > 128 ||
    parsed.dataset.marketBars.length > 20000 ||
    parsed.dataset.newsSnapshots.some(
      (s) =>
        s.input.graphRecords.length > 32 ||
        s.input.metadataRecords.length > 16 ||
        s.view.events.length > 16,
    )
  )
    throw new Error('News estimation input work budget');
  const hashes = new Map<string, string>();
  const newsSnapshots = parsed.dataset.newsSnapshots.map((raw) => {
    const source = validateNewsEventSnapshot(raw);
    const cutoff = source.request.decisionAt < asOf ? source.request.decisionAt : asOf;
    const prefix = buildNewsEventSnapshot(
      source.graphConfig,
      source.input.graphRecords,
      source.input.metadataRecords,
      source.config,
      { decisionAt: cutoff, generatedAt: asOf },
      source.codeVersion,
    );
    hashes.set(canonicalHash(source), canonicalHash(prefix));
    return prefix;
  });
  return NewsEdgeInputSchema.parse({
    ...parsed,
    dataset: {
      ...parsed.dataset,
      newsSnapshots,
      marketBars: parsed.dataset.marketBars.filter(
        (b) => b.provenance.capturedAt <= asOf && (b.availableAt === null || b.availableAt <= asOf),
      ),
      marketSnapshots: parsed.dataset.marketSnapshots,
      observations: parsed.dataset.observations
        .filter(
          (o) =>
            o.decisionAt <= asOf &&
            (o.kind !== 'HISTORICAL_DESCRIPTIVE' || o.provenance.capturedAt <= asOf),
        )
        .map((o) =>
          o.kind === 'POINT_IN_TIME'
            ? { ...o, snapshotHash: hashes.get(o.snapshotHash) ?? o.snapshotHash }
            : o,
        ),
    },
  });
}

/** Reuse the Module 06 exact-close outcome gate. Prices never become inference features. */
export function prepareNewsEdgeRows(input: unknown) {
  const frozen = freezeNewsEdgeInput(input),
    { plan, dataset } = frozen;
  const evidence = hypothesisEvidence(dataset),
    first = dataset.newsSnapshots[0];
  if (!first) throw new Error('News estimation requires validated event-study evidence');
  const study = new SnapshotEventStudy({
    schemaVersion: 'event-study-input.v1',
    newsSnapshot: first,
    bars: dataset.marketBars,
    marketSnapshots: dataset.marketSnapshots,
  });
  let work = 0;
  const measure = (
    series: EventStudySeries,
    from: UtcTimestamp,
    to: UtcTimestamp,
    cutoff: UtcTimestamp,
  ) => {
    work += Number((utcNanoseconds(to) - utcNanoseconds(from)) / 60000000000n) + 1;
    if (work > 100000) throw new Error('News estimation price work budget');
    const path = study.observePath({ series, from, to, intervalSeconds: 60, analysisAsOf: cutoff });
    return { value: pathReturn(path), ids: path.bars.map((b) => b.id) };
  };
  const paths = new Map<string, ReturnType<typeof measure>>();
  const cached = (
    series: EventStudySeries,
    from: UtcTimestamp,
    to: UtcTimestamp,
    cutoff: UtcTimestamp,
  ) => {
    const key = canonicalHash({ series, from, to, cutoff });
    let v = paths.get(key);
    if (!v) {
      v = measure(series, from, to, cutoff);
      paths.set(key, v);
    }
    return v;
  };
  const rows: NewsEdgeRow[] = [];
  for (const hypothesis of plan.hypotheses)
    for (const horizon of plan.horizonsSeconds)
      for (const phase of ['TRAIN', 'VALIDATION'] as const) {
        const period = phase === 'TRAIN' ? plan.training : plan.validation;
        const controls = plan.controlAnchors.flatMap((anchor) => {
          const from = shift(anchor, -plan.preWindowSeconds),
            end = shift(anchor, horizon);
          if (
            from < period.from ||
            end > period.to ||
            evidence.observations.some((e) => {
              if (
                e.observation.kind !== 'POINT_IN_TIME' ||
                e.availableAt === null ||
                e.availableAt > e.observation.decisionAt ||
                e.observation.decisionAt < period.from ||
                e.observation.decisionAt >= period.to
              )
                return false;
              const start = shift(e.observation.decisionAt, -plan.preWindowSeconds),
                stop = shift(e.observation.decisionAt, Math.max(...plan.horizonsSeconds));
              return from <= stop && start <= end;
            })
          )
            return [];
          const a = cached(hypothesis.series, anchor, end, period.to),
            b = cached(plan.benchmark, anchor, end, period.to),
            preA = cached(hypothesis.series, from, anchor, period.to),
            preB = cached(plan.benchmark, from, anchor, period.to);
          if (a.value === null || b.value === null || preA.value === null || preB.value === null)
            return [];
          return [
            {
              id: deterministicId('news-control', { series: hypothesis.series, anchor, horizon }),
              anchor,
              pre: preA.value.minus(preB.value),
              value: a.value.minus(b.value),
              ids: [...a.ids, ...b.ids, ...preA.ids, ...preB.ids],
            },
          ];
        });
        for (const e of evidence.observations) {
          const o = e.observation;
          if (
            !e.taxonomy.includes(hypothesis.eventType) ||
            o.decisionAt < period.from ||
            o.decisionAt >= period.to
          )
            continue;
          const from = shift(o.decisionAt, -plan.preWindowSeconds),
            endAt = shift(o.decisionAt, horizon);
          const base: NewsEdgeRow = {
            hypothesisId: hypothesis.id,
            horizonSeconds: horizon,
            observationId: o.id,
            eventId: o.eventId,
            phase,
            decisionAt: o.decisionAt,
            from,
            endAt,
            status: 'COMPLETE',
            contextHash: e.contextHash,
            sourceIds: e.sourceIds,
            lineageIds: e.lineageIds,
            controlIds: [],
            baselineReturns: [],
            barIds: [],
            grossReturn: null,
            benchmarkReturn: null,
            preNewsMove: null,
            baselineMean: null,
            excessReturn: null,
          };
          if (o.kind === 'HISTORICAL_DESCRIPTIVE') base.status = 'DESCRIPTIVE_ONLY';
          else if (
            !e.event?.active ||
            !e.event.replayEligible ||
            e.availableAt === null ||
            e.availableAt > o.decisionAt ||
            !['OBSERVED', 'ARCHIVED_CAPTURE'].includes(e.firstSeenQuality)
          )
            base.status = 'UNAVAILABLE_NEWS';
          else if (e.event.novelty.pattern !== hypothesis.recurrence)
            base.status = 'RECURRENCE_EXCLUDED';
          else if (shift(e.event.firstKnownAt, plan.decisionLagSeconds) !== o.decisionAt)
            base.status = 'DECISION_LAG_MISMATCH';
          else if (from < period.from || endAt > period.to) base.status = 'OUTCOME_OUTSIDE_PERIOD';
          if (base.status !== 'COMPLETE') {
            rows.push(base);
            continue;
          }
          const a = cached(hypothesis.series, o.decisionAt, endAt, period.to),
            b = cached(plan.benchmark, o.decisionAt, endAt, period.to),
            preA = cached(hypothesis.series, from, o.decisionAt, period.to),
            preB = cached(plan.benchmark, from, o.decisionAt, period.to);
          base.barIds = [...new Set([...a.ids, ...b.ids, ...preA.ids, ...preB.ids])].sort();
          if (a.value === null || b.value === null || preA.value === null || preB.value === null) {
            rows.push({ ...base, status: 'MISSING_PRICES' });
            continue;
          }
          const pre = preA.value.minus(preB.value),
            matched = controls
              .filter((c) => c.pre.minus(pre).abs().lte(plan.preMoveCaliper))
              .sort((x, y) => {
                const cmp = x.pre.minus(pre).abs().comparedTo(y.pre.minus(pre).abs());
                if (cmp) return cmp;
                const dx = utcNanoseconds(x.anchor) - utcNanoseconds(o.decisionAt);
                const dy = utcNanoseconds(y.anchor) - utcNanoseconds(o.decisionAt);
                const ax = dx < 0n ? -dx : dx,
                  ay = dy < 0n ? -dy : dy;
                return ax < ay ? -1 : ax > ay ? 1 : x.id.localeCompare(y.id);
              })
              .slice(0, plan.minimumMatchedControls);
          base.grossReturn = metric(a.value);
          base.benchmarkReturn = metric(b.value);
          base.preNewsMove = metric(pre);
          base.controlIds = matched.map((c) => c.id);
          base.baselineReturns = matched.map((c) => metric(c.value));
          base.barIds = [...new Set([...base.barIds, ...matched.flatMap((c) => c.ids)])].sort();
          if (matched.length < plan.minimumMatchedControls)
            base.status = 'INSUFFICIENT_MATCHED_CONTROLS';
          else {
            const baseline = D.sum(...matched.map((c) => c.value)).div(matched.length);
            base.baselineMean = metric(baseline);
            base.excessReturn = metric(a.value.minus(b.value).minus(baseline));
          }
          rows.push(NewsEdgeRowSchema.parse(base));
        }
      }
  return { input: frozen, rows };
}
