import { readFileSync } from 'node:fs';
import { canonicalHash } from '@crypto/core';
import type { z } from 'zod';
import { NewsResearchModel } from '../../contracts/src/news-research.js';
import type {
  ResearchConfig,
  ResearchEvent,
  ResearchPlan,
  ResearchRule,
} from '../../contracts/src/news-research.js';
import { NewsV5Report } from '../../contracts/src/news-research-v5.js';
import type { V4Corpus } from '../../contracts/src/news-research-v4.js';
import { NewsV6Model, NewsV6Report } from '../../contracts/src/news-research-v6.js';
import type { V6Case, V6Model, V6CaseId } from '../../contracts/src/news-research-v6.js';
import { NEWS_V5_ENGINE_HASH } from './news-history-v5.js';
import {
  newsResearchCandidates,
  fitNewsResearchRules,
  replayNewsHistory,
} from './news-history-replay.js';
import { rerunLegacyNewsModels } from './news-history-v4.js';
import { legacyHistoryEvents } from '../../research/src/news-events-v4.js';
import { legacyNewsPrices } from '../../research/src/news-long-history.js';
import type { NewsLongPrices } from '../../research/src/news-long-history.js';
import { shiftNewsMonth } from '../../research/src/news-history-study.js';
import { D } from './spot-math.js';
type Model = z.infer<typeof NewsResearchModel>;
type Evaluation = Model['evaluations'][number];
type Fit = { config: ResearchConfig; rules: ResearchRule[] };

export const NEWS_V6_PROTOCOL = {
  baselineCandidates: 36,
  singleFactorVariants: 3,
  selectionCases: 4,
  uncertaintyZ: 1.28,
  groupValidationMinimumTrades: 3,
  groupValidationCosts: 'NORMAL_FEES_ONLY',
  largestWinnerPenalty: 0.5,
  minimumValidationTrades: 3,
  validationWindows: 3,
  fedCategories: 'UNCHANGED_V2_SEPARATE_EASING_TIGHTENING_OTHER',
  controls: 'UNCHANGED_V2_EVENT_UNIVERSE_AND_CONTROL_SAMPLING',
  selection: 'VALIDATION_ONLY_SINGLE_CASE_NO_COMBINED_CHANGES',
} as const;
export const NEWS_V6_ENGINE_HASH = canonicalHash({
  version: 'news-history.v6',
  parent: NEWS_V5_ENGINE_HASH,
  code: ['./news-history-v6.ts', '../../contracts/src/news-research-v6.ts'].map((p) =>
    readFileSync(new URL(p, import.meta.url), 'utf8'),
  ),
});
export const v6ValidationScore = (e: Evaluation) =>
  e.trades.length >= 3
    ? Number(e.netPnl) -
      2500 * e.maxDrawdown -
      0.5 * Math.max(0, ...e.trades.map((t) => Number(t.netPnl)))
    : -1e9;

