import type { ResearchTrade } from '../../contracts/src/news-research.js';
import { canonicalHash } from '@crypto/core';
import { readFileSync } from 'node:fs';
import { DecimalStringSchema } from '../../contracts/src/primitives.js';
import type { MarketHistory } from '../../contracts/src/market-tests.js';
import {
  NewsResearchEvaluation,
  NewsResearchModel,
  NewsResearchReport,
} from '../../contracts/src/news-research.js';
import type {
  ResearchPlan,
  ResearchConfig,
  ResearchEvent,
  ResearchRule,
  ResearchReport,
} from '../../contracts/src/news-research.js';
import {
  eventEntryIndex,
  newsHistorySamples,
  sampleStats,
  NEWS_HOUR,
  prepareNewsHistory,
} from '../../research/src/news-history-study.js';
import { D, grid } from './spot-math.js';

const money = (n: InstanceType<typeof D> | string | number) =>
  DecimalStringSchema.parse(new D(n).toFixed(8));
export const NEWS_RESEARCH_ENGINE_HASH = canonicalHash({
  version: 'news-history-engine.v1',
  sources: [
    './news-history-replay.ts',
    '../../research/src/news-history-study.ts',
    '../../contracts/src/news-research.ts',
    './spot-math.ts',
    '../../contracts/src/market-tests.ts',
  ].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8')),
  taxonomy: 'deterministic-source-and-keyword.v1',
  timing: 'publication+5m-next-hour-open',
  split: 'calendar-3m-train-1m-validation-2m-test',
  controls: 'same-hour-offsets-7-14-21d-exclude-overlap',
  selection: '36-validation-only-cash-fallback',
  fills: 'adverse-first-gap-aware-fully-collateralized.v1',
});
export function newsResearchCandidates(): ResearchConfig[] {
  const result: ResearchConfig[] = [];
  for (const horizonHours of [4, 24, 72])
    for (const minSamples of [3, 5, 8])
      for (const edgeBuffer of [1, 2])
        for (const uncertaintyZ of [0, 1.28])
          result.push({
            id: `H${horizonHours}-N${minSamples}-C${edgeBuffer}-Z${uncertaintyZ}`,
            horizonHours,
            minSamples,
            edgeBuffer,
            uncertaintyZ,
          });
  return result;
}
export function fitNewsResearchRules(
  events: ResearchEvent[],
  history: MarketHistory,
  plan: ResearchPlan,
  config: ResearchConfig,
): ResearchRule[] {
  const rows = newsHistorySamples(
    events,
    history,
    config.horizonHours,
    plan.from,
    plan.trainEnd,
    plan.latencyMs,
  );
  const groups = [...new Set(rows.map((r) => r.event.group))].sort();
  return groups.map((group) => {
    const values = rows.filter((r) => r.event.group === group).map((r) => r.excess),
      stats = sampleStats(values);
    const cost =
      2 * (Number(plan.feeRate) + Number(plan.slippage)) +
      Number(plan.shortBorrowHourly) * config.horizonHours;
    const edge = Math.abs(stats.mean) - config.uncertaintyZ * stats.standardError;
    const side =
      values.length >= config.minSamples &&
      edge > cost * config.edgeBuffer &&
      !group.includes('UNCERTAIN')
        ? stats.mean > 0
          ? ('LONG' as const)
          : ('SHORT' as const)
        : ('HOLD' as const);
    return {
      group,
      count: values.length,
      side,
      meanExcessReturn: stats.mean,
      standardError: stats.standardError,
    };
  });
}
/** Price is used only for labels, risk and simulated fills; candidate direction uses news rules. */
export function replayNewsHistory(
  history: MarketHistory,
  events: ResearchEvent[],
  plan: ResearchPlan,
  config: ResearchConfig,
  rules: ResearchRule[] | null,
  phase: 'TRAIN' | 'VALIDATION' | 'TEST',
  stress: { costMultiplier?: number; extraLatencyHours?: number } = {},
) {
  const from =
    phase === 'TRAIN' ? plan.from : phase === 'VALIDATION' ? plan.trainEnd : plan.validationEnd;
  const to =
    phase === 'TRAIN' ? plan.trainEnd : phase === 'VALIDATION' ? plan.validationEnd : plan.to;
  let equity = new D(plan.initialUsdt),
    peak = equity,
    maxDrawdown = 0,
    nextFree = from;
  let feesTotal = new D(0),
    financingTotal = new D(0),
    slippageTotal = new D(0);
  const trades: ResearchTrade[] = [],
    skipped: Record<string, number> = {};
  const skip = (reason: string) => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  };
  const costs = stress.costMultiplier ?? 1,
    fee = new D(plan.feeRate).mul(costs),
    slip = new D(plan.slippage).mul(costs);
  const filters = history.instrument.filters;
  for (const event of events.filter((e) => e.assets.includes(history.instrument.asset))) {
    if (event.publishedAt < from || event.publishedAt >= to) continue;
    const side = event.group.includes('UNCERTAIN')
      ? 'HOLD'
      : rules === null
        ? event.fixedSide
        : (rules.find((r) => r.group === event.group)?.side ?? 'HOLD');
    if (side === 'HOLD') {
      skip('NO_SUPPORTED_NEWS_EDGE');
      continue;
    }
    const index = eventEntryIndex(
      event,
      history,
      plan.latencyMs + (stress.extraLatencyHours ?? 0) * NEWS_HOUR,
    );
    const first = history.bars[index];
    if (!first || first.at >= to) {
      skip('NO_ENTRY_BAR_IN_SPLIT');
      continue;
    }
    if (first.at < nextFree) {
      skip('POSITION_ALREADY_OPEN');
      continue;
    }
    const lastIndex = Math.min(
      index + config.horizonHours - 1,
      Math.ceil((to - history.from) / NEWS_HOUR) - 1,
    );
    const end = history.bars[lastIndex];
    if (!end || end.at + NEWS_HOUR > to) {
      skip('MISSING_EXIT_BAR');
      continue;
    }
    const entry = new D(
      grid(
        new D(first.open).mul(side === 'LONG' ? new D(1).plus(slip) : new D(1).minus(slip)),
        filters.priceTick,
        side === 'LONG',
      ),
    );
    const budget = equity.mul(plan.allocation);
    const quantity = new D(
      grid(
        D.min(new D(filters.maxQty), budget.div(entry.mul(new D(1).plus(fee)))),
        filters.quantityStep,
      ),
    );
    const notional = quantity.mul(entry);
    if (quantity.lt(filters.minQty) || notional.lt(filters.minNotional) || quantity.lte(0)) {
      skip('INSTRUMENT_MINIMUM');
      continue;
    }
    const stop = new D(
      grid(
        entry.mul(
          side === 'LONG' ? new D(1).minus(plan.stopFraction) : new D(1).plus(plan.stopFraction),
        ),
        filters.priceTick,
        side === 'SHORT',
      ),
    );
    const target = new D(
      grid(
        entry.mul(
          side === 'LONG'
            ? new D(1).plus(plan.targetFraction)
            : new D(1).minus(plan.targetFraction),
        ),
        filters.priceTick,
        side === 'LONG',
      ),
    );
    const entryFee = new D(money(notional.mul(fee)));
    let mark = new D(end.close),
      exitAt = end.at + NEWS_HOUR - 1,
      reason: ResearchTrade['reason'] =
        lastIndex < index + config.horizonHours - 1 ? 'PERIOD_END' : 'HORIZON';
    // No sub-hour order is invented: adverse stop takes precedence if both boundaries occur.
    for (let j = index; j <= lastIndex; j++) {
      const bar = history.bars[j]!;
      const stopHit = side === 'LONG' ? new D(bar.low).lte(stop) : new D(bar.high).gte(stop);
      const targetHit = side === 'LONG' ? new D(bar.high).gte(target) : new D(bar.low).lte(target);
      const adverse = stopHit
        ? side === 'LONG'
          ? D.min(stop, new D(bar.open))
          : D.max(stop, new D(bar.open))
        : side === 'LONG'
          ? new D(bar.low)
          : new D(bar.high);
      const financing = new D(
        money(
          notional
            .mul(plan.shortBorrowHourly)
            .mul(j - index + 1)
            .mul(side === 'SHORT' ? 1 : 0),
        ),
      );
      const worstExit = adverse.mul(side === 'LONG' ? new D(1).minus(slip) : new D(1).plus(slip));
      const worst = equity
        .plus(quantity.mul(worstExit.minus(entry)).mul(side === 'LONG' ? 1 : -1))
        .minus(entryFee)
        .minus(worstExit.mul(quantity).mul(fee))
        .minus(financing);
      // Intrabar worst marks give a conservative OHLC drawdown, not just hourly closes.
      maxDrawdown = Math.max(
        maxDrawdown,
        Math.max(0, Math.min(1, peak.minus(worst).div(peak).toNumber())),
      );
      if (stopHit || targetHit) {
        reason = stopHit ? 'STOP' : 'TARGET';
        mark = stopHit
          ? side === 'LONG'
            ? D.min(stop, new D(bar.open))
            : D.max(stop, new D(bar.open))
          : target;
        exitAt = bar.at + NEWS_HOUR - 1;
        break;
      }
    }
    const exit = new D(
      grid(
        mark.mul(side === 'LONG' ? new D(1).minus(slip) : new D(1).plus(slip)),
        filters.priceTick,
        side === 'SHORT',
      ),
    );
    const exitFee = new D(money(exit.mul(quantity).mul(fee)));
    const financing = new D(
      money(
        side === 'SHORT'
          ? notional.mul(plan.shortBorrowHourly).mul(Math.ceil((exitAt - first.at) / NEWS_HOUR))
          : 0,
      ),
    );
    const fees = entryFee.plus(exitFee),
      raw = quantity
        .mul(exit.minus(entry))
        .mul(side === 'LONG' ? 1 : -1)
        .minus(fees)
        .minus(financing);
    const pnl = new D(money(raw));
    // Short debt is fully collateralized at entry, but an OHLC gap can exceed it. Stop the account.
    if (equity.plus(pnl).lt(0))
      throw new Error('Hypothetical short gap exceeded account collateral');
    const slippageCost = new D(
      money(quantity.mul(entry.minus(first.open).abs().plus(exit.minus(mark).abs()))),
    );
    equity = new D(money(equity.plus(pnl)));
    peak = D.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak.minus(equity).div(peak).toNumber());
    feesTotal = feesTotal.plus(fees);
    financingTotal = financingTotal.plus(financing);
    slippageTotal = slippageTotal.plus(slippageCost);
    trades.push({
      eventId: event.id,
      side,
      entryAt: first.at,
      exitAt,
      entryPrice: money(entry),
      exitPrice: money(exit),
      quantity: DecimalStringSchema.parse(quantity.toFixed()),
      stop: money(stop),
      target: money(target),
      netPnl: money(pnl),
      fees: money(fees),
      financing: money(financing),
      slippageCost: money(slippageCost),
      reason,
      status: pnl.gt(0) ? 'WIN' : pnl.lt(0) ? 'LOSS' : 'FLAT',
    });
    nextFree = exitAt + 1;
  }
  return NewsResearchEvaluation.parse({
    phase,
    from,
    to,
    endingUsdt: money(equity),
    netPnl: money(equity.minus(plan.initialUsdt)),
    fees: money(feesTotal),
    financing: money(financingTotal),
    slippageCost: money(slippageTotal),
    maxDrawdown,
    wins: trades.filter((t) => t.status === 'WIN').length,
    trades,
    skipped,
  });
}
export function researchEffects(
  events: ResearchEvent[],
  history: MarketHistory,
  plan: ResearchPlan,
) {
  return [4, 24, 72].flatMap((horizonHours) => {
    const rows = newsHistorySamples(
      events,
      history,
      horizonHours,
      plan.from,
      plan.to,
      plan.latencyMs,
    );
    return [...new Set(rows.map((r) => r.event.group))].sort().map((group) => {
      const selected = rows.filter((r) => r.event.group === group),
        s = sampleStats(selected.map((r) => r.excess));
      return {
        group,
        horizonHours,
        count: selected.length,
        upFraction: selected.filter((r) => r.value > 0).length / selected.length,
        meanReturn: sampleStats(selected.map((r) => r.value)).mean,
        meanExcessReturn: s.mean,
        standardError: s.standardError,
        controlCount: selected.reduce((n, r) => n + r.controls, 0),
        examples: selected.slice(0, 3).map((r) => r.event.id),
      };
    });
  });
}
function studyModels(
  events: ResearchEvent[],
  history: MarketHistory,
  plan: ResearchPlan,
  eligible: number,
) {
  const fixed: ResearchConfig = {
    id: 'fixed-news-rules.v1',
    horizonHours: 24,
    minSamples: 0,
    edgeBuffer: 0,
    uncertaintyZ: 0,
  };
  const candidates = newsResearchCandidates().map((config) => {
    const rules = fitNewsResearchRules(events, history, plan, config),
      evaluation = replayNewsHistory(history, events, plan, config, rules, 'VALIDATION');
    return {
      config,
      rules,
      validationPnl: evaluation.netPnl,
      validationTrades: evaluation.trades.length,
      score:
        evaluation.trades.length >= 3
          ? Number(evaluation.netPnl) - Number(plan.initialUsdt) * evaluation.maxDrawdown * 0.25
          : -1e9,
    };
  });
  const best = [...candidates].sort(
    (a, b) => b.score - a.score || a.config.id.localeCompare(b.config.id),
  )[0]!;
  const selected =
    best.score > 0
      ? best
      : { config: { ...fixed, id: 'cash-insufficient-validation.v1' }, rules: [] };
  return [
    { version: 'RULES_V1' as const, config: fixed, rules: null },
    { version: 'LEARNED_V2' as const, config: selected.config, rules: selected.rules },
  ].map((model) => {
    const evaluations = (['TRAIN', 'VALIDATION', 'TEST'] as const).map((phase) =>
      replayNewsHistory(history, events, plan, model.config, model.rules, phase),
    );
    const test = evaluations[2]!,
      double = replayNewsHistory(history, events, plan, model.config, model.rules, 'TEST', {
        costMultiplier: 2,
      }),
      delayed = replayNewsHistory(history, events, plan, model.config, model.rules, 'TEST', {
        extraLatencyHours: 1,
      });
    const rejectionReasons = [
      'Historical archive content/availability is not point-in-time verified; exploratory results cannot qualify a tradable model.',
    ];
    if (!eligible)
      rejectionReasons.push('No historically available news evidence in this six-month window.');
    if (test.trades.length < 5)
      rejectionReasons.push('Fewer than five independent final-period trades.');
    if (Number(test.netPnl) < 100)
      rejectionReasons.push('Final-period descriptive profit is below the +100 USDT target.');
    if (Number(double.netPnl) <= 0 || Number(delayed.netPnl) <= 0)
      rejectionReasons.push(
        'Positive results do not survive both double-cost and one-hour-delay tests.',
      );
    if (plan.holdoutPreviouslyViewed)
      rejectionReasons.push(
        'This final period has already been viewed in a previous news research version.',
      );
    const body = {
      version: model.version,
      config: model.config,
      rules: model.rules ?? [],
      trials: model.version === 'LEARNED_V2' ? 36 : 1,
      candidates:
        model.version === 'LEARNED_V2'
          ? candidates.map(({ rules, ...c }) => {
              void rules;
              return c;
            })
          : [],
      evaluations,
      doubleCostTestPnl: double.netPnl,
      delayedTestPnl: delayed.netPnl,
      targetReachedDescriptively: Number(test.netPnl) >= 100,
      qualifiedForForwardTest: false,
      rejectionReasons,
    };
    return NewsResearchModel.parse({ ...body, modelHash: canonicalHash(body) });
  });
}
export async function buildNewsHistoryReport(
  snapshot: unknown,
  plan: ResearchPlan,
  markets: {
    asset: MarketHistory['instrument']['asset'];
    history: MarketHistory | null;
    hash: string | null;
    error: string | null;
  }[],
  progress: (s: string) => void | Promise<void> = () => {},
  generatedAt = Date.now(),
): Promise<ResearchReport> {
  const prepared = prepareNewsHistory(snapshot, plan);
  if (prepared.events.length > 1000)
    throw new Error(
      'News research event work budget exceeded; archive needs a separately declared larger protocol',
    );
  const rows: ResearchReport['rows'] = [];
  for (const input of markets) {
    await progress(
      `${input.asset}: fitting 36 development candidates, then evaluating the frozen final period`,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    const events = prepared.events.filter((e) => e.assets.includes(input.asset));
    const eligible = events.filter((e) => e.availableAt <= e.publishedAt + plan.latencyMs).length;
    if (!input.history) {
      rows.push({
        asset: input.asset,
        status: 'NO_MARKET_DATA',
        marketHash: null,
        eventCount: events.length,
        historicallyAvailableEvents: eligible,
        effects: [],
        models: [],
        buyHoldNetPnl: null,
        error: input.error ?? 'Historical market data unavailable',
      });
      continue;
    }
    const history = input.history;
    if (
      history.origin !== 'PUBLIC_HISTORICAL' ||
      history.from !== plan.from ||
      history.to !== plan.to ||
      history.instrument.asset !== input.asset
    )
      throw new Error('News/market frozen window mismatch');
    const passive = new D(plan.initialUsdt)
      .mul(new D(1).minus(plan.feeRate))
      .div(new D(history.bars[0]!.open).mul(new D(1).plus(plan.slippage)))
      .mul(history.bars.at(-1)!.close)
      .mul(new D(1).minus(plan.slippage))
      .mul(new D(1).minus(plan.feeRate));
    rows.push({
      asset: input.asset,
      status: 'COMPLETE',
      marketHash: input.hash,
      eventCount: events.length,
      historicallyAvailableEvents: eligible,
      effects: researchEffects(prepared.events, history, plan),
      models: studyModels(prepared.events, history, plan, eligible),
      buyHoldNetPnl: money(passive.minus(plan.initialUsdt)),
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
    buyHoldNetPnl: money(0),
    error: null,
  });
  return NewsResearchReport.parse({
    version: 'news-history-report.v1',
    origin: 'PUBLIC_HISTORICAL',
    interpretation: 'DESCRIPTIVE_ONLY_NOT_A_TRADABLE_BACKTEST',
    generatedAt,
    engineHash: NEWS_RESEARCH_ENGINE_HASH,
    snapshotHash: canonicalHash(prepared.snapshot),
    planHash: canonicalHash(plan),
    plan,
    coverage: prepared.coverage,
    events: prepared.events,
    rows,
    limitations: [
      'Publication time is an exploratory alignment proxy. Actual first-seen/content-version availability remains separate and excludes archives from tradable fitting.',
      'The learned model is an exploratory hypothesis estimator only. No archived record is promoted into the existing point-in-time NewsEdge training API.',
      'Final test prices are not accessed during candidate selection. Thirty-six candidates per token are selected on validation only; all candidate results are retained.',
      'Sparse and biased source archives do not provide complete six-month crypto news coverage. Missing or undated news is not fabricated.',
      'Event returns and matched control differences are associations, not evidence that the news caused a price change. No consensus expectations or surprise series is available.',
      'Each token and each split uses a separate 10,000 USDT account. Token accounts must not be summed into a fictitious shared 10,000 USDT portfolio.',
      'Shorts are hypothetical fully collateralized borrowing with assumed hourly financing. Actual historical borrow availability, spread, depth and funding are unknown.',
      'Hourly OHLC fills, current instrument filters and fixed fees/slippage are retrospective assumptions; no real exchange position is created.',
      'Headlines/excerpts use a frozen deterministic taxonomy; existing retrospective AI summaries and current model world knowledge are excluded.',
      'USDT is the quote-currency cash control; USDT/USDT positions and profits are not invented.',
      'The selected model uses training-era parameters only. Development results are not out-of-sample profit, and the +100 USDT target is not guaranteed.',
    ],
  });
}
