import { readFileSync } from 'node:fs';
import { canonicalHash } from '@crypto/core';
import { NewsV4Report, NewsV4Model } from '../../contracts/src/news-research-v4.js';
import type {
  V4Event,
  V4Model,
  V4Report,
  V4Corpus,
  LongMarketManifest,
} from '../../contracts/src/news-research-v4.js';
import { NewsV3Report } from '../../contracts/src/news-research-v3.js';
import { NewsResearchModel } from '../../contracts/src/news-research.js';
import type {
  ResearchEvent,
  ResearchPlan,
  ResearchConfig,
  ResearchRule,
} from '../../contracts/src/news-research.js';
import type { MarketAsset } from '../../contracts/src/market-tests.js';
import type { NewsLongPrices } from '../../research/src/news-long-history.js';
import { legacyNewsPrices } from '../../research/src/news-long-history.js';
import {
  newsHistorySamples,
  sampleStats,
  shiftNewsMonth,
  NEWS_HOUR,
} from '../../research/src/news-history-study.js';
import {
  legacyHistoryEvents,
  legacyV3Events,
  structureNewsV4,
} from '../../research/src/news-events-v4.js';
import { v3Coverage, v3ReplayEvents } from '../../research/src/news-events-v3.js';
import { buildV3Model, v3Candidates, NEWS_V3_ENGINE_HASH } from './news-history-v3.js';
import {
  replayNewsHistory,
  newsResearchCandidates,
  fitNewsResearchRules,
  NEWS_RESEARCH_ENGINE_HASH,
} from './news-history-replay.js';

export const NEWS_V4_ENGINE_HASH = canonicalHash({
  version: 'news-history.v4',
  legacy: NEWS_RESEARCH_ENGINE_HASH,
  v3: NEWS_V3_ENGINE_HASH,
  code: [
    './news-history-v4.ts',
    '../../research/src/news-events-v4.ts',
    '../../research/src/news-long-history.ts',
    '../../research/src/free-news-history.ts',
    '../../connectors/src/free-news-sources.ts',
    '../../news/src/live-source-catalog.ts',
    '../../contracts/src/news-research-v4.ts',
  ].map((p) => readFileSync(new URL(p, import.meta.url), 'utf8')),
});
export const NEWS_V4_PROTOCOL = {
  months: 36,
  trainingMonths: 24,
  validationMonths: 6,
  testMonths: 6,
  feeMode: 'ON',
  candidates: 6,
  minimumSamples: [12, 20],
  uncertaintyZ: 1.96,
  costBuffer: 2,
  validationTrades: 5,
  macroFeature: 'LAGGED_RELEASE_DEVIATION_NOT_MARKET_CONSENSUS',
  execution: 'HOURLY_BASELINE_ASSUMPTIONS',
  selection: 'FIXED_UNIVERSE_ALREADY_INSPECTED_HOLDOUT',
} as const;
export const v4Candidates = () =>
  v3Candidates().map((c) => ({ ...c, id: c.id.replace('V3-', 'V4-') }));
