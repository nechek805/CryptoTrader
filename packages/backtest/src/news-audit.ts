import {
  NewsAuditInputSchema,
  NewsAuditReportSchema,
  NewsExplainedDecisionSchema,
  NewsEvaluationRowSchema,
  NewsExtractionArchiveSchema,
  NewsAuditHandoffSchema,
  utcNanoseconds,
  DecimalStringSchema,
} from '@crypto/contracts';
import type {
  NewsEvaluationRow,
  NewsAuditReport,
  NewsEventSnapshotSchema,
} from '@crypto/contracts';
import { canonicalHash, canonicalJson, deepFreeze, fromEpoch, SeededRandom } from '@crypto/core';
import { newsExtractionPrompt } from '@crypto/news';
import { hypothesisEvidence, SnapshotEventStudy } from '@crypto/research';
import {
  EstimatedNewsSignalProvider,
  validateNewsEdgeModel,
  explainNewsDecision,
} from '@crypto/strategies';
import { Decimal } from 'decimal.js';
import { replayNewsSignals } from './news-signal-replay.js';
const D = Decimal.clone({ precision: 96 });
const metric = (v: Decimal) => DecimalStringSchema.parse(v.toDecimalPlaces(36).toFixed());
const shift = (at: Parameters<typeof utcNanoseconds>[0], seconds: number) =>
  fromEpoch(utcNanoseconds(at) + BigInt(seconds) * 1000000000n, 'nanoseconds');
type Snapshot = ReturnType<typeof NewsEventSnapshotSchema.parse>;

