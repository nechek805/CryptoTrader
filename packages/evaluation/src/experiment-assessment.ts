import { Decimal } from 'decimal.js';
import { TrialAssessmentSchema, utcNanoseconds } from '@crypto/contracts';
import type { TrialRun, TrialAssessment } from '@crypto/contracts';
import { canonicalHash, deepFreeze } from '@crypto/core';
import { PaperBroker } from '@crypto/paper';
import { verifyTrialRun, trialAnnotationHead } from './experiment-runtime.js';
import { evaluatePaperExperiment } from './report.js';
const D = Decimal.clone({ precision: 256 });
const assessedRuns = new WeakMap<TrialRun, TrialAssessment>();

function passiveBasket(run: TrialRun) {
  const broker = new PaperBroker(run.paper.config),
    first = new Map<string, { ask: string; at: string; id: string }>();
  for (const l of run.paper.log) {
    broker.consume(l.event);
    for (const i of broker.config.instruments) {
      const q = broker.quoteAt(i.symbol);
      if (q && !first.has(i.symbol)) first.set(i.symbol, { ask: q.ask, at: q.at, id: q.id });
    }
  }
  const cfg = broker.config;
  return cfg.instruments.map((i) => {
    const a = first.get(i.symbol),
      b = broker.quoteAt(i.symbol),
      eligible = !!a && !!b;
    return {
      symbol: i.symbol,
      weight: new D(1).div(cfg.instruments.length).toFixed(18),
      firstQuoteId: a?.id ?? null,
      lastQuoteId: b?.id ?? null,
      startAt: a?.at ?? null,
      endAt: b?.at ?? null,
      netReturn: eligible
        ? new D(b.bid)
            .mul(new D(1).minus(new D(cfg.slippageBps).div(10000)))
            .mul(new D(1).minus(cfg.takerRate))
            .div(
              new D(a.ask)
                .mul(new D(1).plus(new D(cfg.slippageBps).div(10000)))
                .mul(new D(1).plus(cfg.takerRate)),
            )
            .minus(1)
            .toFixed(18)
        : null,
      status: eligible ? 'OBSERVED_ENDPOINTS_NOT_CONTINUOUS_DRAWDOWN' : 'MISSING_ENDPOINT',
      policy: 'EQUAL_INITIAL_VIRTUAL_CAPITAL_PER_ASSET_FROZEN_FEES_AND_SLIPPAGE',
    };
  });
}
export function assessExperiment(input: unknown): TrialAssessment {
  const run = verifyTrialRun(input),
    cached = assessedRuns.get(run);
  if (cached) return cached;
  const paper = run.paper,
    m = run.manifest,
    p = m.protocol,
    evaluation = evaluatePaperExperiment(paper, p.evaluation, p.codeVersion),
    restartCount = run.annotations.filter((a) => a.kind === 'RESTART').length,
    actualElapsed30Days =
      p.origin === 'PUBLIC_READ_ONLY' &&
      run.wallClockStartedAt !== null &&
      run.wallClockFinishedAt !== null &&
      utcNanoseconds(run.wallClockFinishedAt) - utcNanoseconds(run.wallClockStartedAt) >=
        30n * 86400n * 1000000000n &&
      paper.now === p.paper.endAt &&
      paper.status === 'STOPPED',
    days = Array.from(new Set(evaluation.metrics.flatMap((v) => v.daily.map((d) => d.day)))).sort(),
    daily = days.map((day) => {
      const rows = evaluation.metrics.map((v) => ({
          portfolio: v.portfolio,
          ...v.daily.find((d) => d.day === day),
        })),
        log = paper.log.filter((l) => l.event.at.slice(0, 10) === day),
        slots = p.evaluation.opportunityGrid.filter(
          (g) => g.at.slice(0, 10) === day && g.at <= paper.now,
        ),
        decisions = paper.decisions.filter(
          (d) => d.request.risk.candidate.decisionAt.slice(0, 10) === day,
        );
      return {
        day,
        portfolios: rows,
        expectedArmSlots: slots.length * 4,
        recordedCandidates: decisions.length,
        missingArmSlots: Math.max(0, slots.length * 4 - decisions.length),
        holds: decisions.filter((d) => d.request.risk.candidate.side === 'HOLD').length,
        riskVetoes: decisions.filter(
          (d) => !d.risk.decision.allowed && d.request.risk.candidate.side !== 'HOLD',
        ).length,
        virtualFills: paper.fills.filter((f) => f.fill.filledAt.slice(0, 10) === day).length,
        reconciliationRecorded: log.some((l) => l.event.kind === 'RECONCILE'),
        alerts: paper.alerts
          .filter((a) => a.at.slice(0, 10) === day)
          .map((a) => ({ code: a.code, sourceId: a.sourceId })),
        sourceClock: 'UTC_OBSERVATION_AND_AVAILABILITY',
        logHashes: log.length ? { first: log[0]!.hash, last: log.at(-1)!.hash } : null,
      };
    }),
    weeklyQa = Array.from({ length: Math.ceil(days.length / 7) }, (_, i) => {
      const selected = daily.slice(i * 7, (i + 1) * 7);
      return {
        week: i + 1,
        days: selected.map((d) => d.day),
        partialWeek: selected.length < 7,
        missingArmSlots: selected.reduce((s, d) => s + d.missingArmSlots, 0),
        dailyReconciliationComplete: selected.every((d) => d.reconciliationRecorded),
        flags: [...new Set(selected.flatMap((d) => d.alerts.map((a) => a.code)))],
        immutableLogHead: paper.logHead,
        sourceUncertainty: 'OBSERVATION_COVERAGE_IS_NOT_NEWS_CORPUS_COMPLETENESS',
      };
    }),
    news = paper.decisions.filter((d) =>
      ['NEWS_ONLY', 'FUSION'].includes(d.request.risk.candidate.portfolio),
    ),
    missedIds = new Set(
      run.annotations
        .filter((a) => a.kind === 'CORROBORATION_DELAY' && a.outcome === 'HOLD')
        .flatMap((a) => a.affectedCandidateIds),
    ),
    missed = news.filter((d) => missedIds.has(d.request.risk.candidate.id)),
    unresolved = news.some(
      (d) =>
        d.request.evidence.some((e) => d.request.risk.candidate.rationaleIds.includes(e.id)) &&
        !run.annotations.some(
          (a) =>
            a.kind === 'CORROBORATION_DELAY' &&
            a.affectedCandidateIds.includes(d.request.risk.candidate.id),
        ),
    ),
    hardRiskBreach =
      evaluation.metrics.some((v) =>
        v.daily.some(
          (d) =>
            d.netReturn !== null &&
            new D(d.netReturn).lte(new D(p.riskPolicy.risk.dailyLossFraction).neg()),
        ),
      ) ||
      paper.equity.some(
        (e) =>
          e.exposureFraction !== null &&
          new D(e.exposureFraction).gt(p.riskPolicy.risk.maxGrossFraction),
      ),
    corrupt = paper.alerts.some((a) =>
      /RECONCILIATION_FAILED|CONFLICTING_PROVIDER_ID|SOURCE_VALIDATION_FAILED|LICENSE_CHANGED|INVALID_METADATA/.test(
        a.code,
      ),
    ),
    missingSlots = daily.some((d) => d.missingArmSlots > 0),
    recommendation =
      corrupt || hardRiskBreach || evaluation.memo.recommendation === 'STOP'
        ? 'STOP'
        : actualElapsed30Days &&
            !missingSlots &&
            !unresolved &&
            !restartCount &&
            evaluation.memo.recommendation === 'CONTINUE'
          ? 'CONTINUE_FORWARD_TEST'
          : 'REVISE_AND_RESET',
    continuitySummary = {
      paperHash: canonicalHash(paper),
      logHead: paper.logHead,
      metrics: evaluation.metrics,
      warning: 'No PnL splice or counterfactual price interpolation',
    },
    body = {
      schemaVersion: 'trial-assessment.v1',
      execution: 'SIMULATED',
      origin: p.origin,
      experimentId: m.manifest.id,
      manifestHash: m.hash,
      runHash: canonicalHash(run),
      annotationHead: trialAnnotationHead(run.annotations),
      actualElapsed30Days,
      evaluation,
      daily,
      weeklyQa,
      incidents: [...run.annotations, ...paper.alerts],
      continuity: {
        interrupted: restartCount > 0,
        restartCount,
        continuousAnalysis: restartCount ? null : continuitySummary,
        interruptedAnalysis: restartCount
          ? {
              ...continuitySummary,
              segments: run.annotations.filter(
                (a) => a.kind === 'SESSION_START' || a.kind === 'RESTART',
              ),
              downtimeIntervals: run.annotations
                .filter((a) => a.kind === 'RESTART')
                .map((a) => ({
                  from: a.intervalStart,
                  to: a.intervalEnd,
                  certainty: a.intervalStart === a.intervalEnd ? 'UNKNOWN_NOT_ZERO' : 'RECORDED',
                })),
            }
          : null,
      },
      corroborationDelay: {
        missedSignals: missed.length,
        eligibleNewsCandidates: news.length,
        missedFraction: unresolved
          ? null
          : news.length
            ? new D(missed.length).div(news.length).toFixed(18)
            : null,
        status: !news.length
          ? 'NO_NEWS_CANDIDATES'
          : unresolved
            ? 'UNRESOLVED_EVIDENCE'
            : 'MEASURED',
      },
      passiveBasket: passiveBasket(run),
      recommendation,
      alphaClaim: 'NOT_ESTABLISHED',
      realMoneyAuthorized: false,
      reasons: [
        ...(hardRiskBreach ? ['HARD_SIMULATED_RISK_BREACH_STOP_AND_INVESTIGATE'] : []),
        ...evaluation.memo.reasons,
        ...(!actualElapsed30Days ? ['NOT_AN_ELAPSED_30_DAY_FORWARD_STUDY'] : []),
        ...(restartCount ? ['INTERRUPTED_ANALYSIS_NO_CONTINUOUS_COUNTERFACTUAL'] : []),
        ...(unresolved ? ['CORROBORATION_DELAY_DENOMINATOR_OR_REASONS_UNRESOLVED'] : []),
        ...(missingSlots ? ['MISSING_FROZEN_OPPORTUNITIES'] : []),
      ],
      futureHypotheses: [
        'Priority 1: validate licensed news latency and independent-origin coverage in a new frozen test',
        'Priority 2: test gap/latency-aware cost robustness with an expanded point-in-time sample',
        'Priority 3: evaluate multilingual dependence/entity errors on separately labelled future data',
      ],
    };
  const result = TrialAssessmentSchema.parse({ ...body, hash: canonicalHash(body) });
  deepFreeze(result);
  assessedRuns.set(run, result);
  return result;
}
export function experimentFindingsMarkdown(a: TrialAssessment) {
  a = TrialAssessmentSchema.parse(a);
  return `# Experiment findings\n\nSIMULATED · ${a.origin}. Actual elapsed 30-day forward study: ${a.actualElapsed30Days}.\n\nRecommendation: **${a.recommendation}**. Alpha: NOT_ESTABLISHED. No real-money authorization.\n\n| Arm | Net PnL | Closed trades | Drawdown | Fees |\n| --- | --- | --- | --- | --- |\n${a.evaluation.metrics.map((m) => `| ${m.portfolio} | ${m.netPnl ?? 'N/A'} | ${m.closedTrades} | ${m.maxDrawdown ?? 'N/A'} | ${m.fees} |`).join('\n')}\n\nCash comparator: zero return. Equal-capital per-asset passive endpoint comparisons are in assessment.json; missing endpoints remain unknown. Confidence bounds, paired blocks, cost/latency sensitivity, stop/target outcomes, calendar/asset decomposition and source failures remain in the linked evaluation.\n\nCorroboration delay missed fraction: ${a.corroborationDelay.missedFraction ?? 'N/A'} (${a.corroborationDelay.status}). Evidence confirmation is separate from profit prediction.\n\nRestart count: ${a.continuity.restartCount}. Continuous and interrupted analyses are separate; no counterfactual prices fill downtime.\n\n${a.reasons.map((r) => `- ${r}`).join('\n')}\n\n## Immutable evidence\n\n[Protocol and manifest](manifest.json) · [Exact run and raw events](run.json) · [Assessment](assessment.json)\n\nExperiment ${a.experimentId}\n\nManifest ${a.manifestHash}\n\nRun ${a.runHash}\n\nAssessment ${a.hash}\n\nEvaluation ${a.evaluation.hash}\n\nAnnotation head ${a.annotationHead}\n\n## Ranked future hypotheses\n\n${a.futureHypotheses.map((h) => `- ${h}`).join('\n')}\n\nThese are future research proposals. Post-hoc edits cannot improve or replace the frozen trial. Any code/parameter change requires a new experiment ID. A month cannot establish robust profitability.\n`;
}
