import { readFileSync } from 'node:fs';
import { canonicalHash } from '@crypto/core';
import type { z } from 'zod';
import type { NewsResearchModel } from '../../contracts/src/news-research.js';
import { NewsV4Report } from '../../contracts/src/news-research-v4.js';
import type { V4Report } from '../../contracts/src/news-research-v4.js';
import {
  NewsV5Model,
  NewsV5Report,
  NewsV2Attribution,
} from '../../contracts/src/news-research-v5.js';
import type { V5Model, V2Attribution } from '../../contracts/src/news-research-v5.js';
import type {
  ResearchConfig,
  ResearchEvent,
  ResearchPlan,
} from '../../contracts/src/news-research.js';
import type { NewsLongPrices } from '../../research/src/news-long-history.js';
import { legacyNewsPrices } from '../../research/src/news-long-history.js';
import { NEWS_V4_ENGINE_HASH } from './news-history-v4.js';
import { fitNewsResearchRules, replayNewsHistory } from './news-history-replay.js';
import { D } from './spot-math.js';
type ResearchModel = z.infer<typeof NewsResearchModel>;

export const NEWS_V5_ENGINE_HASH = canonicalHash({
  version: 'news-history.v5',
  parent: NEWS_V4_ENGINE_HASH,
  code: [
    './news-history-v5.ts',
    '../../research/src/news-frozen-markets-v5.ts',
    '../../contracts/src/news-research-v5.ts',
  ].map((p) => readFileSync(new URL(p, import.meta.url), 'utf8')),
});
export const NEWS_V5_PROTOCOL = {
  candidates: 3,
  minimumTrainingSamples: 8,
  costBuffer: 2,
  uncertaintyZ: 0,
  minimumGroupValidationTrades: 3,
  minimumGroupValidationMonths: 2,
  minimumValidationTrades: 5,
  largestWinnerPenalty: 0.5,
  selection: 'TRAIN_DIRECTIONS_VALIDATION_GROUPS_AND_HORIZON_NO_FINAL_LABELS',
} as const;
export const v5Candidates = (): ResearchConfig[] =>
  [4, 24, 72].map((horizonHours) => ({
    id: `V5-H${horizonHours}-N8-C2-GROUP-VALIDATED`,
    horizonHours,
    minSamples: 8,
    edgeBuffer: 2,
    uncertaintyZ: 0,
  }));
/** Unconditional release hypotheses do not require economist consensus or a lagged-sign proxy.
 * Non-macro facts retain V4's permission, uncertainty, stage and deduplication gates. */