/** No final evaluation is read here. Every arm uses the original V2 event/control universe. */
export function selectNewsV6(events: ResearchEvent[], prices: NewsLongPrices, plan: ResearchPlan) {
  const market = legacyNewsPrices(prices);
  const grid = newsResearchCandidates().map((config) => {
    const rules = fitNewsResearchRules(events, market, plan, config),
      validation = replayNewsHistory(market, events, plan, config, rules, 'VALIDATION');
    return {
      config,
      rules,
      validation,
      score:
        validation.trades.length >= 3
          ? Number(validation.netPnl) - 2500 * validation.maxDrawdown
          : -1e9,
    };
  });
  const ranked = [...grid].sort(
    (a, b) => b.score - a.score || a.config.id.localeCompare(b.config.id),
  );
  const best = ranked[0]!;
  const cash: Fit = {
    config: {
      id: 'cash-insufficient-validation.v1',
      horizonHours: 24,
      minSamples: 0,
      edgeBuffer: 0,
      uncertaintyZ: 0,
    },
    rules: [],
  };
  const baseline: Fit = best.score > 0 ? { config: best.config, rules: best.rules } : cash;
  const uncertaintyConfig = { ...baseline.config, uncertaintyZ: 1.28 };
  const groupChecks: V6Case['groupChecks'] = [];
  const groupRules = baseline.rules.map((rule) => {
    // Isolated category validation uses the full news universe with every other category on HOLD.
    const e = replayNewsHistory(market, events, plan, baseline.config, [rule], 'VALIDATION');
    const retained = rule.side !== 'HOLD' && e.trades.length >= 3 && Number(e.netPnl) > 0;
    groupChecks.push({
      group: rule.group,
      validationTrades: e.trades.length,
      validationPnl: e.netPnl,
      retained,
    });
    return { ...rule, side: retained ? rule.side : ('HOLD' as const) };
  });
  const penaltyBest = [...grid].sort(
    (a, b) =>
      v6ValidationScore(b.validation) - v6ValidationScore(a.validation) ||
      a.config.id.localeCompare(b.config.id),
  )[0]!;
  const arms: {
    id: V6CaseId;
    change: string;
    changedFields: string[];
    fit: Fit;
    groupChecks: V6Case['groupChecks'];
  }[] = [
    {
      id: 'V2_BASELINE',
      change: 'Unchanged V2 algorithm, event set, controls, candidate grid and selection.',
      changedFields: [],
      fit: baseline,
      groupChecks: [],
    },
    {
      id: 'UNCERTAINTY_ONLY',
      change:
        'Add a 1.28 standard-error margin; keep V2 selected horizon, sample threshold, cost buffer and events.',
      changedFields: ['uncertaintyZ'],
      fit: baseline.rules.length
        ? {
            config: uncertaintyConfig,
            rules: fitNewsResearchRules(events, market, plan, uncertaintyConfig),
          }
        : cash,
      groupChecks: [],
    },
    {
      id: 'GROUP_VALIDATION_ONLY',
      change:
        'Keep a V2 category only after 3 profitable normal-cost validation trades; no double-cost veto or new event taxonomy.',
      changedFields: ['categoryValidationGate'],
      fit: { config: baseline.config, rules: groupRules },
      groupChecks,
    },
    {
      id: 'CONCENTRATION_SELECTION_ONLY',
      change:
        'Rerank the same 36 V2 candidates by subtracting half the largest validation win; no other change.',
      changedFields: ['candidateSelectionScore'],
      fit:
        v6ValidationScore(penaltyBest.validation) > 0
          ? { config: penaltyBest.config, rules: penaltyBest.rules }
          : cash,
      groupChecks: [],
    },
  ];
  const cases = arms.map((arm) => ({
    ...arm,
    validation: replayNewsHistory(
      market,
      events,
      plan,
      arm.fit.config,
      arm.fit.rules,
      'VALIDATION',
    ),
  }));
  // Array order breaks equal scores in favor of unchanged V2. Final results cannot choose an arm.
  const selected = [...cases].sort(
    (a, b) =>
      v6ValidationScore(b.validation) - v6ValidationScore(a.validation) ||
      arms.findIndex((x) => x.id === a.id) - arms.findIndex((x) => x.id === b.id),
  )[0]!;
  return {
    cases,
    concentrationCandidates: grid.map((c) => ({
      config: c.config,
      validationPnl: c.validation.netPnl,
      validationTrades: c.validation.trades.length,
      score: v6ValidationScore(c.validation),
    })),
    selectedCase: v6ValidationScore(selected.validation) > 0 ? selected.id : ('CASH' as const),
    fit: v6ValidationScore(selected.validation) > 0 ? selected.fit : cash,
  };
}
function armModel(
  events: ResearchEvent[],
  prices: NewsLongPrices,
  plan: ResearchPlan,
  fit: Fit,
): Model {
  const market = legacyNewsPrices(prices),
    evaluations = (['TRAIN', 'VALIDATION', 'TEST'] as const).map((phase) =>
      replayNewsHistory(market, events, plan, fit.config, fit.rules, phase),
    );
  const body = {
    version: 'LEARNED_V2' as const,
    config: fit.config,
    rules: fit.rules,
    trials: 1,
    candidates: [],
    evaluations,
    doubleCostTestPnl: replayNewsHistory(market, events, plan, fit.config, fit.rules, 'TEST', {
      costMultiplier: 2,
    }).netPnl,
    delayedTestPnl: replayNewsHistory(market, events, plan, fit.config, fit.rules, 'TEST', {
      extraLatencyHours: 1,
    }).netPnl,
    targetReachedDescriptively: Number(evaluations[2]!.netPnl) >= 100,
    qualifiedForForwardTest: false as const,
    rejectionReasons: [
      'Single-factor V2 research arm, not a replacement original V2 report. Historical availability and already-viewed final prices prevent live qualification.',
    ],
  };
  return NewsResearchModel.parse({ ...body, modelHash: canonicalHash(body) });
}
export function buildV6Model(
  events: ResearchEvent[],
  prices: NewsLongPrices,
  plan: ResearchPlan,
  referenceV2?: Model,
): V6Model {
  const chosen = selectNewsV6(events, prices, plan),
    baseline = rerunLegacyNewsModels(events, prices, plan)[1]!;
  if (referenceV2 && canonicalHash(baseline) !== canonicalHash(referenceV2))
    throw new Error('V6 failed exact V2 reproduction');
  if (
    canonicalHash(chosen.cases[0]!.fit.config) !== canonicalHash(baseline.config) ||
    canonicalHash(chosen.cases[0]!.fit.rules) !== canonicalHash(baseline.rules)
  )
    throw new Error('V6 baseline selection mismatch');
  const ablations = chosen.cases.map((arm) => {
    let model = arm.id === 'V2_BASELINE' ? baseline : armModel(events, prices, plan, arm.fit);
    if (arm.id === 'CONCENTRATION_SELECTION_ONLY') {
      const { modelHash: oldHash, ...body } = model;
      void oldHash;
      const rankedBody = { ...body, trials: 36, candidates: chosen.concentrationCandidates };
      model = NewsResearchModel.parse({ ...rankedBody, modelHash: canonicalHash(rankedBody) });
    }
    const validationWindows = [0, 1, 2].map((i) => {
      const p = {
        ...plan,
        trainEnd: shiftNewsMonth(plan.trainEnd, i * 2),
        validationEnd: shiftNewsMonth(plan.trainEnd, (i + 1) * 2),
      };
      return replayNewsHistory(
        legacyNewsPrices(prices),
        events,
        p,
        arm.fit.config,
        arm.fit.rules,
        'VALIDATION',
      );
    });
    return {
      id: arm.id,
      change: arm.change,
      changedFields: arm.changedFields,
      model,
      groupChecks: arm.groupChecks,
      validationScore: v6ValidationScore(arm.validation),
      validationDelta: new D(model.evaluations[1]!.netPnl)
        .minus(baseline.evaluations[1]!.netPnl)
        .toFixed(8),
      finalDelta: new D(model.evaluations[2]!.netPnl)
        .minus(baseline.evaluations[2]!.netPnl)
        .toFixed(8),
      validationWindows,
    };
  });
  const selected =
    chosen.selectedCase === 'CASH'
      ? armModel(events, prices, plan, chosen.fit)
      : ablations.find((a) => a.id === chosen.selectedCase)!.model;
  const { modelHash: ignored, ...selectedBody } = selected;
  void ignored;
  const body = {
    ...selectedBody,
    version: 'LEARNED_V6' as const,
    trainingMethod: 'V2_SINGLE_FACTOR_ABLATIONS' as const,
    selectedCase: chosen.selectedCase,
    eventsHash: canonicalHash(events),
    ablations,
    trials: 4,
    candidates: ablations.map((a) => ({
      config: { ...a.model.config, id: a.id },
      validationPnl: a.model.evaluations[1]!.netPnl,
      validationTrades: a.model.evaluations[1]!.trades.length,
      score: a.validationScore,
    })),
    rejectionReasons: [
      'V6 chooses one standalone V2 arm using validation only; it never combines modifications or selects by final P&L.',
      'The 36 baseline configurations plus three single-factor variants and group checks are adaptive comparisons, not independent evidence.',
      'The current universe and already-inspected final history are descriptive only; historical article receipt/version vintages remain unverified.',
      'Two-month validation diagnostics use frozen training rules and separate accounts; they are not independent folds and must not be summed into the full account.',
    ],
  };
  return NewsV6Model.parse({ ...body, modelHash: canonicalHash(body) });
}
export async function buildNewsV6Report(
  input: unknown,
  referenceV5RunId: string,
  corpus: V4Corpus,
  markets: NewsLongPrices[],
  progress: (s: string) => Promise<void> = async () => {},
) {
  const parent = NewsV5Report.parse(input);
  if (
    corpus.origin !== 'PUBLIC_HISTORICAL' ||
    canonicalHash(corpus) !== parent.corpusHash ||
    canonicalHash(corpus.snapshot) !== parent.snapshotHash
  )
    throw new Error('V6 frozen corpus mismatch');
  const events = legacyHistoryEvents(corpus.snapshot, parent.plan),
    rows = [];
  for (const row of parent.rows) {
    if (row.asset === 'USDT') {
      rows.push(row);
      continue;
    }
    await progress(
      `${row.asset}: reproduce V2 exactly; compare three single-factor arms with Fed categories separate`,
    );
    const prices = markets.find((m) => m.instrument.asset === row.asset),
      manifest = parent.markets.find((m) => m.asset === row.asset);
    if (
      !prices ||
      prices.origin !== 'PUBLIC_HISTORICAL' ||
      !manifest ||
      canonicalHash(prices.bars) !== manifest.priceHash ||
      prices.from !== parent.plan.from ||
      prices.to !== parent.plan.to
    )
      throw new Error('V6 frozen market mismatch');
    rows.push({
      ...row,
      models: [...row.models, buildV6Model(events, prices, parent.plan, row.models[1] as Model)],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return NewsV6Report.parse({
    ...parent,
    version: 'news-history-comparison.v6',
    generatedAt: Date.now(),
    engineHash: NEWS_V6_ENGINE_HASH,
    referenceV5RunId,
    referenceV5ReportHash: canonicalHash(parent),
    protocolV6: NEWS_V6_PROTOCOL,
    replayEventsV6: events,
    rows,
    limitationsV6: [
      'V1-V5 reports and models are preserved exactly. The V2 baseline is reproduced and verified before standalone changes are evaluated.',
      'All arms use the unchanged V2 event taxonomy and control universe, including separate Fed easing, tightening and other statements.',
      'V6 selects one standalone arm by validation score only. Full-period final P&L and stress results cannot select or combine arms.',
      'The 36 baseline configurations, three variants and per-category validation checks are adaptive multiple comparisons, not independent confirmation.',
      'Three two-month validation diagnostics use frozen training rules and independently reset capital; they are not refitted walk-forward folds or additive full-period P&L.',
      'The final history has already been viewed and original publication/receipt vintages are unverified. All output remains descriptive and never live-qualified.',
    ],
  });
}
