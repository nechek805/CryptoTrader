import { readFileSync } from 'node:fs';
import {
  BTC_PLAN,
  BTC_PLAN_V2,
  BTC_PLAN_V3,
  BtcReplayWindowSchema,
  BtcReportSchema,
  UtcTimestampSchema,
} from '@crypto/contracts';
import type { BtcReport } from '@crypto/contracts';
import { canonicalHash } from '@crypto/core';
import { SpotLedger, reconcileSpotJournal } from './spot-ledger.js';
import { D, amount, grid } from './spot-math.js';
import { validateBtcHistory } from './btc-test.js';

const HOUR = 3600000;
export const BTC_V3_ENGINE_HASH = canonicalHash(
  [
    './btc-test-v3.ts',
    './btc-comparison-v3.ts',
    './btc-comparison.ts',
    './btc-test-v2.ts',
    './btc-test.ts',
    './spot-ledger.ts',
    './spot-math.ts',
    '../../core/src/canonical.ts',
  ].map((path) => ({ path, source: readFileSync(new URL(path, import.meta.url), 'utf8') })),
);
/** Versioned research engine; original mode must reconcile against the frozen v1 engine. */
export function runBtcThirdRevision(
  input: unknown,
  mode: 'ORIGINAL' | 'FILTERED' | 'QUALITY' = 'QUALITY',
  windowInput?: unknown,
) {
  const data = validateBtcHistory(input),
    v3 = mode === 'QUALITY' ? BTC_PLAN_V3 : null,
    v2 = mode !== 'ORIGINAL' ? BTC_PLAN_V2 : null,
    p = v3 ?? v2 ?? BTC_PLAN,
    ledger = new SpotLedger();
  const window = BtcReplayWindowSchema.parse(
    windowInput ?? { fromIndex: 0, toIndex: data.bars.length },
  );
  if (window.toIndex > data.bars.length)
    throw new Error('Replay window exceeds the source snapshot');
  const stamp = (ms: number) => UtcTimestampSchema.parse(new Date(ms).toISOString());
  ledger.post(stamp(data.from), 'DEPOSIT', [
    { portfolio: 'MARKET_ONLY', asset: 'USDT', account: 'FREE', amount: amount(p.initialUsdt) },
    { portfolio: 'MARKET_ONLY', asset: 'USDT', account: 'EXTERNAL', amount: amount('-10000') },
  ]);
  const balance = (asset: string) => new D(ledger.balance('MARKET_ONLY', asset).free);
  const decisions: BtcReport['decisions'] = [],
    trades: BtcReport['trades'] = [];
  let stop: string | null = null,
    target: string | null = null,
    pending: { side: 'BUY' | 'SELL'; qty: string; atr: string; reason: string } | null = null;
  let fees = new D(0),
    slippage = new D(0),
    peak = new D(10000),
    maxDrawdown = new D(0);
  let bhQty = new D(0),
    bhCash = new D(10000),
    entryCost = new D(0),
    closedTrades = 0,
    wins = 0;
  let dailyStart = new D(10000),
    day = '',
    blocked = false;
  let executionNote: string | null;
  const fill = (
    i: number,
    side: 'BUY' | 'SELL',
    raw: string,
    qty: string,
    reason: string,
    atr?: string,
    intrabar = false,
  ) => {
    const b = data.bars[i]!,
      rate = new D(p.slippageRate);
    const price = new D(
      grid(
        new D(raw).mul(side === 'BUY' ? rate.plus(1) : new D(1).minus(rate)),
        p.priceTick,
        side === 'BUY',
      ),
    );
    let q = new D(qty);
    if (side === 'BUY') {
      const equity = balance('USDT').plus(balance('BTC').mul(raw));
      const unitRisk = new D(atr ?? '0')
        .mul(p.stopAtr)
        .plus(price.mul(new D(p.feeRate).plus(p.slippageRate)).mul(2));
      q = new D(
        grid(
          D.min(
            q,
            equity.mul(p.maxAllocation).div(price),
            equity.mul(p.riskFraction).div(D.max(unitRisk, '0.01')),
            balance('USDT').div(price.mul(new D(1).plus(p.feeRate))),
          ),
          p.quantityStep,
        ),
      );
      if (q.mul(price).lt(p.minNotional) || !atr || new D(atr).lte(0)) {
        if (v2)
          executionNote = 'Entry rejected at next open: rounded quantity or ATR is ineligible.';
        return;
      }
      if (
        v2 &&
        new D(atr)
          .mul(p.targetAtr)
          .lt(price.mul(new D(p.feeRate).plus(p.slippageRate)).mul(2).mul(v2.minRewardCostMultiple))
      ) {
        executionNote =
          'Entry rejected at next open: opening price fails the reward-to-cost requirement.';
        return;
      }
      stop = grid(price.minus(new D(atr).mul(p.stopAtr)), p.priceTick);
      target = grid(price.plus(new D(atr).mul(p.targetAtr)), p.priceTick, true);
      if (new D(stop).lte(0)) {
        stop = null;
        target = null;
        if (v2)
          executionNote = 'Entry rejected at next open: protective stop would be nonpositive.';
        return;
      }
    }
    if (q.lte(0)) return;
    const notional = q.mul(price),
      fee = notional.mul(p.feeRate),
      slip = q.mul(price.minus(raw).abs());
    const at = stamp(b.at + (intrabar ? HOUR - 1 : 0));
    ledger.post(at, 'TRADE', [
      {
        portfolio: 'MARKET_ONLY',
        asset: 'USDT',
        account: 'FREE',
        amount: amount(side === 'BUY' ? notional.neg() : notional),
      },
      {
        portfolio: 'MARKET_ONLY',
        asset: 'USDT',
        account: 'EXTERNAL',
        amount: amount(side === 'BUY' ? notional : notional.neg()),
      },
      {
        portfolio: 'MARKET_ONLY',
        asset: 'BTC',
        account: 'FREE',
        amount: amount(side === 'BUY' ? q : q.neg()),
      },
      {
        portfolio: 'MARKET_ONLY',
        asset: 'BTC',
        account: 'EXTERNAL',
        amount: amount(side === 'BUY' ? q.neg() : q),
      },
    ]);
    ledger.post(at, 'FEE', [
      { portfolio: 'MARKET_ONLY', asset: 'USDT', account: 'FREE', amount: amount(fee.neg()) },
      { portfolio: 'MARKET_ONLY', asset: 'USDT', account: 'FEES', amount: amount(fee) },
    ]);
    trades.push({
      index: i,
      at: Date.parse(at),
      side,
      reason,
      quantity: amount(q),
      price: amount(price),
      fee: amount(fee),
      slippage: amount(slip),
      stop: stop ? amount(stop) : null,
      target: target ? amount(target) : null,
    });
    fees = fees.plus(fee);
    slippage = slippage.plus(slip);
    if (side === 'BUY') entryCost = notional.plus(fee);
    else {
      closedTrades++;
      if (notional.minus(fee).gt(entryCost)) wins++;
      stop = null;
      target = null;
    }
  };
  for (let i = 0; i < window.toIndex; i++) {
    executionNote = null;
    const b = data.bars[i]!,
      today = new Date(b.at).toISOString().slice(0, 10);
    if (today !== day) {
      day = today;
      dailyStart = i ? new D(decisions[i - 1]!.equity) : new D(10000);
      blocked = false;
    }
    if (pending) {
      if (pending.side === 'SELL' || !blocked)
        fill(i, pending.side, b.open, pending.qty, pending.reason, pending.atr);
      pending = null;
    }
    // Stops are adverse first if both levels are crossed; gaps execute at the worse open.
    if (balance('BTC').gt(0) && stop && target) {
      if (new D(b.low).lte(stop))
        fill(
          i,
          'SELL',
          amount(D.min(b.open, stop)),
          amount(balance('BTC')),
          'STOP (adverse-first candle assumption)',
          undefined,
          true,
        );
      else if (new D(b.high).gte(target))
        fill(
          i,
          'SELL',
          target,
          amount(balance('BTC')),
          'TARGET (simulated market exit, no limit-fill claim)',
          undefined,
          true,
        );
    }
    if (i === Math.max(50, window.fromIndex + 1)) {
      const price = new D(
        grid(new D(b.open).mul(new D(1).plus(p.slippageRate)), p.priceTick, true),
      );
      bhQty = new D(grid(bhCash.div(price.mul(new D(1).plus(p.feeRate))), p.quantityStep));
      bhCash = bhCash.minus(bhQty.mul(price).mul(new D(1).plus(p.feeRate)));
    }
    const equity = balance('USDT').plus(balance('BTC').mul(b.close));
    if (equity.lte(dailyStart.mul(new D(1).minus(p.dailyLossFraction)))) blocked = true;
    peak = D.max(peak, equity);
    maxDrawdown = D.max(maxDrawdown, peak.minus(equity).div(peak));
    const avg = (n: number) =>
      i + 1 < n
        ? null
        : amount(
            data.bars
              .slice(i + 1 - n, i + 1)
              .reduce((sum, b) => sum.plus(b.close), new D(0))
              .div(n)
              .toDecimalPlaces(12),
          );
    const fast = avg(p.fast),
      slow = avg(p.slow);
    const atr =
      i < p.atr
        ? null
        : amount(
            data.bars
              .slice(i + 1 - p.atr, i + 1)
              .reduce((sum, b, j) => {
                const prev = data.bars[i - p.atr + j]!.close;
                return sum.plus(
                  D.max(
                    new D(b.high).minus(b.low),
                    new D(b.high).minus(prev).abs(),
                    new D(b.low).minus(prev).abs(),
                  ),
                );
              }, new D(0))
              .div(p.atr)
              .toDecimalPlaces(12),
          );
    const prev = decisions.at(-1),
      bullish = fast !== null && slow !== null && new D(fast).gt(slow);
    const cross =
      bullish &&
      (v2
        ? !!prev?.slow && new D(prev.fast!).lte(prev.slow)
        : !prev?.slow || new D(prev.fast!).lte(prev.slow) || i === window.fromIndex);
    const trend = v2 && i + 1 >= v2.trend + v2.trendSlopeHours ? avg(v2.trend) : null;
    const earlierTrend =
      trend && v2
        ? data.bars
            .slice(i + 1 - v2.trend - v2.trendSlopeHours, i + 1 - v2.trendSlopeHours)
            .reduce((s, b) => s.plus(b.close), new D(0))
            .div(v2.trend)
        : null;
    const trendRising = trend && earlierTrend ? new D(trend).gt(earlierTrend) : null;
    const rewardCostRatio = atr
      ? amount(
          new D(atr)
            .mul(p.targetAtr)
            .div(new D(b.close).mul(new D(p.feeRate).plus(p.slippageRate)).mul(2))
            .toDecimalPlaces(12),
        )
      : null;
    const signalRange = new D(b.high).minus(b.low);
    const signalRangeAtr =
      atr && new D(atr).gt(0) ? amount(signalRange.div(atr).toDecimalPlaces(12)) : null;
    const closeLocation = signalRange.gt(0)
      ? amount(new D(b.close).minus(b.low).div(signalRange).toDecimalPlaces(12))
      : null;
    const entryGate: NonNullable<BtcReport['decisions'][number]['entryGate']> = !trend
      ? 'WARMUP'
      : !trendRising || new D(b.close).lte(trend)
        ? 'TREND_BLOCK'
        : new D(rewardCostRatio ?? '0').lt(v2!.minRewardCostMultiple)
          ? 'COST_BLOCK'
          : v3 && signalRange.gt(new D(atr!).mul(v3.maxSignalRangeAtr))
            ? 'SHOCK_BLOCK'
            : v3 &&
                (!signalRange.gt(0) ||
                  new D(b.close).minus(b.low).lt(signalRange.mul(v3.minCloseLocation)))
              ? 'WEAK_CLOSE_BLOCK'
              : 'PASS';
    let action: BtcReport['decisions'][number]['action'] = 'HOLD',
      reason = 'No new bullish crossover; stay in cash.';
    let qty = amount(0);
    if (i < window.fromIndex || !slow || !atr || (v2 && !trend)) {
      action = 'WARMUP';
      reason =
        i < window.fromIndex
          ? 'Pre-window context only; no virtual orders.'
          : v2
            ? 'Need 224 completed hours for MA200 and its 24-hour slope.'
            : 'Need 50 completed hourly candles; no order.';
    } else if (balance('BTC').gt(0)) {
      reason = 'Fast MA remains above slow MA; keep protective stop and target.';
      if (!bullish || blocked) {
        action = 'EXIT';
        qty = amount(balance('BTC'));
        reason = blocked ? 'Daily loss limit reached.' : 'Fast MA is at or below slow MA.';
        pending = { side: 'SELL', qty, atr, reason };
      }
    } else if (blocked) reason = 'Daily loss limit: new entries blocked until next UTC day.';
    else if (v2 && entryGate !== 'PASS')
      reason =
        entryGate === 'TREND_BLOCK'
          ? 'Entry blocked: price must exceed a rising MA200.'
          : entryGate === 'COST_BLOCK'
            ? 'Entry blocked: 3 ATR target must cover at least 3 times estimated round-trip costs.'
            : entryGate === 'SHOCK_BLOCK'
              ? 'Entry blocked: signal candle range exceeds 2 ATR.'
              : 'Entry blocked: signal candle must close in the upper half of a nonzero range.';
    else if (cross && new D(atr).gt(0)) {
      // Size using known close and prior completed volume, never the execution candle volume.
      const riskPerUnit = new D(atr)
        .mul(p.stopAtr)
        .plus(new D(b.close).mul(new D(p.feeRate).plus(p.slippageRate)).mul(2));
      qty = grid(
        D.min(
          equity.mul(p.riskFraction).div(riskPerUnit),
          equity.mul(p.maxAllocation).div(b.close),
          new D(b.volume).mul(p.maxVolumeFraction),
        ),
        p.quantityStep,
      );
      if (new D(qty).mul(b.close).gte(p.minNotional)) {
        action = 'LONG';
        reason = prev?.slow
          ? 'Bullish MA20/MA50 crossover; risk and allocation caps applied.'
          : 'First full MA50 window is bullish; risk and allocation caps applied.';
        pending = { side: 'BUY', qty, atr, reason };
      } else reason = 'Entry rejected: rounded quantity is below the assumed minimum notional.';
    }
    if (i === window.toIndex - 1 && pending) {
      reason += ' No following candle: order is not filled.';
      pending = null;
    }
    decisions.push({
      index: i,
      at: b.at + HOUR,
      action,
      reason,
      fast,
      slow,
      atr,
      quantity: qty,
      stop: stop ? amount(stop) : null,
      target: target ? amount(target) : null,
      cash: amount(balance('USDT')),
      btc: amount(balance('BTC')),
      equity: amount(equity),
      buyHold: amount(bhCash.plus(bhQty.mul(b.close))),
      ...(v2 ? { trend, trendRising, rewardCostRatio, entryGate } : {}),
      ...(v3 ? { signalRangeAtr, closeLocation } : {}),
      ...(executionNote ? { executionNote } : {}),
    });
  }
  reconcileSpotJournal(ledger.entries);
  const last = decisions.at(-1)!;
  const report = BtcReportSchema.parse({
    version: 'btc-retrospective.v3',
    window,
    origin: data.origin,
    datasetId: canonicalHash(data),
    planHash: canonicalHash(p),
    engineHash: BTC_V3_ENGINE_HASH,
    plan: p,
    interpretation: 'RETROSPECTIVE_ASSUMPTIONS_NOT_FORWARD_VERIFIED',
    decisions,
    trades,
    journalHash: canonicalHash(ledger.entries),
    summary: {
      finalEquity: last.equity,
      netPnl: amount(new D(last.equity).minus(10000)),
      returnFraction: amount(new D(last.equity).div(10000).minus(1)),
      maxDrawdown: amount(maxDrawdown.toDecimalPlaces(18)),
      fees: amount(fees),
      slippage: amount(slippage),
      closedTrades,
      wins,
      buyHoldEquity: last.buyHold,
      cashEquity: '10000',
      openBtc: last.btc,
    },
  });
  return { id: canonicalHash(report), report, journal: ledger.entries };
}

export function verifyBtcThirdRevision(input: unknown, data: unknown) {
  const report = BtcReportSchema.parse(input),
    rebuilt = runBtcThirdRevision(
      data,
      report.plan.version === BTC_PLAN_V3.version
        ? 'QUALITY'
        : report.plan.version === BTC_PLAN_V2.version
          ? 'FILTERED'
          : 'ORIGINAL',
      report.window,
    );
  if (canonicalHash(report) !== rebuilt.id) throw new Error('Retrospective replay mismatch');
  return rebuilt;
}