export function v5ReplayEvents(parent: V4Report): ResearchEvent[] {
  const seen = new Set<string>(),
    result: ResearchEvent[] = [];
  for (const e of [...parent.events].sort(
    (a, b) =>
      (a.publishedAt ?? Infinity) - (b.publishedAt ?? Infinity) ||
      Number(b.sourceId.endsWith('-history')) - Number(a.sourceId.endsWith('-history')) ||
      a.id.localeCompare(b.id),
  )) {
    if (e.publishedAt === null) continue;
    const macro =
      e.kind === 'MACRO' &&
      e.macro !== null &&
      e.attribution === 'OFFICIALLY_STATED' &&
      [
        'bls-cpi',
        'bls-employment',
        'federal-reserve',
        'bls-cpi-history',
        'bls-employment-history',
        'fed-statements-history',
      ].includes(e.sourceId);
    const admitted =
      e.gate === 'ELIGIBLE_FOR_DESCRIPTIVE_ESTIMATION' ||
      (macro &&
        (e.gate === 'HOLD_MISSING_EXPECTATIONS' ||
          (e.gate === 'HOLD_UNCERTAIN_OR_RESOLVED' &&
            e.featureSign === 0 &&
            e.macro!.actual !== null)));
    if (!admitted) continue;
    const group = macro
      ? {
          CPI_MOM: 'INFLATION_RELEASE',
          PAYROLL_CHANGE: 'EMPLOYMENT_RELEASE',
          FED_TARGET_UPPER: 'MONETARY_POLICY',
        }[e.macro!.metric]
      : e.group;
    const key = [
      e.independenceGroup,
      group,
      e.assets.join(','),
      Math.floor(e.publishedAt / (macro ? 86400000 : 21600000)),
    ].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      id: canonicalHash({ version: 'news-event.v5', parentId: e.id, group }),
      versionId: e.versionId,
      sourceId: e.sourceId,
      publisher: e.publisher,
      independenceGroup: e.independenceGroup,
      title: e.title,
      url: e.url,
      assets: e.assets,
      publishedAt: e.publishedAt,
      availableAt: e.availableAt,
      group,
      fixedSide: 'HOLD',
      scope: e.scope,
      timing: 'DESCRIPTIVE_PUBLICATION_PROXY',
    });
  }
  return result;
}
export function selectNewsV5(events: ResearchEvent[], prices: NewsLongPrices, plan: ResearchPlan) {
  const market = legacyNewsPrices(prices),
    checks: V5Model['groupChecks'] = [];
  const fitted = v5Candidates().map((config) => {
    const rules = fitNewsResearchRules(events, market, plan, config).map((rule) => {
      const groupRules = [{ ...rule }],
        groupEvents = events.filter((e) => e.group === rule.group);
      const v = replayNewsHistory(market, groupEvents, plan, config, groupRules, 'VALIDATION');
      const stress = replayNewsHistory(
        market,
        groupEvents,
        plan,
        config,
        groupRules,
        'VALIDATION',
        { costMultiplier: 2 },
      );
      const months = new Set(v.trades.map((t) => new Date(t.entryAt).toISOString().slice(0, 7)))
        .size;
      const accepted =
        rule.side !== 'HOLD' &&
        v.trades.length >= 3 &&
        months >= 2 &&
        Number(v.netPnl) > 0 &&
        Number(stress.netPnl) > 0;
      checks.push({
        configId: config.id,
        group: rule.group,
        side: rule.side,
        trainingCount: rule.count,
        validationTrades: v.trades.length,
        validationMonths: months,
        validationPnl: v.netPnl,
        doubleCostValidationPnl: stress.netPnl,
        accepted,
        reason: accepted
          ? 'Training edge and positive group validation at normal/double costs.'
          : rule.side === 'HOLD'
            ? 'Training samples or twice-cost mean edge insufficient; no confidence-interval claim.'
            : 'Group needs 3 validation trades across 2 months and positive normal/double-cost P&L.',
      });
      return { ...rule, side: accepted ? rule.side : ('HOLD' as const) };
    });
    const e = replayNewsHistory(market, events, plan, config, rules, 'VALIDATION');
    const largest = Math.max(0, ...e.trades.map((t) => Number(t.netPnl)));
    return {
      config,
      rules,
      validationPnl: e.netPnl,
      validationTrades: e.trades.length,
      score: e.trades.length >= 5 ? Number(e.netPnl) - 2500 * e.maxDrawdown - 0.5 * largest : -1e9,
    };
  });
  const best = [...fitted].sort(
    (a, b) => b.score - a.score || a.config.id.localeCompare(b.config.id),
  )[0]!;
  return {
    config:
      best.score > 0
        ? best.config
        : { ...v5Candidates()[0]!, id: 'V5-CASH-INSUFFICIENT-VALIDATION' },
    rules: best.score > 0 ? best.rules : [],
    groupChecks: checks,
    candidates: fitted.map(({ rules, ...c }) => {
      void rules;
      return c;
    }),
  };
}
export function buildV5Model(events: ResearchEvent[], prices: NewsLongPrices, plan: ResearchPlan) {
  const selected = selectNewsV5(events, prices, plan),
    market = legacyNewsPrices(prices);
  const evaluations = (['TRAIN', 'VALIDATION', 'TEST'] as const).map((phase) =>
    replayNewsHistory(market, events, plan, selected.config, selected.rules, phase),
  );
  const double = replayNewsHistory(market, events, plan, selected.config, selected.rules, 'TEST', {
    costMultiplier: 2,
  });
  const delayed = replayNewsHistory(market, events, plan, selected.config, selected.rules, 'TEST', {
    extraLatencyHours: 1,
  });
  const test = evaluations[2]!;
  const body = {
    version: 'LEARNED_V5' as const,
    trainingMethod: 'RELEASE_GROUP_REACTIONS_WITH_COSTED_GROUP_VALIDATION' as const,
    config: selected.config,
    rules: selected.rules,
    candidates: selected.candidates,
    trials: 3,
    groupChecks: selected.groupChecks,
    evaluations,
    doubleCostTestPnl: double.netPnl,
    delayedTestPnl: delayed.netPnl,
    targetReachedDescriptively: Number(test.netPnl) >= 100,
    qualifiedForForwardTest: false as const,
    rejectionReasons: [
      'Already-inspected final history and current token universe: exploratory comparison, never live-qualified.',
      'Historical publication/receipt vintages are unverified. Release-group averages are not causal surprise estimates.',
      'V5 uses an exploratory mean-edge rule without V4 uncertainty bounds; 3 horizons plus all group validation checks are adaptive trials.',
      ...(!test.trades.length
        ? ['No candidate passed costed group validation; cash is abstention.']
        : []),
      ...(Number(double.netPnl) <= 0 || Number(delayed.netPnl) <= 0
        ? ['Positive results do not survive both cost/latency stresses.']
        : []),
    ],
  };
  return NewsV5Model.parse({ ...body, modelHash: canonicalHash(body) });
}
export function attributeNewsV2(model: ResearchModel, events: ResearchEvent[]): V2Attribution {
  const test = model.evaluations[2]!,
    map = new Map(events.map((e) => [e.id, e]));
  const buckets = (label: (t: (typeof test.trades)[number]) => string) => {
    const labels = [...new Set(test.trades.map(label))].sort();
    return labels.map((l) => {
      const trades = test.trades.filter((t) => label(t) === l);
      return {
        label: l,
        trades: trades.length,
        wins: trades.filter((t) => t.status === 'WIN').length,
        netPnl: trades.reduce((n, t) => n.plus(t.netPnl), new D(0)).toFixed(8),
        fees: trades.reduce((n, t) => n.plus(t.fees), new D(0)).toFixed(8),
      };
    });
  };
  const largestWin = D.max(0, ...test.trades.map((t) => new D(t.netPnl))).toFixed(8);
  const groups = buckets((t) => map.get(t.eventId)?.group ?? 'UNKNOWN');
  return NewsV2Attribution.parse({
    groups,
    directions: buckets((t) => t.side),
    months: buckets((t) => new Date(t.entryAt).toISOString().slice(0, 7)),
    largestWin,
    withoutLargestWin: new D(test.netPnl).minus(largestWin).toFixed(8),
    explanation: [
      `V2 chose ${model.config.horizonHours}h holds using validation; training learned ${
        model.rules
          .filter((r) => r.side !== 'HOLD')
          .map((r) => r.group + ' ' + r.side)
          .join(', ') || 'cash'
      }.`,
      `Final group contributions after fees: ${groups.map((g) => g.label + ' ' + g.netPnl + ' USDT (' + g.trades + ' trades)').join('; ') || 'none'}.`,
      `Normal ${test.netPnl}; double costs ${model.doubleCostTestPnl}; one-hour extra delay ${model.delayedTestPnl} USDT.`,
      `Removing the largest winning trade leaves ${new D(test.netPnl).minus(largestWin).toFixed(8)} USDT. This diagnostic does not rerun account compounding.`,
      'Average direction by news category ignores the actual economic surprise. Token-specific reactions and stops/targets explain different outcomes; correlation is not causal attribution.',
    ],
  });
}
export async function buildNewsV5Report(
  input: unknown,
  referenceV4RunId: string,
  markets: NewsLongPrices[],
  progress: (s: string) => Promise<void> = async () => {},
) {
  const parent = NewsV4Report.parse(input),
    events = v5ReplayEvents(parent),
    rows = [];
  for (const row of parent.rows) {
    if (row.asset === 'USDT') {
      rows.push({ ...row, v2Attribution: null });
      continue;
    }
    await progress(
      `${row.asset}: V5 training/validation selection, then frozen final replay with fees on`,
    );
    const prices = markets.find((m) => m.instrument.asset === row.asset),
      manifest = parent.markets.find((m) => m.asset === row.asset);
    if (
      !prices ||
      !manifest ||
      canonicalHash(prices.bars) !== manifest.priceHash ||
      prices.from !== parent.plan.from ||
      prices.to !== parent.plan.to
    )
      throw new Error('V5 parent prices mismatch');
    rows.push({
      ...row,
      models: [...row.models, buildV5Model(events, prices, parent.plan)],
      v2Attribution: attributeNewsV2(row.models[1] as ResearchModel, parent.legacyEvents),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return NewsV5Report.parse({
    ...parent,
    version: 'news-history-comparison.v5',
    generatedAt: Date.now(),
    engineHash: NEWS_V5_ENGINE_HASH,
    referenceV4RunId,
    referenceV4ReportHash: canonicalHash(parent),
    protocolV5: NEWS_V5_PROTOCOL,
    replayEventsV5: events,
    rows,
    limitations: [
      ...parent.limitations.slice(0, 21),
      'V1–V4 model objects are copied byte-equivalently from the frozen V4 comparison. V5 reuses exact corpus, events and hourly price hashes without network access.',
      'V5 is a distinct unconditional release-category hypothesis; it does not claim missing consensus data exists or improve V4 confidence.',
      'Per-group validation and horizon selection add multiple-testing risk. Final results were already viewed in earlier versions and are not an untouched holdout.',
    ],
  });
}
