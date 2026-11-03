import {
  NewsEdgeModelSchema,
  NewsSignalConfigSchema,
  NewsEdgePredictionSchema,
  NewsSignalQuerySchema,
  SignalCandidateSchema,
  NewsSignalDecisionSchema,
  NewsSignalStateSchema,
  NewsEventSnapshotSchema,
  utcNanoseconds,
} from '@crypto/contracts';
import type {
  NewsEdgePlan,
  NewsEdgeFit,
  NewsEdgeModel,
  NewsEdgeRow,
  NewsSignalState,
} from '@crypto/contracts';
import { canonicalHash, deterministicId, deepFreeze, fromEpoch } from '@crypto/core';
import { prepareNewsEdgeRows } from '@crypto/research';
import { NewsSignalProvider } from './news-signals.js';
import type { NewsSignalProvider as ProviderPort } from './news-signals.js';
import {
  EdgeDecimal as D,
  edgeMetric,
  newsEdgeStatistics,
  newsEdgeMargin,
} from './news-edge-statistics.js';

// Only locally constructed, deeply frozen model instances can skip a second refit.
const trustedModels = new WeakSet<object>();

function admission(
  plan: NewsEdgePlan,
  id: string,
  horizon: number,
  side: 'LONG' | 'SHORT' = 'LONG',
) {
  const h = plan.hypotheses.find((h) => h.id === id);
  if (!h) throw new Error('Unknown conditional news hypothesis');
  const rule = plan.admission.rules.find((r) => r.eventType === h.eventType)!;
  return NewsSignalConfigSchema.parse({
    ...plan.admission,
    symbols: plan.admission.symbols.filter((s) => s.symbol === h.series.instrumentId),
    requireFirstSeen: h.recurrence === 'FIRST_SEEN_IN_CORPUS',
    rules: [
      { ...rule, id: `estimated:${id}`, side, horizonSeconds: horizon + plan.decisionLagSeconds },
    ],
  });
}
function missing(symbol: string, decisionAt: string) {
  const body = {
    schemaVersion: 'news-freshness-veto.v1',
    policy: 'VETO_ONLY_NO_DIRECTION_OR_PRICE_V1',
    symbol,
    decisionAt,
    status: 'MISSING',
    barId: null,
    closeAt: null,
    availableAt: null,
    sourceIds: [],
    metadataIds: [],
  };
  return { ...body, proofHash: canonicalHash(body) };
}
export function trainNewsEdge(input: unknown, codeVersion: string): NewsEdgeModel {
  if (!codeVersion || codeVersion.length > 200)
    throw new Error('Invalid news estimation software version');
  const prepared = prepareNewsEdgeRows(input),
    { plan, dataset } = prepared.input;
  const policyHash = dataset.newsSnapshots[0]!.configHash;
  if (dataset.newsSnapshots.some((s) => s.configHash !== policyHash))
    throw new Error('Incompatible news estimation policies');
  const providers = new Map<string, InstanceType<typeof NewsSignalProvider>>();
  const observations = new Map(dataset.observations.map((o) => [o.id, o]));
  const snapshots = new Map(dataset.newsSnapshots.map((s) => [canonicalHash(s), s]));
  const admissionResults = new Map<string, boolean>();
  const rows = prepared.rows.map((r): NewsEdgeRow => {
    if (r.status !== 'COMPLETE') return r;
    const o = observations.get(r.observationId),
      h = plan.hypotheses.find((h) => h.id === r.hypothesisId)!;
    if (o?.kind !== 'POINT_IN_TIME') throw new Error('Descriptive label cannot enter a news fit');
    const admissionKey = `${r.hypothesisId}|${r.observationId}`;
    const cached = admissionResults.get(admissionKey);
    if (cached !== undefined)
      return cached
        ? r
        : { ...r, status: 'NEWS_ADMISSION_REJECTED', grossReturn: null, excessReturn: null };
    const key = `${o.snapshotHash}|${r.hypothesisId}`;
    let p = providers.get(key);
    if (!p) {
      p = new NewsSignalProvider(
        admission(plan, r.hypothesisId, Math.max(...plan.horizonsSeconds)),
        snapshots.get(o.snapshotHash),
        codeVersion,
      );
      providers.set(key, p);
    }
    const d = p.evaluate(
      {
        schemaVersion: 'news-signal-query.v1',
        decisionAt: r.decisionAt,
        eventId: r.eventId,
        symbol: h.series.instrumentId,
        freshness: missing(h.series.instrumentId, r.decisionAt),
      },
      p.initialState(),
    ).decision;
    admissionResults.set(admissionKey, d.opinion.conditionalSide !== 'HOLD');
    return d.opinion.conditionalSide === 'HOLD'
      ? { ...r, status: 'NEWS_ADMISSION_REJECTED', grossReturn: null, excessReturn: null }
      : r;
  });
  const train = rows.filter((r) => r.phase === 'TRAIN' && r.status === 'COMPLETE'),
    validation = rows.filter((r) => r.phase === 'VALIDATION' && r.status === 'COMPLETE');
  const lineage = new Set(train.flatMap((r) => r.lineageIds)),
    prices = new Set(train.flatMap((r) => r.barIds));
  if (
    validation.some(
      (r) => r.lineageIds.some((id) => lineage.has(id)) || r.barIds.some((id) => prices.has(id)),
    )
  )
    throw new Error('Cross-phase news lineage, control or outcome reuse');
  const family = plan.hypotheses.length * plan.horizonsSeconds.length * 4;
  let resampleWork = 0;
  const fits: NewsEdgeFit[] = [];
  for (const h of plan.hypotheses)
    for (const horizon of plan.horizonsSeconds) {
      const stats = (phase: 'TRAIN' | 'VALIDATION') => {
        const sample = rows.filter(
          (r) => r.hypothesisId === h.id && r.horizonSeconds === horizon && r.phase === phase,
        );
        resampleWork += sample.length * plan.bootstrapSamples;
        if (resampleWork > 1000000) throw new Error('News estimation resampling work budget');
        const seed =
          (plan.seed ^
            Number.parseInt(canonicalHash({ id: h.id, horizon, phase }).slice(7, 15), 16)) >>>
          0;
        return newsEdgeStatistics(
          sample,
          phase === 'TRAIN' ? plan.minimumTrainingUnits : plan.minimumValidationUnits,
          plan.bootstrapSamples,
          seed,
          family,
        );
      };
      const training = stats('TRAIN'),
        validation = stats('VALIDATION');
      const side =
        training.meanExcess === null || new D(training.meanExcess).isZero()
          ? 'HOLD'
          : new D(training.meanExcess).gt(0)
            ? 'LONG'
            : 'SHORT';
      const trainingMargin = newsEdgeMargin(
          training,
          side,
          plan.roundTripCostBps,
          plan.uncertaintyBufferBps,
        ),
        validationMargin = newsEdgeMargin(
          validation,
          side,
          plan.roundTripCostBps,
          plan.uncertaintyBufferBps,
        );
      fits.push({
        hypothesisId: h.id,
        horizonSeconds: horizon,
        side,
        training,
        validation,
        trainingMargin,
        validationMargin,
        selectedOnTraining: false,
        reasons: [
          ...(trainingMargin === null
            ? [
                side === 'HOLD' && training.uncertaintyReason === null
                  ? 'ZERO_TRAINING_EXCESS'
                  : 'INSUFFICIENT_TRAINING_EVIDENCE',
              ]
            : new D(trainingMargin).lte(0)
              ? ['TRAINING_EDGE_BELOW_COST_AND_UNCERTAINTY']
              : []),
          ...(validationMargin === null
            ? [
                side === 'HOLD' && validation.uncertaintyReason === null
                  ? 'NO_TRAINING_DIRECTION'
                  : 'INSUFFICIENT_VALIDATION_EVIDENCE',
              ]
            : new D(validationMargin).lte(0)
              ? ['VALIDATION_EDGE_BELOW_COST_AND_UNCERTAINTY']
              : []),
        ],
      });
    }
  for (const h of plan.hypotheses) {
    // Selection reads TRAIN only. A failed holdout cannot trigger a different horizon.
    const chosen = fits
      .filter(
        (f) =>
          f.hypothesisId === h.id && f.trainingMargin !== null && new D(f.trainingMargin).gt(0),
      )
      .sort(
        (a, b) =>
          new D(b.trainingMargin!).comparedTo(a.trainingMargin!) ||
          a.horizonSeconds - b.horizonSeconds,
      )[0];
    if (chosen) chosen.selectedOnTraining = true;
  }
  const synthetic =
    dataset.observations.some(
      (o) => o.kind === 'HISTORICAL_DESCRIPTIVE' && o.provenance.origin === 'FIXTURE',
    ) ||
    dataset.marketBars.some((b) => b.provenance.origin === 'FIXTURE') ||
    dataset.newsSnapshots.some((s) =>
      s.input.graphRecords.some(
        (r) =>
          r.action.kind === 'OBSERVE' &&
          r.action.extraction.input.article.version.document.provenance.origin === 'FIXTURE',
      ),
    );
  const model = NewsEdgeModelSchema.parse({
    schemaVersion: 'news-edge-model.v1',
    execution: 'DISABLED',
    interpretation: 'CONDITIONAL_ASSOCIATION_NOT_FACTUAL_CONFIDENCE_OR_EXECUTION',
    codeVersion,
    input: prepared.input,
    inputHash: canonicalHash(prepared.input),
    planHash: canonicalHash(plan),
    synthetic,
    dataVintage: plan.analysisAsOf,
    availableAt: plan.availableAt,
    rows,
    fits,
    warnings: [
      'Direction and horizon are selected on TRAIN only; later validation gates that fixed choice without fallback or refitting.',
      'Gross price returns are not fills or PnL. Drift uses a predeclared unit-beta benchmark; excess additionally subtracts matched non-event baseline returns. Costs are conservative assumed round-trip costs, not an execution model.',
      'Pre-news relative moves match historical controls only; no live price feature enters news direction. Recurrence is an explicit observed-corpus stratum, not global novelty.',
      'Connected lineage, overlapping pre/outcome windows and shared price/control evidence define sampling blocks. Conditional mean bootstrap intervals are not causal estimates, population guarantees or individual prediction intervals.',
      'Multiplicity includes both metrics and phases for every predeclared hypothesis/horizon. Unreported trials, regimes and source-selection biases are not corrected by these intervals.',
      'Synthetic or mixed fixture evidence remains diagnostic only and cannot promote a strategy. Declared chronology is not authenticated historical preregistration.',
      'No event-truth probability, stops, orders, borrowing, leverage or live execution. Calibrated return probabilities remain missing.',
    ],
  });
  deepFreeze(model);
  trustedModels.add(model);
  return model;
}
export function validateNewsEdgeModel(input: unknown) {
  if (typeof input === 'object' && input !== null && trustedModels.has(input))
    return input as NewsEdgeModel;
  const m = NewsEdgeModelSchema.parse(input),
    expected = trainNewsEdge(m.input, m.codeVersion);
  if (canonicalHash(m) !== canonicalHash(expected))
    throw new Error('News edge model semantic integrity mismatch');
  return expected;
}

