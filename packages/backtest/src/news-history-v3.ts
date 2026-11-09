import { readFileSync } from 'node:fs';
import { canonicalHash } from '@crypto/core';
import { NewsV3Report, NewsV3Model } from '../../contracts/src/news-research-v3.js';
import type {
  V3Event,
  V3Model,
  V3Report,
  MinuteDiagnostic,
} from '../../contracts/src/news-research-v3.js';
import type {
  ResearchConfig,
  ResearchPlan,
  ResearchRule,
} from '../../contracts/src/news-research.js';
import type { MarketHistory } from '../../contracts/src/market-tests.js';
import { NewsResearchReport, NewsResearchSnapshot } from '../../contracts/src/news-research.js';
import { structureNewsV3, v3ReplayEvents, v3Coverage } from '../../research/src/news-events-v3.js';
import {
  newsHistorySamples,
  sampleStats,
  shiftNewsMonth,
  NEWS_HOUR,
} from '../../research/src/news-history-study.js';
import {
  replayNewsHistory,
  researchEffects,
  NEWS_RESEARCH_ENGINE_HASH,
} from './news-history-replay.js';

export const NEWS_V3_ENGINE_HASH = canonicalHash({
  version: 'structured-news.v3',
  legacyEngine: NEWS_RESEARCH_ENGINE_HASH,
  code: [
    './news-history-v3.ts',
    '../../research/src/news-events-v3.ts',
    '../../research/src/news-minute-windows.ts',
    '../../contracts/src/news-research-v3.ts',
  ].map((p) => readFileSync(new URL(p, import.meta.url), 'utf8')),
});
export const NEWS_V3_PROTOCOL = {
  version: 'structured-news.v3' as const,
  candidates: 6 as const,
  minimumSamples: [12, 20] as [12, 20],
  uncertaintyZ: 1.96 as const,
  costBuffer: 2 as const,
  purgeHours: 72 as const,
  minimumValidationTrades: 5 as const,
  hourlyComparison: true as const,
  minuteDiagnostics: 'SEPARATE_DESCRIPTIVE_REACTION_WINDOWS' as const,
  expectationProvider: 'NOT_CONFIGURED' as const,
};
export function v3Candidates(): ResearchConfig[] {
  return [4, 24, 72].flatMap((horizonHours) =>
    [12, 20].map((minSamples) => ({
      id: `V3-H${horizonHours}-N${minSamples}-CI95-C2`,
      horizonHours,
      minSamples,
      edgeBuffer: 2,
      uncertaintyZ: 1.96,
    })),
  );
}
export function fitNewsV3(
  events: V3Event[],
  history: MarketHistory,
  plan: ResearchPlan,
  config: ResearchConfig,
) {
  if (
    ![12, 20].includes(config.minSamples) ||
    ![4, 24, 72].includes(config.horizonHours) ||
    config.edgeBuffer !== 2 ||
    config.uncertaintyZ !== 1.96
  )
    throw new Error('V3 configuration violates the frozen evidence policy');
  const admitted = v3ReplayEvents(events),
    cutoff = plan.trainEnd - 72 * NEWS_HOUR;
  const samples = newsHistorySamples(
    admitted,
    history,
    config.horizonHours,
    plan.from,
    cutoff,
    plan.latencyMs,
  );
  const groups = [
    ...new Set(
      admitted
        .filter((e) => e.assets.includes(history.instrument.asset) && e.publishedAt < cutoff)
        .map((e) => e.group),
    ),
  ].sort();
  const rules: ResearchRule[] = [],
    evidence: V3Model['fitEvidence'] = [];
  for (const group of groups) {
    const rows = samples.filter((s) => s.event.group === group),
      stats = sampleStats(rows.map((s) => s.excess));
    const lowerEdge = Math.abs(stats.mean) - 1.96 * stats.standardError;
    const requiredEdge =
      2 *
      (2 * (Number(plan.feeRate) + Number(plan.slippage)) +
        Number(plan.shortBorrowHourly) * config.horizonHours);
    const side =
      rows.length >= config.minSamples && lowerEdge > requiredEdge
        ? stats.mean > 0
          ? 'LONG'
          : 'SHORT'
        : 'HOLD';
    rules.push({
      group,
      count: rows.length,
      side,
      meanExcessReturn: stats.mean,
      standardError: stats.standardError,
    });
    evidence.push({
      group,
      count: rows.length,
      minimum: config.minSamples,
      lowerEdge,
      requiredEdge,
      side,
    });
  }
  return { rules, evidence };
}
function selectV3(events: V3Event[], history: MarketHistory, plan: ResearchPlan) {
  const replay = v3ReplayEvents(events),
    candidates = v3Candidates().map((config) => {
      const fit = fitNewsV3(events, history, plan, config),
        evaluation = replayNewsHistory(history, replay, plan, config, fit.rules, 'VALIDATION');
      return {
        config,
        fit,
        validationPnl: evaluation.netPnl,
        validationTrades: evaluation.trades.length,
        score:
          evaluation.trades.length >= 5
            ? Number(evaluation.netPnl) - 2500 * evaluation.maxDrawdown
            : -1e9,
      };
    });
  const best = [...candidates].sort(
    (a, b) => b.score - a.score || a.config.id.localeCompare(b.config.id),
  )[0]!;
  const supported = best.score > 0;
  return {
    config: supported
      ? best.config
      : { ...v3Candidates()[0]!, id: 'V3-CASH-INSUFFICIENT-EVIDENCE' },
    fit: supported ? best.fit : { rules: [], evidence: best.fit.evidence },
    candidates: candidates.map(({ fit, ...rest }) => {
      void fit;
      return rest;
    }),
  };
}
export function buildV3Model(
  events: V3Event[],
  history: MarketHistory,
  plan: ResearchPlan,
): V3Model {
  const chosen = selectV3(events, history, plan),
    replay = v3ReplayEvents(events);
  const evaluations = (['TRAIN', 'VALIDATION', 'TEST'] as const).map((phase) =>
    replayNewsHistory(history, replay, plan, chosen.config, chosen.fit.rules, phase),
  );
  const double = replayNewsHistory(history, replay, plan, chosen.config, chosen.fit.rules, 'TEST', {
    costMultiplier: 2,
  });
  const delayed = replayNewsHistory(
    history,
    replay,
    plan,
    chosen.config,
    chosen.fit.rules,
    'TEST',
    { extraLatencyHours: 1 },
  );
  const walkForward = [2, 3, 4].map((month) => {
    const p = {
      ...plan,
      trainEnd: shiftNewsMonth(plan.from, month),
      validationEnd: shiftNewsMonth(plan.from, month + 1),
      to: shiftNewsMonth(plan.from, month + 2),
    };
    const fit = selectV3(events, history, p);
    return {
      trainEnd: p.trainEnd,
      validationEnd: p.validationEnd,
      testEnd: p.to,
      configId: fit.config.id,
      evaluation: replayNewsHistory(history, replay, p, fit.config, fit.fit.rules, 'TEST'),
    };
  });
  const holdReasons: Record<string, number> = {};
  for (const e of events.filter(
    (e) =>
      e.assets.includes(history.instrument.asset) &&
      (e.publishedAt === null || (e.publishedAt >= plan.from && e.publishedAt < plan.to)),
  ))
    if (e.gate !== 'ELIGIBLE_FOR_DESCRIPTIVE_ESTIMATION')
      holdReasons[e.gate] = (holdReasons[e.gate] ?? 0) + 1;
  if (!chosen.fit.rules.some((r) => r.side !== 'HOLD'))
    holdReasons.HOLD_INSUFFICIENT_INDEPENDENT_TRAINING_AND_VALIDATION = 1;
  const test = evaluations[2]!,
    rejectionReasons = [
      'This is the previously inspected archive, not an unseen or historically executable test.',
      'Current historical content/receipt times are not point-in-time verified; descriptive models cannot qualify for live use.',
    ];
  if (!test.trades.length)
    rejectionReasons.push(
      'V3 stayed in cash: no event group passed the evidence and validation gates. Cash is abstention, not a demonstrated profitable edge.',
    );
  if (test.trades.length < 5)
    rejectionReasons.push('Fewer than five independent final-period trades.');
  if (Number(test.netPnl) < 100)
    rejectionReasons.push('The +100 USDT final-period target was not reached.');
  if (Number(double.netPnl) <= 0 || Number(delayed.netPnl) <= 0)
    rejectionReasons.push(
      'A positive edge was not demonstrated under both doubled costs and one-hour extra latency.',
    );
  const body = {
    version: 'LEARNED_V3' as const,
    config: chosen.config,
    rules: chosen.fit.rules,
    trials: 6,
    candidates: chosen.candidates,
    evaluations,
    doubleCostTestPnl: double.netPnl,
    delayedTestPnl: delayed.netPnl,
    targetReachedDescriptively: Number(test.netPnl) >= 100,
    qualifiedForForwardTest: false as const,
    rejectionReasons,
    walkForward,
    holdReasons,
    fitEvidence: chosen.fit.evidence,
  };
  return NewsV3Model.parse({ ...body, modelHash: canonicalHash(body) });
}
export async function buildNewsV3Comparison(
  baselineInput: unknown,
  snapshotInput: unknown,
  baselineRunId: string,
  markets: { asset: MarketHistory['instrument']['asset']; history: MarketHistory; hash: string }[],
  minutes: MinuteDiagnostic[] = [],
  progress: (s: string) => void | Promise<void> = () => {},
  generatedAt = Date.now(),
): Promise<V3Report> {
  const baseline = NewsResearchReport.parse(baselineInput),
    snapshot = NewsResearchSnapshot.parse(snapshotInput);
  if (canonicalHash(snapshot) !== baseline.snapshotHash)
    throw new Error('V3 must use the frozen baseline news snapshot');
  const structured = structureNewsV3(snapshot, baseline.plan),
    rows: V3Report['rows'] = [];
  if (markets.length !== 10 || new Set(markets.map((m) => m.asset)).size !== 10)
    throw new Error('Complete V3 market universe required');
  for (const old of baseline.rows) {
    const coverage = v3Coverage(structured, snapshot, baseline.plan, old.asset);
    if (old.asset === 'USDT') {
      rows.push({ ...old, v3Coverage: coverage });
      continue;
    }
    const market = markets.find((m) => m.asset === old.asset);
    if (
      !market ||
      canonicalHash(market.history) !== market.hash ||
      market.hash !== old.marketHash ||
      market.history.origin !== 'PUBLIC_HISTORICAL' ||
      market.history.from !== baseline.plan.from ||
      market.history.to !== baseline.plan.to
    )
      throw new Error('V3 changed a frozen market input');
    await progress(
      `${old.asset}: structured V3, stricter evidence, cost gates and three walk-forward folds`,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    const model = buildV3Model(structured, market.history, baseline.plan);
    rows.push({
      ...old,
      models: [...old.models, model],
      v3Coverage: coverage,
      effects: researchEffects(v3ReplayEvents(structured), market.history, baseline.plan),
    });
  }
  const replay = v3ReplayEvents(structured, false),
    legacyIds = new Set(baseline.events.map((e) => e.id));
  return NewsV3Report.parse({
    ...baseline,
    version: 'news-history-comparison.v3',
    generatedAt,
    engineHash: NEWS_V3_ENGINE_HASH,
    baselineRunId,
    baselineReportHash: canonicalHash(baseline),
    baselineEngineHash: baseline.engineHash,
    protocolV3: NEWS_V3_PROTOCOL,
    rows,
    structuredEvents: structured,
    minuteDiagnostics: minutes,
    events: [...baseline.events, ...replay.filter((e) => !legacyIds.has(e.id))],
    limitations: [
      ...baseline.limitations,
      'Frozen V1/V2 models, trades, fees, source snapshot and market hashes are copied byte-for-byte; V3 has its own model and engine hash.',
      'V3 has no configured point-in-time economic forecast provider. Macro signals without verified pre-release expectations remain HOLD.',
      'The hourly strategy comparison retains the baseline execution assumptions. One-minute reaction windows are separate descriptive diagnostics, not additional strategy profits.',
      'V3 uses at least 12/20 independent training examples, a 95% approximate uncertainty margin, two-times cost buffer, 72-hour training purge and five validation trades. These thresholds do not prove profitability.',
    ].slice(0, 25),
  });
}