export function v4ReplayEvents(events: V4Event[]): ResearchEvent[] {
  return events
    .filter(
      (e) =>
        e.publishedAt !== null &&
        e.gate === 'ELIGIBLE_FOR_DESCRIPTIVE_ESTIMATION' &&
        e.featureSign !== 0,
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
      group: e.group + ':SIGN' + e.featureSign,
      fixedSide: 'HOLD',
      scope: e.scope,
      timing: 'DESCRIPTIVE_PUBLICATION_PROXY',
    }));
}
export function fitNewsV4(
  events: V4Event[],
  prices: NewsLongPrices,
  plan: ResearchPlan,
  config: ResearchConfig,
) {
  if (
    ![12, 20].includes(config.minSamples) ||
    ![4, 24, 72].includes(config.horizonHours) ||
    config.edgeBuffer !== 2 ||
    config.uncertaintyZ !== 1.96
  )
    throw new Error('V4 frozen evidence policy');
  const replay = v4ReplayEvents(events),
    map = new Map(events.map((e) => [e.id, e]));
  const samples = newsHistorySamples(
    replay.map((e) => ({ ...e, group: map.get(e.id)!.group })),
    legacyNewsPrices(prices),
    config.horizonHours,
    plan.from,
    plan.trainEnd - 72 * NEWS_HOUR,
    plan.latencyMs,
  );
  const groups = [
    ...new Set(
      events
        .filter(
          (e) =>
            e.assets.includes(prices.instrument.asset) &&
            e.gate === 'ELIGIBLE_FOR_DESCRIPTIVE_ESTIMATION' &&
            e.publishedAt !== null &&
            e.publishedAt < plan.trainEnd - 72 * NEWS_HOUR,
        )
        .map((e) => e.group),
    ),
  ].sort();
  const rules: ResearchRule[] = [],
    evidence: V4Model['fitEvidence'] = [];
  for (const group of groups) {
    const rows = samples.filter((s) => map.get(s.event.id)!.group === group),
      stats = sampleStats(rows.map((s) => s.excess * map.get(s.event.id)!.featureSign));
    const lowerEdge = Math.abs(stats.mean) - 1.96 * stats.standardError;
    const requiredEdge =
      2 *
      (2 * (Number(plan.feeRate) + Number(plan.slippage)) +
        Number(plan.shortBorrowHourly) * config.horizonHours);
    const supported = rows.length >= config.minSamples && lowerEdge > requiredEdge;
    evidence.push({
      group,
      count: rows.length,
      minimum: config.minSamples,
      lowerEdge,
      requiredEdge,
      side: supported ? (stats.mean > 0 ? 'LONG' : 'SHORT') : 'HOLD',
    });
    for (const sign of [-1, 1])
      rules.push({
        group: group + ':SIGN' + sign,
        count: rows.length,
        side: supported ? (stats.mean * sign > 0 ? 'LONG' : 'SHORT') : 'HOLD',
        meanExcessReturn: stats.mean * sign,
        standardError: stats.standardError,
      });
  }
  return { rules, evidence };
}
function selectV4(events: V4Event[], prices: NewsLongPrices, plan: ResearchPlan) {
  const replay = v4ReplayEvents(events),
    market = legacyNewsPrices(prices);
  const candidates = v4Candidates().map((config) => {
    const fit = fitNewsV4(events, prices, plan, config),
      e = replayNewsHistory(market, replay, plan, config, fit.rules, 'VALIDATION');
    return {
      config,
      fit,
      validationPnl: e.netPnl,
      validationTrades: e.trades.length,
      score: e.trades.length >= 5 ? Number(e.netPnl) - 2500 * e.maxDrawdown : -1e9,
    };
  });
  const best = [...candidates].sort(
    (a, b) => b.score - a.score || a.config.id.localeCompare(b.config.id),
  )[0]!;
  return {
    config:
      best.score > 0 ? best.config : { ...v4Candidates()[0]!, id: 'V4-CASH-INSUFFICIENT-EVIDENCE' },
    fit: best.score > 0 ? best.fit : { rules: [], evidence: best.fit.evidence },
    candidates: candidates.map(({ fit, ...c }) => {
      void fit;
      return c;
    }),
  };
}
export function buildV4Model(
  events: V4Event[],
  prices: NewsLongPrices,
  plan: ResearchPlan,
): V4Model {
  const selected = selectV4(events, prices, plan),
    replay = v4ReplayEvents(events),
    market = legacyNewsPrices(prices);
  const evaluations = (['TRAIN', 'VALIDATION', 'TEST'] as const).map((phase) =>
    replayNewsHistory(market, replay, plan, selected.config, selected.fit.rules, phase),
  );
  const double = replayNewsHistory(
    market,
    replay,
    plan,
    selected.config,
    selected.fit.rules,
    'TEST',
    { costMultiplier: 2 },
  );
  const delayed = replayNewsHistory(
    market,
    replay,
    plan,
    selected.config,
    selected.fit.rules,
    'TEST',
    { extraLatencyHours: 1 },
  );
  const walkForward = [24, 27, 30].map((month) => {
    const p = {
      ...plan,
      trainEnd: shiftNewsMonth(plan.from, month),
      validationEnd: shiftNewsMonth(plan.from, month + 3),
      to: shiftNewsMonth(plan.from, month + 6),
    };
    const fit = selectV4(events, prices, p);
    return {
      trainEnd: p.trainEnd,
      validationEnd: p.validationEnd,
      testEnd: p.to,
      configId: fit.config.id,
      evaluation: replayNewsHistory(market, replay, p, fit.config, fit.fit.rules, 'TEST'),
    };
  });
  const holdReasons: Record<string, number> = {};
  for (const e of events.filter((e) => e.assets.includes(prices.instrument.asset)))
    if (e.gate !== 'ELIGIBLE_FOR_DESCRIPTIVE_ESTIMATION')
      holdReasons[e.gate] = (holdReasons[e.gate] ?? 0) + 1;
  if (!selected.fit.rules.some((r) => r.side !== 'HOLD'))
    holdReasons.HOLD_INSUFFICIENT_TRAINING_OR_VALIDATION = 1;
  const test = evaluations[2]!,
    rejectionReasons = [
      'Historical article versions/receipt times are not point-in-time verified. This is descriptive research, not a live strategy.',
      'The fixed current token universe and previously inspected final period introduce selection bias.',
      'Lagged original-release deviations are a declared news feature, not economist consensus or verified monetary-policy surprise.',
    ];
  if (!test.trades.length)
    rejectionReasons.push(
      'No candidate passed the evidence and validation gates; cash is abstention, not predictive profit.',
    );
  if (Number(test.netPnl) < 100) rejectionReasons.push('The +100 USDT target was not reached.');
  if (Number(double.netPnl) <= 0 || Number(delayed.netPnl) <= 0)
    rejectionReasons.push('Positive returns did not survive both cost and latency stress tests.');
  const body = {
    version: 'LEARNED_V4' as const,
    trainingMethod: 'TOKEN_SPECIFIC_SIGNED_EVENT_REACTIONS' as const,
    config: selected.config,
    rules: selected.fit.rules,
    trials: 6,
    candidates: selected.candidates,
    evaluations,
    doubleCostTestPnl: double.netPnl,
    delayedTestPnl: delayed.netPnl,
    targetReachedDescriptively: Number(test.netPnl) >= 100,
    qualifiedForForwardTest: false as const,
    rejectionReasons,
    walkForward,
    holdReasons,
    fitEvidence: selected.fit.evidence,
  };
  return NewsV4Model.parse({ ...body, modelHash: canonicalHash(body) });
}
/** Legacy algorithms rerun on this study's common inputs; original stored V1–V3 reports are never overwritten. */
export function rerunLegacyNewsModels(
  events: ResearchEvent[],
  prices: NewsLongPrices,
  plan: ResearchPlan,
) {
  const market = legacyNewsPrices(prices),
    fixed = {
      id: 'fixed-news-rules.v1',
      horizonHours: 24,
      minSamples: 0,
      edgeBuffer: 0,
      uncertaintyZ: 0,
    };
  const candidates = newsResearchCandidates().map((config) => {
    const rules = fitNewsResearchRules(events, market, plan, config),
      e = replayNewsHistory(market, events, plan, config, rules, 'VALIDATION');
    return {
      config,
      rules,
      validationPnl: e.netPnl,
      validationTrades: e.trades.length,
      score: e.trades.length >= 3 ? Number(e.netPnl) - 2500 * e.maxDrawdown : -1e9,
    };
  });
  const best = [...candidates].sort(
    (a, b) => b.score - a.score || a.config.id.localeCompare(b.config.id),
  )[0]!;
  const chosen =
    best.score > 0
      ? best
      : { config: { ...fixed, id: 'cash-insufficient-validation.v1' }, rules: [] };
  return [
    { version: 'RULES_V1' as const, config: fixed, rules: null },
    { version: 'LEARNED_V2' as const, config: chosen.config, rules: chosen.rules },
  ].map((m) => {
    const evaluations = (['TRAIN', 'VALIDATION', 'TEST'] as const).map((phase) =>
      replayNewsHistory(market, events, plan, m.config, m.rules, phase),
    );
    const double = replayNewsHistory(market, events, plan, m.config, m.rules, 'TEST', {
        costMultiplier: 2,
      }),
      delayed = replayNewsHistory(market, events, plan, m.config, m.rules, 'TEST', {
        extraLatencyHours: 1,
      });
    const body = {
      version: m.version,
      config: m.config,
      rules: m.rules ?? [],
      trials: m.version === 'LEARNED_V2' ? 36 : 1,
      candidates:
        m.version === 'LEARNED_V2'
          ? candidates.map(({ rules, ...c }) => {
              void rules;
              return c;
            })
          : [],
      evaluations,
      doubleCostTestPnl: double.netPnl,
      delayedTestPnl: delayed.netPnl,
      targetReachedDescriptively: Number(evaluations[2]!.netPnl) >= 100,
      qualifiedForForwardTest: false as const,
      rejectionReasons: [
        'New 36-month descriptive replay of the unchanged legacy algorithm; original six-month report is preserved separately.',
        'Historical content availability is unverified; no live qualification.',
      ],
    };
    return NewsResearchModel.parse({ ...body, modelHash: canonicalHash(body) });
  });
}
export async function buildNewsV4Report(
  referenceInput: unknown,
  referenceV3RunId: string,
  corpus: V4Corpus,
  plan: ResearchPlan,
  markets: {
    asset: MarketAsset;
    prices: NewsLongPrices;
    manifest: LongMarketManifest;
    hash: string;
  }[],
  seedSnapshotHash: string,
  progress: (s: string) => Promise<void> = async () => {},
  generatedAt = Date.now(),
): Promise<V4Report> {
  const reference = NewsV3Report.parse(referenceInput),
    events = structureNewsV4(corpus.snapshot, plan),
    legacyEvents = legacyHistoryEvents(corpus.snapshot, plan),
    v3Events = legacyV3Events(corpus.snapshot, plan),
    rows: V4Report['rows'] = [];
  if (corpus.origin !== 'PUBLIC_HISTORICAL')
    throw new Error('Synthetic corpus cannot create a public V4 report');
  if (markets.length !== 10 || new Set(markets.map((m) => m.asset)).size !== 10)
    throw new Error('V4 complete market universe required');
  for (const m of markets) {
    if (
      m.prices.origin !== 'PUBLIC_HISTORICAL' ||
      m.prices.from !== plan.from ||
      m.prices.to !== plan.to ||
      m.manifest.priceHash !== canonicalHash(m.prices.bars) ||
      m.hash !== canonicalHash(m.manifest)
    )
      throw new Error('V4 frozen market inputs mismatch');
    await progress(m.asset + ': rerunning V1/V2/V3 and fitting V4 on common 36-month inputs');
    await new Promise<void>((r) => setImmediate(r));
    const old = rerunLegacyNewsModels(legacyEvents, m.prices, plan),
      v3 = buildV3Model(v3Events, legacyNewsPrices(m.prices), plan),
      v4 = buildV4Model(events, m.prices, plan);
    rows.push({
      asset: m.asset,
      status: 'COMPLETE',
      marketHash: m.hash,
      eventCount: events.filter((e) => e.assets.includes(m.asset) && e.publishedAt !== null).length,
      historicallyAvailableEvents: events.filter(
        (e) =>
          e.assets.includes(m.asset) &&
          e.publishedAt !== null &&
          e.availableAt <= e.publishedAt + plan.latencyMs,
      ).length,
      effects: [],
      models: [...old, v3, v4],
      v4Coverage: v3Coverage(events, corpus.snapshot, plan, m.asset),
      buyHoldNetPnl: null,
      error: null,
    });
  }
  rows.push({
    asset: 'USDT',
    status: 'CASH_CONTROL',
    marketHash: null,
    eventCount: 0,
    historicallyAvailableEvents: 0,
    effects: [],
    models: [],
    v4Coverage: {
      relevant: 0,
      dated: 0,
      eligible: 0,
      independentGroups: 0,
      historicallyTimely: 0,
      gates: {},
    },
    buyHoldNetPnl: '0' as V4Report['rows'][number]['buyHoldNetPnl'],
    error: null,
  });
  return NewsV4Report.parse({
    version: 'news-history-comparison.v4',
    origin: 'PUBLIC_HISTORICAL',
    interpretation: 'DESCRIPTIVE_ONLY_NOT_A_TRADABLE_BACKTEST',
    generatedAt,
    engineHash: NEWS_V4_ENGINE_HASH,
    referenceV3RunId,
    referenceV3ReportHash: canonicalHash(reference),
    referenceLegacyReportHash: reference.baselineReportHash,
    plan,
    planHash: canonicalHash(plan),
    snapshotHash: canonicalHash(corpus.snapshot),
    seedSnapshotHash,
    corpusHash: canonicalHash(corpus),
    protocol: NEWS_V4_PROTOCOL,
    coverage: corpus.coverage,
    markets: markets.map((m) => m.manifest),
    events,
    legacyEvents: [...legacyEvents, ...v3ReplayEvents(v3Events, false)],
    rows,
    limitations: [
      'All four versions are rerun on the same longer corpus, training/validation/final boundaries and hourly prices with fees on. Original six-month reports remain available separately; their P&L is not mixed into this table.',
      'Public archives do not prove original article-version or first-availability history. Collection times remain real. All results are descriptive and never authorize live execution.',
      'GDELT is discovery-only; unavailable sources, bounded pagination and undated records are visible. There is no complete free 36-month full-text archive claim.',
      'V4 uses signed event-status features and deviations from the median of three earlier original releases. This is not historical economist consensus, and no such forecasts are fabricated.',
      'V4 pools positive/negative feature signs within the same event type for each token; it does not count responses across ten tokens as ten independent announcements.',
      'Twelve/twenty non-overlapping training observations, approximate 95% uncertainty, twice estimated costs, 72-hour purging and five positive-scoring validation trades remain required. No trades are forced.',
      'V1/V2 retain their original AI-use permission gate. V4 additionally permits deterministic factual metadata from the newly registered public APIs while keeping LLM processing off.',
      'Current exchange filters and the fixed present-day universe are applied retrospectively. Shorts use the baseline assumed financing, not verified historical availability or perpetual funding.',
      'Each token/version/split has separate 10,000 virtual USDT. Fees 0.1% each fill, adverse slippage 0.05%, allocation 20%, stop 2.5%, target 5%. Minute diagnostics do not become simulated fills.',
      'The final period has already been inspected in prior research. Walk-forward diagnostics are separate accounts, not additional portfolio profits.',
    ],
  });
}