export function newsEvaluationUnits(rows: NewsEvaluationRow[]) {
  const groups: NewsEvaluationRow[][] = [];
  for (const row of rows.filter((r) => r.status === 'COMPLETE')) {
    const joins = groups.filter((g) =>
      g.some(
        (v) =>
          row.decisionAt.slice(0, 10) === v.decisionAt.slice(0, 10) ||
          row.lineageIds.some((id) => v.lineageIds.includes(id)) ||
          row.barIds.some((id) => v.barIds.includes(id)) ||
          (row.decisionAt < v.endAt && v.decisionAt < row.endAt),
      ),
    );
    for (const g of joins) groups.splice(groups.indexOf(g), 1);
    groups.push([row, ...joins.flat()]);
  }
  return groups;
}
export function newsAuditMarkdown(r: NewsAuditReport) {
  const safe = (s: string) =>
    s
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('|', '&#124;')
      .replaceAll('`', '&#96;')
      .replace(/[[\]()!*_~#\\]/g, (c) => `&#${c.charCodeAt(0)};`)
      .replaceAll('\r', ' ')
      .replaceAll('\n', ' ');
  return `# News replay, explanations and held-out markouts\n\nExecution DISABLED. Price markouts with assumed costs; no fills, ledger PnL, factual probabilities or causal claim.\n\nModel ${r.modelHash}; TEST plan ${r.planHash}; log ${r.logHead}.\n\nAdversarial decisions ${r.adversarial.decisions.length}; total explanations ${r.frames.length}; measured TEST ${r.evaluation.measuredCount}/${r.evaluation.opportunityCount}; blocks ${r.evaluation.independentUnits}; assessment ${r.evaluation.assessment}.\n\n| Baseline | Mean paired delta | Conditional mean interval |\n| --- | --- | --- |\n${r.evaluation.comparisons.map((c) => `| ${c.baseline} | ${c.meanDelta ?? 'MISSING'} | ${c.interval ? `[${c.interval.lower}, ${c.interval.upper}]` : 'MISSING'} |`).join('\n')}\n\n## False positives and missed events\n\nThese are hindsight net-price classifications, never event-truth labels.\n\n| Observation | Side | News markout | Always-long markout | Outcome |\n| --- | --- | --- | --- | --- |\n${r.evaluation.rows.map((v) => `| ${safe(v.observationId)} | ${v.side} | ${v.newsMarkout ?? 'MISSING'} | ${v.longMarkout ?? 'MISSING'} | ${v.outcomeClass} |`).join('\n')}\n\n## Explained decisions\n\nSource quotations below are untrusted data. They cannot authorize actions or change producer policy.\n\n${r.frames.map((f) => `- ${safe(f.caseId)} at ${f.explanation.decisionAt}: ${f.decision.candidate.side}; age ${f.explanation.eventAgeSeconds ?? 'UNKNOWN'} seconds; roots ${f.decision.opinion.independentOrigins}; ${safe(f.explanation.reasons.join(', '))}. Snapshot ${f.explanation.snapshotHash}.\n${f.explanation.sourceReceipts.map((s) => `  - Quoted source ${safe(s.sourceId)}: &quot;${safe(s.quotedText)}&quot;; receipt ${s.firstObservedAt}; extraction ${s.extractionKnownAt}; ${safe(s.reviewReasons.join(', '))}.`).join('\n')}`).join('\n')}\n\n${r.warnings.map((w) => `- ${safe(w)}`).join('\n')}\n`;
}

export async function runNewsAudit(raw: unknown, codeVersion: string) {
  const input = NewsAuditInputSchema.parse(raw),
    model = validateNewsEdgeModel((raw as { model: unknown }).model),
    modelHash = canonicalHash(model),
    { plan, dataset, requests } = input.evaluation;
  if (canonicalHash(input.model) !== modelHash)
    throw new Error('News audit model binding mismatch');
  if (
    !codeVersion ||
    codeVersion.length > 200 ||
    model.availableAt > plan.declaredAt ||
    model.dataVintage >= plan.from ||
    model.input.plan.validation.to > plan.from ||
    plan.roundTripCostBps < model.input.plan.roundTripCostBps
  )
    throw new Error('Invalid news TEST freeze, model vintage or cost floor');
  if (
    dataset.newsSnapshots.length > 8 ||
    dataset.marketBars.length > 20000 ||
    dataset.observations.length > 128
  )
    throw new Error('News audit work budget');
  const snapshots = new Map<string, Snapshot>(),
    frames: ReturnType<typeof NewsExplainedDecisionSchema.parse>[] = [];
  if (
    input.rules.generatedAt > plan.generatedAt ||
    dataset.newsSnapshots.some(
      (s) => s.request.generatedAt > plan.generatedAt || s.request.decisionAt > plan.to,
    )
  )
    throw new Error('News audit input exceeds frozen report cutoff');
  const archive = new Map<
    string,
    ReturnType<typeof NewsExtractionArchiveSchema.parse>['rows'][number]
  >();
  const archiveSnapshot = (s: Snapshot) => {
    for (const r of s.input.graphRecords)
      if (r.action.kind === 'OBSERVE') {
        const e = r.action.extraction,
          hash = canonicalHash(e),
          known =
            e.promptHash === canonicalHash(newsExtractionPrompt) &&
            e.adapter.promptVersion === newsExtractionPrompt.version;
        archive.set(hash, {
          extractionHash: hash,
          articleVersionId: e.input.article.version.versionId,
          sourceId: e.input.source.id,
          modelVersion: e.adapter.modelVersion,
          promptHash: e.promptHash,
          promptVersion: e.adapter.promptVersion,
          exactPrompt: known ? newsExtractionPrompt.instructions : null,
          fallback: 'literal-news-grammar.v1',
          status: e.status,
          costStatus: e.cost.status,
          amountUsd: e.cost.amount,
          sourceInputHash: e.inputHash,
        });
      }
  };
  for (const c of input.rules.cases) archiveSnapshot(c.snapshot);
  for (const s of dataset.newsSnapshots) archiveSnapshot(s);
  for (const s of model.input.dataset.newsSnapshots) archiveSnapshot(s);
  const adversarial = await replayNewsSignals(input.rules, codeVersion, {
    snapshot: (id, s) => {
      snapshots.set(id, s as Snapshot);
      return Promise.resolve();
    },
    decision: (row) => {
      const snapshot = snapshots.get(row.snapshotHash)!;
      frames.push(
        NewsExplainedDecisionSchema.parse({
          caseId: row.caseId,
          decision: row.decision,
          prediction: null,
          explanation: explainNewsDecision({
            snapshot,
            decision: row.decision,
            prediction: null,
            roundTripCostBps: plan.roundTripCostBps,
            uncertaintyBufferBps: 0,
          }),
        }),
      );
      return Promise.resolve();
    },
  });
  const evidence = hypothesisEvidence(dataset),
    byId = new Map(evidence.observations.map((e) => [e.observation.id, e]));
  const requested = new Map(requests.map((r) => [r.observationId, r.request]));
  if (
    new Set(
      requests.map(
        (r) => `${r.request.hypothesisId}|${r.request.query.eventId}|${r.request.query.decisionAt}`,
      ),
    ).size !== requests.length
  )
    throw new Error('Duplicate TEST event opportunity');
  const cohort = evidence.observations
    .filter((e) => e.observation.decisionAt >= plan.from && e.observation.decisionAt < plan.to)
    .map((e) => e.observation.id)
    .sort();
  if (
    requested.size !== requests.length ||
    canonicalHash([...requested.keys()].sort()) !==
      canonicalHash([...plan.opportunityIds].sort()) ||
    canonicalHash(cohort) !== canonicalHash([...plan.opportunityIds].sort())
  )
    throw new Error('Incomplete or changed declared TEST opportunity set');
  const trainingLineage = new Set(
      model.rows.filter((r) => r.status === 'COMPLETE').flatMap((r) => r.lineageIds),
    ),
    trainingBars = new Set(
      model.rows.filter((r) => r.status === 'COMPLETE').flatMap((r) => r.barIds),
    );
  const sourceByHash = new Map(dataset.newsSnapshots.map((s) => [canonicalHash(s), s]));
  const providers = new Map<
    string,
    {
      provider: EstimatedNewsSignalProvider;
      state: ReturnType<EstimatedNewsSignalProvider['initialState']>;
      sourceHash: string;
    }
  >();
  const prices = new SnapshotEventStudy({
    schemaVersion: 'event-study-input.v1',
    newsSnapshot: dataset.newsSnapshots[0],
    bars: dataset.marketBars,
    marketSnapshots: dataset.marketSnapshots,
  });
  const rows: NewsEvaluationRow[] = [];
  const ordered = [...requests].sort(
    (a, b) =>
      a.request.query.decisionAt.localeCompare(b.request.query.decisionAt) ||
      a.observationId.localeCompare(b.observationId),
  );
  for (const item of ordered) {
    const e = byId.get(item.observationId)!,
      o = e.observation,
      r = item.request,
      q = r.query,
      h = model.input.plan.hypotheses.find((h) => h.id === r.hypothesisId),
      fit = model.fits.find((f) => f.hypothesisId === r.hypothesisId && f.selectedOnTraining);
    if (
      !h ||
      !fit ||
      fit.side === 'HOLD' ||
      fit.horizonSeconds !== plan.horizonSeconds ||
      r.state ||
      q.eventId !== o.eventId ||
      q.decisionAt !== o.decisionAt ||
      q.symbol !== h.series.instrumentId ||
      r.roundTripCostBps !== plan.roundTripCostBps ||
      (o.kind === 'POINT_IN_TIME' &&
        (canonicalHash(r.snapshot) !== o.snapshotHash || !sourceByHash.has(o.snapshotHash)))
    )
      throw new Error('TEST scope, frozen horizon or request binding mismatch');
    if (e.lineageIds.some((id) => trainingLineage.has(id)))
      throw new Error('TEST lineage overlaps model fitting evidence');
    const endAt = shift(q.decisionAt, plan.horizonSeconds);
    if (endAt > plan.to) throw new Error('TEST outcome exceeds declared period');
    const key = r.hypothesisId,
      sourceHash = canonicalHash(r.snapshot);
    let slot = providers.get(key);
    if (!slot) {
      const provider = new EstimatedNewsSignalProvider(model, r.hypothesisId, r.snapshot);
      slot = { provider, state: provider.initialState(), sourceHash };
      providers.set(key, slot);
    } else if (slot.sourceHash !== sourceHash) {
      const provider = new EstimatedNewsSignalProvider(model, r.hypothesisId, r.snapshot);
      if (provider.providerHash !== slot.state.providerHash)
        throw new Error('TEST provider policy changed');
      slot.provider = provider;
      slot.sourceHash = sourceHash;
    }
    const result = slot.provider.evaluate(q, slot.state, plan.roundTripCostBps);
    slot.state = result.state;
    const snapshot = slot.provider.snapshotAt(q.decisionAt),
      snapshotHash = canonicalHash(snapshot);
    snapshots.set(snapshotHash, snapshot);
    frames.push(
      NewsExplainedDecisionSchema.parse({
        caseId: o.id,
        decision: result.decision,
        prediction: result.prediction,
        explanation: explainNewsDecision({
          snapshot,
          decision: result.decision,
          prediction: result.prediction,
          roundTripCostBps: plan.roundTripCostBps,
          uncertaintyBufferBps: model.input.plan.uncertaintyBufferBps,
        }),
      }),
    );
    const available =
      o.kind === 'POINT_IN_TIME' &&
      e.event?.active &&
      e.event.replayEligible &&
      e.availableAt !== null &&
      e.availableAt <= q.decisionAt;
    const path = prices.observePath({
      series: h.series,
      from: q.decisionAt,
      to: endAt,
      intervalSeconds: 60,
      analysisAsOf: plan.to,
    });
    if (path.bars.some((b) => trainingBars.has(b.id)))
      throw new Error('TEST prices overlap fitting evidence');
    const gross =
        path.missingCloseTimes.length || !available
          ? null
          : new D(path.bars.at(-1)!.close).div(path.bars[0]!.close).minus(1),
      cost = new D(plan.roundTripCostBps).div(10000),
      side = result.decision.candidate.side;
    const news =
        gross === null
          ? null
          : side === 'HOLD'
            ? new D(0)
            : gross.mul(side === 'LONG' ? 1 : -1).minus(cost),
      long = gross?.minus(cost) ?? null;
    const reference = gross?.mul(fit.side === 'LONG' ? 1 : -1).minus(cost) ?? null;
    const outcomeClass =
      gross === null
        ? 'UNMEASURED'
        : side === 'HOLD'
          ? reference!.gt(0)
            ? 'MISSED_EVENT'
            : 'CORRECT_ABSTENTION'
          : news!.gt(0)
            ? 'TRUE_POSITIVE'
            : 'FALSE_POSITIVE';
    rows.push(
      NewsEvaluationRowSchema.parse({
        observationId: o.id,
        decisionId: result.decision.candidate.id,
        decisionAt: q.decisionAt,
        endAt,
        symbol: q.symbol,
        side,
        referenceSide: fit.side,
        status: !available ? 'UNAVAILABLE_NEWS' : gross === null ? 'MISSING_PRICES' : 'COMPLETE',
        lineageIds: e.lineageIds,
        barIds: path.bars.map((b) => b.id),
        grossReturn: gross === null ? null : metric(gross),
        newsMarkout: news === null ? null : metric(news),
        longMarkout: long === null ? null : metric(long),
        cashMarkout: gross === null ? null : '0',
        deltaVsLong: news === null ? null : metric(news.minus(long!)),
        deltaVsCash: news === null ? null : metric(news),
        outcomeClass,
        outcomeKnowledge: 'HINDSIGHT_PRICE_OUTCOME_NOT_EVENT_TRUTH',
      }),
    );
  }
  const units = newsEvaluationUnits(rows),
    complete = rows.filter((r) => r.status === 'COMPLETE').length,
    random = new SeededRandom(plan.seed);
  const comparisons: NewsAuditReport['evaluation']['comparisons'] = [];
  for (const baseline of ['CASH', 'ALWAYS_LONG'] as const) {
    const values = units.map((g) =>
      D.sum(...g.map((r) => (baseline === 'CASH' ? r.deltaVsCash! : r.deltaVsLong!))).div(g.length),
    );
    const meanDelta = values.length ? metric(D.sum(...values).div(values.length)) : null;
    let interval: NewsAuditReport['evaluation']['comparisons'][number]['interval'] = null;
    if (units.length >= plan.minimumUnits && complete === rows.length) {
      const draws: Decimal[] = [];
      for (let i = 0; i < plan.bootstrapSamples; i++) {
        let sum = new D(0);
        for (let j = 0; j < values.length; j++)
          sum = sum.plus(values[random.nextInt(values.length)]!);
        draws.push(sum.div(values.length));
      }
      draws.sort((a, b) => a.comparedTo(b));
      const tail = Math.floor((plan.bootstrapSamples - 1) / 80);
      interval = {
        lower: metric(draws[tail]!),
        upper: metric(draws[plan.bootstrapSamples - 1 - tail]!),
        nominalLevel: DecimalStringSchema.parse('0.975'),
        familySize: 2,
        method: 'UTC_DAY_LINEAGE_WINDOW_BLOCK_BOOTSTRAP.v1',
      };
    }
    comparisons.push({ baseline, meanDelta, interval });
  }
  const extractionArchive = NewsExtractionArchiveSchema.parse({
    schemaVersion: 'news-extraction-archive.v1',
    prompt: newsExtractionPrompt,
    rows: [...archive.values()].sort((a, b) => a.extractionHash.localeCompare(b.extractionHash)),
  });
  const warnings = [
    'Evaluation is a fixed later TEST cohort after model fitting/validation. Its outcomes never select, refit or change the news producer.',
    'These are paired price markouts with assumed round-trip costs, not filled trades, account equity, executable SHORTs or net PnL. No live execution or promotion is authorized.',
    'CASH and ALWAYS_LONG read no news. They use the same predeclared news-conditioned opportunity grid, horizon, coverage, cost assumptions and unit weighting. This is not an unconditional buy-and-hold portfolio comparison.',
    'False positives and missed events use hindsight signed net-price outcomes, not event truth; missing coverage is never replaced by a zero return.',
    'Untrusted source text is quoted evidence only. Recognized instruction-like input is quarantined; a pattern guard cannot detect every possible adversarial wording. No source text is evaluated or used as a command.',
    'UTC-day, lineage, shared-price and overlapping-window blocks reduce duplicated evidence. Bootstrap mean intervals are conditional, noncausal and do not establish population coverage or protection from unreported tests.',
    'Default news, prices, labels, source roles and declaration clocks are synthetic. No real historical incremental edge or authentic preregistration is claimed.',
    'Prompt/model hashes identify archived extraction recipes and costs. Unknown external extraction costs or unavailable exact prompts remain unknown; a deterministic no-LLM fallback is retained.',
  ];
  const handoff = NewsAuditHandoffSchema.parse({
    schemaVersion: 'news-module11-handoff.v1',
    target: 'MODULE_11_ITERATION_1',
    execution: 'DISABLED',
    defaultAction: 'HOLD',
    modelHash,
    planHash: canonicalHash(plan),
    extractionArchiveHash: canonicalHash(extractionArchive),
    providerPorts: ['NewsSignalProvider', 'EstimatedNewsSignalProvider'],
    promotion: 'NOT_AUTHORIZED',
    warnings,
  });
  let head = canonicalHash({
    schemaVersion: 'news-audit-log.v1',
    inputHash: canonicalHash(input),
    codeVersion,
  });
  const journal = frames.map((body, i) => {
    const value = { sequence: i + 1, body, previousHash: head };
    head = canonicalHash(value);
    return { ...value, hash: head };
  });
  const synthetic =
    model.synthetic ||
    dataset.marketBars.some((b) => b.provenance.origin === 'FIXTURE') ||
    dataset.newsSnapshots.some((s) =>
      s.input.graphRecords.some(
        (r) =>
          r.action.kind === 'OBSERVE' &&
          r.action.extraction.input.article.version.document.provenance.origin === 'FIXTURE',
      ),
    ) ||
    dataset.observations.some(
      (o) => o.kind === 'HISTORICAL_DESCRIPTIVE' && o.provenance.origin === 'FIXTURE',
    );
  const report = NewsAuditReportSchema.parse({
    schemaVersion: 'news-audit-report.v1',
    execution: 'DISABLED',
    interpretation: 'PAIRED_PRICE_MARKOUT_NOT_FILL_PNL_OR_CAUSAL',
    codeVersion,
    inputHash: canonicalHash(input),
    modelHash,
    planHash: canonicalHash(plan),
    adversarial,
    frames,
    evaluation: {
      rows,
      opportunityCount: rows.length,
      measuredCount: complete,
      independentUnits: units.length,
      unitMembers: units.map((g) => g.map((r) => r.observationId).sort()),
      comparisons,
      falsePositives: rows
        .filter((r) => r.outcomeClass === 'FALSE_POSITIVE')
        .map((r) => r.observationId),
      missedEvents: rows
        .filter((r) => r.outcomeClass === 'MISSED_EVENT')
        .map((r) => r.observationId),
      assessment: synthetic
        ? 'SYNTHETIC_ONLY'
        : comparisons.some((c) => !c.interval)
          ? 'INSUFFICIENT_EVIDENCE'
          : comparisons.every((c) => new D(c.interval!.lower).gt(0))
            ? 'CONDITIONAL_POSITIVE_MARKOUT_ONLY'
            : 'NO_INCREMENTAL_VALUE',
    },
    snapshotHashes: [...snapshots.keys()].sort(),
    extractionArchiveHash: canonicalHash(extractionArchive),
    handoffHash: canonicalHash(handoff),
    logHead: head,
    warnings,
  });
  deepFreeze(report);
  deepFreeze(extractionArchive);
  deepFreeze(handoff);
  return {
    input,
    report,
    snapshots,
    extractionArchive,
    handoff,
    journal: journal.map((r) => `${canonicalJson(r)}\n`).join(''),
  };
}