export class EstimatedNewsSignalProvider implements ProviderPort {
  readonly model: NewsEdgeModel;
  readonly modelHash: string;
  readonly providerHash: string;
  readonly config;
  readonly #base: InstanceType<typeof NewsSignalProvider>;
  readonly #fit: NewsEdgeFit | null;
  constructor(
    modelInput: unknown,
    readonly hypothesisId: string,
    snapshot: unknown,
  ) {
    this.model = validateNewsEdgeModel(modelInput);
    this.modelHash = canonicalHash(this.model);
    const plan = this.model.input.plan;
    if (!plan.hypotheses.some((h) => h.id === hypothesisId))
      throw new Error('Unknown news edge hypothesis');
    const source = NewsEventSnapshotSchema.parse(snapshot);
    if (source.configHash !== this.model.input.dataset.newsSnapshots[0]!.configHash)
      throw new Error('Inference news policy differs from fitted definitions');
    this.#fit =
      this.model.fits.find((f) => f.hypothesisId === hypothesisId && f.selectedOnTraining) ??
      this.model.fits.find((f) => f.hypothesisId === hypothesisId) ??
      null;
    this.config = admission(
      plan,
      hypothesisId,
      this.#fit?.horizonSeconds ?? plan.horizonsSeconds[0]!,
      this.#fit?.side === 'SHORT' ? 'SHORT' : 'LONG',
    );
    this.#base = new NewsSignalProvider(this.config, source, `news-edge:${this.modelHash}`);
    this.config = this.#base.config;
    this.providerHash = this.#base.providerHash;
  }
  initialState() {
    return this.#base.initialState();
  }
  snapshotAt(at: unknown) {
    return this.#base.snapshotAt(at);
  }
  evaluate(
    queryInput: unknown,
    stateInput: unknown,
    roundTripCostBps = this.model.input.plan.roundTripCostBps,
  ) {
    if (!Number.isInteger(roundTripCostBps) || roundTripCostBps < 0 || roundTripCostBps > 10000)
      throw new Error('Invalid news inference cost assumption');
    const q = NewsSignalQuerySchema.parse(queryInput);
    if (q.decisionAt < this.model.availableAt)
      throw new Error('News edge model not yet available at decision');
    const before = NewsSignalStateSchema.parse(stateInput),
      base = this.#base.evaluate(q, before),
      fit = this.#fit,
      plan = this.model.input.plan;
    const event = this.snapshotAt(q.decisionAt).view.events.find(
      (e) => e.identity.id === q.eventId,
    );
    const reasons = [...base.decision.abstentionReasons];
    if (!fit?.selectedOnTraining) reasons.push('INSUFFICIENT_TRAINING_EDGE');
    else reasons.push(...fit.reasons);
    if (
      !event ||
      event.novelty.pattern !== plan.hypotheses.find((h) => h.id === this.hypothesisId)!.recurrence
    )
      reasons.push('RECURRENCE_OUT_OF_SCOPE');
    if (
      event &&
      utcNanoseconds(q.decisionAt) - utcNanoseconds(event.firstKnownAt) !==
        BigInt(plan.decisionLagSeconds) * 1000000000n
    )
      reasons.push('DECISION_LAG_OUT_OF_SCOPE');
    const cost = Math.max(roundTripCostBps, plan.roundTripCostBps);
    const margin = fit
      ? newsEdgeMargin(fit.validation, fit.side, cost, plan.uncertaintyBufferBps)
      : null;
    const trainMargin = fit
      ? newsEdgeMargin(fit.training, fit.side, cost, plan.uncertaintyBufferBps)
      : null;
    if (
      margin === null ||
      new D(margin).lte(0) ||
      trainMargin === null ||
      new D(trainMargin).lte(0)
    )
      reasons.push('EDGE_BELOW_COST_AND_UNCERTAINTY');
    const side = reasons.length ? 'HOLD' : base.decision.candidate.side;
    const prediction = NewsEdgePredictionSchema.parse({
      schemaVersion: 'news-edge-prediction.v1',
      modelHash: this.modelHash,
      hypothesisId: this.hypothesisId,
      decisionAt: q.decisionAt,
      dataVintage: this.model.dataVintage,
      modelAvailableAt: this.model.availableAt,
      synthetic: this.model.synthetic,
      side,
      horizonSeconds: fit?.horizonSeconds ?? null,
      trainingSampleSize: fit?.training.completeCount ?? 0,
      validationSampleSize: fit?.validation.completeCount ?? 0,
      trainingUnits: fit?.training.independentUnits ?? 0,
      validationUnits: fit?.validation.independentUnits ?? 0,
      expectedGrossReturn: fit?.validation.meanGross ?? null,
      expectedExcessReturn: fit?.validation.meanExcess ?? null,
      grossInterval: fit?.validation.grossInterval ?? null,
      excessInterval: fit?.validation.excessInterval ?? null,
      conservativeNetEdge:
        margin === null || trainMargin === null ? null : edgeMetric(D.min(margin, trainMargin)),
      eventSupportGrade: base.decision.opinion.supportGrade,
      eventTruthProbability: null,
      reasons: [...new Set(reasons)],
    });
    const original = base.decision.candidate,
      holdUntil = fromEpoch(
        utcNanoseconds(q.decisionAt) + BigInt(plan.admission.holdValiditySeconds) * 1000000000n,
        'nanoseconds',
      );
    const body = {
      ...original,
      strategyId: 'news:estimated-event-edge',
      version: '1',
      side,
      horizon:
        side === 'HOLD'
          ? { value: plan.admission.holdValiditySeconds, unit: 'seconds' }
          : original.horizon,
      validUntil: side === 'HOLD' ? holdUntil : original.validUntil,
      rationaleIds: [
        ...new Set([...original.rationaleIds, this.modelHash, canonicalHash(prediction)]),
      ],
      reproducibility: {
        ...original.reproducibility,
        datasetHashes: [...original.reproducibility.datasetHashes, this.modelHash],
        codeVersion: this.model.codeVersion,
        modelVersion: 'matched-news-block-means.v1',
        randomSeed: plan.seed,
        feeAssumptionsHash: canonicalHash({
          execution: 'DISABLED',
          roundTripCostBps: cost,
          uncertaintyBufferBps: plan.uncertaintyBufferBps,
        }),
      },
    };
    const candidate = SignalCandidateSchema.parse({
      ...body,
      id: deterministicId('news-edge-signal', { body, priorStateHash: canonicalHash(before) }),
    });
    const state: NewsSignalState =
      side === 'HOLD' ? { ...before, lastDecisionAt: q.decisionAt } : base.state;
    const decision = NewsSignalDecisionSchema.parse({
      ...base.decision,
      candidate,
      stateHash: canonicalHash(state),
      abstentionReasons: prediction.reasons,
    });
    deepFreeze(state);
    deepFreeze(decision);
    deepFreeze(prediction);
    return { state, decision, prediction };
  }
}
