import { Decimal } from 'decimal.js';
import {
  EvaluationAttributionSchema,
  EvaluationPlanSchema,
  EvaluationReportSchema,
  PaperReportSchema,
  utcNanoseconds,
} from '@crypto/contracts';
import type { EvaluationPlan, EvaluationReport, PaperReport } from '@crypto/contracts';
import { canonicalHash, deepFreeze, deterministicId } from '@crypto/core';
import { verifyPaperReport } from '@crypto/paper';
import { measurePaper } from './paper-metrics.js';
import { evaluationUncertainty } from './uncertainty.js';
import { evaluationSensitivity } from './sensitivity.js';
import { metricAmount, formatEvaluationMetric } from './metrics.js';
import { auditPaperMarket } from './market-audit.js';
const D = Decimal.clone({ precision: 256 });

export function evaluationEvidence(paper: PaperReport, plan: EvaluationPlan) {
  paper = PaperReportSchema.parse(paper);
  plan = EvaluationPlanSchema.parse(plan);
  const objects = new Map<string, { id: string; value: unknown }>(),
    add = (id: string, value: unknown) => objects.set(canonicalHash(value), { id, value }),
    quoteIds = new Set([
      ...paper.fills.flatMap((f) => f.fill.evidenceIds),
      ...paper.decisions.flatMap((d) => d.request.risk.market.evidenceIds),
    ]);
  add('experiment:paper-config', paper.config);
  add('experiment:evaluation-plan', plan);
  for (const d of paper.decisions) {
    add(d.id, d);
    add(d.request.risk.candidate.id, d.request.risk.candidate);
    for (const e of d.request.evidence)
      add(e.id, {
        schemaVersion: 'external-evidence-reference.v1',
        ...e,
        contentStatus: 'REFERENCE_ONLY_ORIGINAL_SOURCE_BUNDLE_REQUIRED',
      });
  }
  for (const f of paper.fills) add(f.fill.id, f);
  for (const { event } of paper.log) if (quoteIds.has(event.id)) add(event.id, event);
  return [...objects]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([hash, v]) => ({
      id: v.id,
      hash,
      file: `evidence/${hash.slice(7)}.json`,
      value: v.value,
    }));
}
export function evaluatePaperExperiment(
  paperInput: unknown,
  planInput: unknown,
  codeVersion = 'evaluation.v1',
): EvaluationReport {
  const paper = verifyPaperReport(paperInput),
    plan = EvaluationPlanSchema.parse(planInput);
  if (
    !codeVersion ||
    codeVersion.length > 200 ||
    plan.frozenAt > paper.config.startAt ||
    plan.generatedAt < paper.now ||
    new Set(plan.opportunityGrid.map((g) => `${g.at}/${g.symbol}`)).size !==
      plan.opportunityGrid.length ||
    new Set(plan.scenarios.map((s) => s.id)).size !== plan.scenarios.length ||
    plan.opportunityGrid.some(
      (g) =>
        g.at < paper.config.startAt ||
        g.at >= paper.config.endAt ||
        !paper.config.instruments.some((i) => i.symbol === g.symbol),
    )
  )
    throw new Error('Evaluation freeze, cohort or generation mismatch');
  for (const d of paper.decisions)
    if (
      !plan.opportunityGrid.some(
        (g) =>
          g.at === d.request.risk.candidate.decisionAt &&
          g.symbol === d.request.risk.candidate.symbol,
      )
    )
      throw new Error('Decision outside predeclared opportunity grid');
  const grid = plan.opportunityGrid.filter((g) => g.at <= paper.now),
    metrics = measurePaper(paper, grid),
    uncertainty = evaluationUncertainty(metrics, plan),
    sensitivity = evaluationSensitivity(paper, plan),
    market = auditPaperMarket(paper, plan.marketObservationCadenceSeconds),
    strata: EvaluationReport['attribution']['strata'] = [];
  for (const m of metrics)
    for (const [dimension, key] of [
      ['ASSET', 'symbol'],
      ['MONTH', 'closedAt'],
      ['REGIME', 'regime'],
      ['NEWS_CATEGORY', 'newsCategory'],
      ['VOLATILITY_TIER', 'volatilityTier'],
    ] as const) {
      const groups = new Map<string, typeof m.trades>();
      for (const t of m.trades) {
        const v = key === 'closedAt' ? t.closedAt.slice(0, 7) : t[key],
          xs = groups.get(v) ?? [];
        xs.push(t);
        groups.set(v, xs);
      }
      for (const [value, trades] of groups)
        strata.push({
          dimension,
          value,
          portfolio: m.portfolio,
          closedTrades: trades.length,
          netPnl: metricAmount(trades.reduce((s, t) => s.plus(t.netPnl), new D(0))) as never,
          grossPnl: metricAmount(trades.reduce((s, t) => s.plus(t.grossPnl), new D(0))) as never,
          fees: metricAmount(trades.reduce((s, t) => s.plus(t.fees), new D(0))) as never,
        });
    }
  const conflicts: EvaluationReport['attribution']['conflicts'] = [];
  for (const n of paper.decisions.filter(
    (d) => d.request.risk.candidate.portfolio === 'NEWS_ONLY',
  )) {
    const c = n.request.risk.candidate,
      m = paper.decisions.find(
        (d) =>
          d.request.risk.candidate.portfolio === 'MARKET_ONLY' &&
          d.request.risk.candidate.decisionAt === c.decisionAt &&
          d.request.risk.candidate.symbol === c.symbol,
      )?.request.risk.candidate;
    if (m && c.side !== 'HOLD' && m.side !== 'HOLD' && c.side !== m.side)
      conflicts.push({
        symbol: c.symbol,
        at: c.decisionAt,
        newsCandidateId: c.id,
        marketCandidateId: m.id,
      });
  }
  const failureCounts = new Map<string, number>();
  for (const a of paper.alerts)
    if (/NEWS|SOURCE|LICENSE|QUARANTINED|CLOCK|METADATA/.test(a.code))
      failureCounts.set(a.code, (failureCounts.get(a.code) ?? 0) + 1);
  const attribution = EvaluationAttributionSchema.parse({
    strata,
    conflicts,
    calibration: metrics.map((m) => {
      const ds = paper.decisions.filter((d) => d.request.risk.candidate.portfolio === m.portfolio);
      return {
        portfolio: m.portfolio,
        boundKnown: ds.filter((d) => d.calibration === 'BOUND_KNOWN').length,
        uncalibrated: ds.filter((d) => d.calibration === 'UNCALIBRATED').length,
        brierScore: null,
        reason: 'NO_MATCHED_FROZEN_HORIZON_LABELS',
      };
    }),
    timing: paper.decisions.map((d) => {
      const c = d.request.risk.candidate,
        times = d.request.evidence
          .filter((e) => c.rationaleIds.includes(e.id))
          .map((e) => e.availableAt)
          .sort(),
        evidenceAvailableAt = times.at(-1) ?? null,
        firstFillAt =
          paper.fills.find(
            (f) =>
              f.fill.portfolio === c.portfolio &&
              paper.orders.find((o) => o.order.id === f.fill.orderId)?.decisionId === d.id,
          )?.fill.filledAt ?? null;
      return {
        candidateId: c.id,
        evidenceAvailableAt,
        firstFillAt,
        delaySeconds:
          evidenceAvailableAt && firstFillAt
            ? Number(utcNanoseconds(firstFillAt) - utcNanoseconds(evidenceAvailableAt)) / 1e9
            : null,
        basis: 'LATEST_REQUIRED_EVIDENCE_NOT_PUBLICATION',
      };
    }),
    provenanceFailures: [...failureCounts]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([code, count]) => ({ code, count })),
    marketCoverage: market.marketCoverage,
    newsCoverage: market.newsCoverage,
  });
  const warnings = [...new Set(uncertainty.diagnostics.perArm.flatMap((a) => a.warnings))];
  if (paper.config.origin === 'SYNTHETIC') warnings.push('SYNTHETIC_ONLY');
  if (paper.now < paper.config.endAt) warnings.push('INCOMPLETE_EXPERIMENT_PERIOD');
  if (market.marketCoverage === null || new D(market.marketCoverage).lt(plan.minimumCoverage))
    warnings.push('INSUFFICIENT_MARKET_COVERAGE');
  if (market.newsCoverage === null || new D(market.newsCoverage).lt(plan.minimumCoverage))
    warnings.push('MISSING_OR_LATE_NEWS_COVERAGE');
  if (market.benchmarks.buyAndHoldNetReturn === null)
    warnings.push('PASSIVE_BENCHMARK_UNAVAILABLE');
  warnings.push(
    'EXTERNAL_SOURCE_BUNDLES_MUST_BE_RESOLVED_FROM_CONTENT_HASHES',
    'DECLARED_SEARCH_HISTORY_NOT_AUTHENTICATED',
  );
  let recommendation: EvaluationReport['memo']['recommendation'] = 'REVISE';
  const reasons = [...warnings],
    hardStop =
      paper.alerts.some((a) =>
        [
          'RECONCILIATION_FAILED',
          'LICENSE_CHANGED',
          'INVALID_METADATA',
          'NEWS_SOURCE_VALIDATION_FAILED',
        ].includes(a.code),
      ) ||
      metrics.some((m) => m.maxDrawdown !== null && new D(m.maxDrawdown).gt(plan.maximumDrawdown));
  if (hardStop) {
    recommendation = 'STOP';
    reasons.push('PREDECLARED_SAFETY_OR_DRAWDOWN_FAILURE');
  } else if (
    paper.config.origin !== 'SYNTHETIC' &&
    paper.now === paper.config.endAt &&
    uncertainty.diagnostics.perArm
      .filter((a) => a.portfolio !== 'BASELINE')
      .every((a) => !a.warnings.length) &&
    market.marketCoverage !== null &&
    new D(market.marketCoverage).gte(plan.minimumCoverage) &&
    market.newsCoverage !== null &&
    new D(market.newsCoverage).gte(plan.minimumCoverage) &&
    metrics.every((m) => m.maxDrawdown !== null) &&
    uncertainty.pairedComparisons[0]!.status === 'CONDITIONAL_APPROXIMATION' &&
    uncertainty.pairedComparisons[0]!.lower !== null &&
    uncertainty.pairedComparisons[0]!.lower > Number(plan.minimumPairedDailyImprovement) &&
    sensitivity.every(
      (s) =>
        s.metrics.find((m) => m.portfolio === 'NEWS_ONLY')!.netPnl !== null &&
        new D(s.metrics.find((m) => m.portfolio === 'NEWS_ONLY')!.netPnl!).gt(0),
    )
  ) {
    recommendation = 'CONTINUE';
    reasons.push('CONTINUE_FORWARD_RESEARCH_ONLY_NOT_REAL_MONEY');
  } else reasons.push('INSUFFICIENT_EVIDENCE_REQUIRES_A_NEW_FROZEN_TEST');
  const evidence = evaluationEvidence(paper, plan).map(({ value: _, ...ref }) => {
      void _;
      return ref;
    }),
    body = {
      schemaVersion: 'evaluation-report.v1',
      execution: 'SIMULATED',
      origin: paper.config.origin,
      paperHash: canonicalHash(paper),
      manifestHash: paper.config.runManifestHash,
      plan,
      configHash: canonicalHash(plan),
      codeVersion,
      actualStartAt: paper.config.startAt,
      actualEndAt: paper.now,
      completePeriod: paper.now === paper.config.endAt,
      metrics,
      benchmarks: market.benchmarks,
      ...uncertainty,
      sensitivity,
      attribution,
      memo: { recommendation, reasons, alphaClaim: 'NOT_ESTABLISHED', realMoneyAuthorized: false },
      evidence,
      warnings,
    },
    withId = { ...body, id: deterministicId('evaluation-report', body) },
    report = EvaluationReportSchema.parse({ ...withId, hash: canonicalHash(withId) });
  deepFreeze(report);
  return report;
}
export function evaluationMarkdown(r: EvaluationReport) {
  r = EvaluationReportSchema.parse(r);
  const rows = r.metrics
    .map(
      (m) =>
        `| ${m.portfolio} | ${formatEvaluationMetric(m.netPnl)} | ${formatEvaluationMetric(m.netReturn)} | ${m.closedTrades} | ${formatEvaluationMetric(m.profitFactor)} | ${formatEvaluationMetric(m.maxDrawdown)} |`,
    )
    .join('\n');
  return `# Four-arm research evaluation\n\nSIMULATED — ${r.origin}. No statistically established alpha or real-money authorization.\n\nRecommendation: **${r.memo.recommendation}**.\n\n| Arm | Net PnL | Net return | Closed trades | Profit factor | Max drawdown |\n| --- | --- | --- | --- | --- | --- |\n${rows}\n\n${r.memo.reasons.map((x) => `- ${x}`).join('\n')}\n\nMissing/late source coverage, unbound calibration and tail concentration remain visible.\nSource timing means latest required evidence, not publication or factual truth.\n\n[Exact frozen input](input.json) · [Versioned report](report.json)\n\n${r.evidence.map((e) => `- [${e.id}](${e.file}) — ${e.hash}`).join('\n')}\n`;
}
export function verifyEvaluationReport(input: unknown, paperInput: unknown) {
  const r = EvaluationReportSchema.parse(input),
    rebuilt = evaluatePaperExperiment(paperInput, r.plan, r.codeVersion);
  if (canonicalHash(r) !== canonicalHash(rebuilt)) throw new Error('Evaluation semantic integrity');
  return rebuilt;
}
