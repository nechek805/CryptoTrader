import { readFileSync } from 'node:fs';
import {
  BTC_PLAN,
  BTC_PLAN_V2,
  BTC_PLAN_V3,
  DirectionProfileSchema,
  DirectionModeSchema,
  MarketFeeModeSchema,
  DirectionReportSchema,
  SHORT_ASSUMPTIONS,
} from '@crypto/contracts';
import type { DirectionReport, MarginJournal, MarketHistory } from '@crypto/contracts';
import { canonicalHash } from '@crypto/core';
import { validateMarketHistory } from '@crypto/research';
import { D, amount, grid } from './spot-math.js';
import { MarginResearchLedger, reconcileMarginResearchJournal } from './margin-research-ledger.js';
export const DIRECTION_ENGINE_HASH = canonicalHash(
  [
    './directional-runner.ts',
    './margin-research-ledger.ts',
    '../../contracts/src/directional-tests.ts',
    '../../contracts/src/btc-test.ts',
    '../../contracts/src/primitives.ts',
    '../../contracts/src/market-tests.ts',
    '../../contracts/src/specialist-tests.ts',
    '../../contracts/src/specialist-v5.ts',
    '../../research/src/market-test-history.ts',
    './spot-math.ts',
    '../../core/src/canonical.ts',
  ].map((path) => ({ path, source: readFileSync(new URL(path, import.meta.url), 'utf8') })),
);
type Num = InstanceType<typeof D>;
type Side = 'LONG' | 'SHORT';
function indicators(data: MarketHistory) {
  const sums: Num[] = [new D(0)],
    trs: Num[] = [new D(0)];
  return data.bars.map((b, i) => {
    sums.push(sums[i]!.plus(b.close));
    const prev = data.bars[Math.max(0, i - 1)]!.close;
    trs.push(
      trs[i]!.plus(
        D.max(
          new D(b.high).minus(b.low),
          new D(b.high).minus(prev).abs(),
          new D(b.low).minus(prev).abs(),
        ),
      ),
    );
    const avg = (n: number, end = i + 1) =>
      end < n
        ? null
        : amount(
            sums[end]!.minus(sums[end - n]!)
              .div(n)
              .toDecimalPlaces(12),
          );
    return {
      fast: avg(20),
      slow: avg(50),
      atr:
        i < 14
          ? null
          : amount(
              trs[i + 1]!.minus(trs[i + 1 - 14]!)
                .div(14)
                .toDecimalPlaces(12),
            ),
      trend: i + 1 < 224 ? null : avg(200),
      earlier: i + 1 < 224 ? null : avg(200, i + 1 - 24),
    };
  });
}
/** Fresh strategy extension: old spot engines and immutable reports are untouched. */
export function runDirectionalTest(
  input: unknown,
  profileInput: unknown,
  modeInput: unknown = 'LONG_SHORT',
  feeInput: unknown = 'STANDARD',
) {
  const data = validateMarketHistory(input),
    profile = DirectionProfileSchema.parse(profileInput),
    mode = DirectionModeSchema.parse(modeInput),
    feeMode = MarketFeeModeSchema.parse(feeInput);
  if (profile.asset !== data.instrument.asset)
    throw new Error('Directional profile instrument mismatch');
  const candidate = profile.candidate,
    base = candidate?.base ?? profile.strategy,
    filtered = base !== 'V1',
    quality = base === 'V3',
    reference = quality ? BTC_PLAN_V3 : filtered ? BTC_PLAN_V2 : BTC_PLAN;
  const p = {
    ...reference,
    stopAtr: candidate?.stopAtr ?? reference.stopAtr,
    targetAtr: candidate?.targetAtr ?? reference.targetAtr,
    feeRate: feeMode === 'STANDARD' ? SHORT_ASSUMPTIONS.feeRate : '0',
    ...data.instrument.filters,
  };
  const plan = { profile, mode, feeMode, assumptions: SHORT_ASSUMPTIONS },
    ledger = new MarginResearchLedger(),
    asset = data.instrument.asset,
    HOUR = 3600000;
  const post = (at: number, kind: MarginJournal['kind'], rows: [string, string, string | Num][]) =>
    ledger.post(
      at,
      kind,
      rows.map(([a, account, value]) => ({
        asset: a as MarginJournal['postings'][number]['asset'],
        account: account as MarginJournal['postings'][number]['account'],
        amount: amount(value),
      })),
    );
  post(data.from, 'DEPOSIT', [
    ['USDT', 'FREE', '10000'],
    ['USDT', 'EXTERNAL', '-10000'],
  ]);
  const cash = () => ledger.balance('USDT', 'FREE'),
    totalCash = () =>
      cash()
        .plus(ledger.balance('USDT', 'RESERVED'))
        .plus(ledger.balance('USDT', 'PROCEEDS'))
        .plus(ledger.balance('USDT', 'DEBT'));
  const state: {
    position: null | {
      side: Side;
      qty: Num;
      entry: Num;
      atr: Num;
      stop: Num;
      target: Num;
      fee: Num;
      financing: Num;
      principal: Num;
    };
  } = { position: null };
  const equity = (price: string) =>
    totalCash().plus(ledger.balance(asset, 'FREE').plus(ledger.balance(asset, 'DEBT')).mul(price));
  const decisions: DirectionReport['decisions'] = [],
    trades: DirectionReport['trades'] = [],
    features = indicators(data);
  let pending: null | {
      close: boolean;
      side?: Side;
      qty: string;
      atr: string;
      targetAtr: string;
      reason: string;
    } = null,
    day = '',
    dailyStart = new D(10000),
    blocked = false,
    peak = new D(10000),
    maxDrawdown = new D(0),
    fees = new D(0),
    slippage = new D(0),
    financing = new D(0),
    bhCash = new D(10000),
    bhQty = new D(0),
    halted = false;
  const totals = {
    LONG: { closedTrades: 0, wins: 0, net: new D(0) },
    SHORT: { closedTrades: 0, wins: 0, net: new D(0) },
  };
  function deficit(at: number, needed: Num) {
    if (needed.gt(0)) {
      post(at, 'DEFAULT', [
        ['USDT', 'FREE', needed],
        ['USDT', 'DEBT', needed.neg()],
      ]);
      halted = true;
    }
  }
  function exit(i: number, raw: string, reason: string, intrabar = false) {
    const pos = state.position;
    if (!pos) return;
    const buy = pos.side === 'SHORT',
      price = new D(grid(new D(raw).mul(buy ? '1.0005' : '0.9995'), p.priceTick, buy)),
      notional = pos.qty.mul(price),
      fee = notional.mul(p.feeRate),
      slip = pos.qty.mul(price.minus(raw).abs()),
      at = data.bars[i]!.at + (intrabar ? HOUR - 1 : 0),
      rows: [string, string, string | Num][] = [];
    if (buy) {
      deficit(at, D.max(0, notional.plus(fee).minus(cash().plus(pos.principal.mul(2)))));
      rows.push(
        ['USDT', 'PROCEEDS', pos.principal.neg()],
        ['USDT', 'RESERVED', pos.principal.neg()],
        ['USDT', 'FREE', pos.principal.mul(2).minus(notional).minus(fee)],
        ['USDT', 'EXTERNAL', notional],
        ['USDT', 'FEES', fee],
        [asset, 'DEBT', pos.qty],
        [asset, 'EXTERNAL', pos.qty.neg()],
      );
    } else
      rows.push(
        ['USDT', 'FREE', notional.minus(fee)],
        ['USDT', 'EXTERNAL', notional.neg()],
        ['USDT', 'FEES', fee],
        [asset, 'FREE', pos.qty.neg()],
        [asset, 'EXTERNAL', pos.qty],
      );
    post(at, 'CLOSE', rows);
    const net = pos.qty
        .mul(buy ? pos.entry.minus(price) : price.minus(pos.entry))
        .minus(pos.fee)
        .minus(fee)
        .minus(pos.financing),
      group = totals[pos.side];
    group.closedTrades++;
    if (net.gt(0)) group.wins++;
    group.net = group.net.plus(net);
    fees = fees.plus(fee);
    slippage = slippage.plus(slip);
    trades.push({
      index: i,
      at,
      kind: 'CLOSE',
      direction: pos.side,
      side: buy ? 'BUY' : 'SELL',
      quantity: amount(pos.qty),
      price: amount(price),
      fee: amount(fee),
      slippage: amount(slip),
      financing: amount(pos.financing),
      net: amount(net),
      reason,
      stop: amount(pos.stop),
      target: amount(pos.target),
    });
    state.position = null;
    if (equity(raw).lte(0)) halted = true;
  }
  function enter(i: number, order: NonNullable<typeof pending>) {
    if (!order.side || state.position || halted || blocked) return;
    const side = order.side,
      buy = side === 'LONG',
      b = data.bars[i]!,
      price = new D(grid(new D(b.open).mul(buy ? '1.0005' : '0.9995'), p.priceTick, buy)),
      atr = new D(order.atr),
      costRate = new D(p.feeRate)
        .plus(p.slippageRate)
        .mul(2)
        .plus(buy ? 0 : new D('0.1').mul(24).div(8760));
    const q = new D(
      grid(
        D.min(
          order.qty,
          equity(b.open).mul(p.maxAllocation).div(price),
          equity(b.open)
            .mul(p.riskFraction)
            .div(D.max(atr.mul(p.stopAtr).plus(price.mul(costRate)), '0.01')),
          cash().div(price.mul(new D(1).plus(p.feeRate))),
          p.maxQty,
        ),
        p.quantityStep,
      ),
    );
    if (q.lt(p.minQty) || q.mul(price).lt(p.minNotional) || atr.lte(0)) return;
    if (filtered && atr.mul(order.targetAtr).lt(price.mul(costRate).mul(3))) return;
    const stop = new D(
        grid(
          buy ? price.minus(atr.mul(p.stopAtr)) : price.plus(atr.mul(p.stopAtr)),
          p.priceTick,
          !buy,
        ),
      ),
      target = new D(
        grid(
          buy ? price.plus(atr.mul(order.targetAtr)) : price.minus(atr.mul(order.targetAtr)),
          p.priceTick,
          buy,
        ),
      );
    if (stop.lte(0) || target.lte(0)) return;
    const n = q.mul(price),
      fee = n.mul(p.feeRate),
      slip = q.mul(price.minus(b.open).abs());
    if (buy)
      post(b.at, 'OPEN', [
        ['USDT', 'FREE', n.plus(fee).neg()],
        ['USDT', 'EXTERNAL', n],
        ['USDT', 'FEES', fee],
        [asset, 'FREE', q],
        [asset, 'EXTERNAL', q.neg()],
      ]);
    else
      post(b.at, 'OPEN', [
        ['USDT', 'FREE', n.plus(fee).neg()],
        ['USDT', 'RESERVED', n],
        ['USDT', 'PROCEEDS', n],
        ['USDT', 'EXTERNAL', n.neg()],
        ['USDT', 'FEES', fee],
        [asset, 'DEBT', q.neg()],
        [asset, 'EXTERNAL', q],
      ]);
    fees = fees.plus(fee);
    slippage = slippage.plus(slip);
    state.position = {
      side,
      qty: q,
      entry: price,
      atr,
      stop,
      target,
      fee,
      financing: new D(0),
      principal: n,
    };
    trades.push({
      index: i,
      at: b.at,
      kind: 'OPEN',
      direction: side,
      side: buy ? 'BUY' : 'SELL',
      quantity: amount(q),
      price: amount(price),
      fee: amount(fee),
      slippage: amount(slip),
      financing: amount(0),
      net: null,
      reason: order.reason,
      stop: amount(stop),
      target: amount(target),
    });
  }
  for (let i = 0; i < data.bars.length; i++) {
    const b = data.bars[i]!,
      f = features[i]!,
      today = new Date(b.at).toISOString().slice(0, 10);
    if (today !== day) {
      day = today;
      dailyStart = i ? new D(decisions[i - 1]!.equity) : new D(10000);
      blocked = false;
    }
    if (pending) {
      if (pending.close) exit(i, b.open, pending.reason);
      enter(i, pending);
      pending = null;
    }
    const pos = state.position;
    if (pos?.side === 'SHORT') {
      const charge = pos.principal.mul('0.1').div(8760).toDecimalPlaces(18);
      deficit(b.at + HOUR - 1, D.max(0, charge.minus(cash())));
      post(b.at + HOUR - 1, 'FINANCING', [
        ['USDT', 'FREE', charge.neg()],
        ['USDT', 'FINANCING', charge],
      ]);
      financing = financing.plus(charge);
      pos.financing = pos.financing.plus(charge);
    }
    if (pos) {
      const long = pos.side === 'LONG',
        liquidation = new D(
          grid(
            pos.principal
              .mul(2)
              .div(pos.qty.mul(new D(1).plus(p.feeRate).plus(p.slippageRate).plus('0.005'))),
            p.priceTick,
          ),
        ),
        adverse = long ? pos.stop : D.min(pos.stop, liquidation),
        stopHit = long ? new D(b.low).lte(adverse) : new D(b.high).gte(adverse),
        targetHit = long ? new D(b.high).gte(pos.target) : new D(b.low).lte(pos.target);
      if (stopHit)
        exit(
          i,
          amount(long ? D.min(b.open, adverse) : D.max(b.open, adverse)),
          !long && liquidation.lte(pos.stop)
            ? 'MARGIN_CLOSE (adverse-first, worse gap)'
            : 'STOP (adverse-first, worse gap)',
          true,
        );
      else if (targetHit) exit(i, amount(pos.target), 'TARGET (market exit assumption)', true);
      else if (halted) exit(i, b.close, 'FINANCING_DEFAULT', true);
    }
    if (i === 50) {
      const price = new D(grid(new D(b.open).mul('1.0005'), p.priceTick, true));
      bhQty = new D(grid(bhCash.div(price.mul(new D(1).plus(p.feeRate))), p.quantityStep));
      bhCash = bhCash.minus(bhQty.mul(price).mul(new D(1).plus(p.feeRate)));
    }
    const value = equity(b.close);
    peak = D.max(peak, value);
    maxDrawdown = D.max(maxDrawdown, peak.minus(value).div(peak));
    if (value.lte(dailyStart.mul('0.98'))) blocked = true;
    if (value.lte(0)) halted = true;
    const bullish = !!f.fast && !!f.slow && new D(f.fast).gt(f.slow),
      bearish = !!f.fast && !!f.slow && new D(f.fast).lt(f.slow),
      previous = features[i - 1],
      crossLong = bullish && (!previous?.slow || new D(previous.fast!).lte(previous.slow)),
      crossShort = bearish && (!previous?.slow || new D(previous.fast!).gte(previous.slow));
    const trendRising = f.trend && f.earlier ? new D(f.trend).gt(f.earlier) : null,
      range = new D(b.high).minus(b.low),
      rangeAtr = f.atr && new D(f.atr).gt(0) ? amount(range.div(f.atr).toDecimalPlaces(12)) : null,
      location = range.gt(0)
        ? amount(new D(b.close).minus(b.low).div(range).toDecimalPlaces(12))
        : null;
    let targetAtr: string = p.targetAtr;
    if (
      candidate &&
      'lowVolatilityThreshold' in candidate &&
      candidate.lowVolatilityThreshold &&
      f.atr &&
      new D(f.atr).div(b.close).lte(candidate.lowVolatilityThreshold)
    )
      targetAtr = candidate.lowVolatilityTargetAtr!;
    if (
      candidate &&
      'adaptiveLowerAtr' in candidate &&
      candidate.adaptiveLowerAtr &&
      rangeAtr &&
      new D(rangeAtr).gte(candidate.adaptiveLowerAtr) &&
      new D(rangeAtr).lte('1.8')
    )
      targetAtr = candidate.adaptiveTargetAtr!;
    const gate = (side: Side) => {
      if (!f.slow || !f.atr || (filtered && !f.trend)) return 'WARMUP';
      if (
        filtered &&
        (side === 'LONG'
          ? !(trendRising && new D(b.close).gt(f.trend!))
          : !(f.earlier && new D(f.trend!).lt(f.earlier) && new D(b.close).lt(f.trend!)))
      )
        return 'TREND_BLOCK';
      const cost = new D(b.close).mul(
        new D(p.feeRate)
          .plus(p.slippageRate)
          .mul(2)
          .plus(side === 'SHORT' ? new D('0.1').mul(24).div(8760) : 0),
      );
      if (filtered && new D(f.atr).mul(targetAtr).lt(cost.mul(3))) return 'COST_BLOCK';
      if (quality && range.gt(new D(f.atr).mul(2))) return 'SHOCK_BLOCK';
      if (
        quality &&
        candidate?.minSignalRangeAtr &&
        range.lt(new D(f.atr).mul(candidate.minSignalRangeAtr))
      )
        return 'QUIET_BLOCK';
      if (
        quality &&
        (!location || (side === 'LONG' ? new D(location).lt('0.5') : new D(location).gt('0.5')))
      )
        return 'WEAK_CLOSE_BLOCK';
      return 'PASS';
    };
    const longGate = gate('LONG'),
      shortGate = gate('SHORT'),
      current = state.position;
    let action: DirectionReport['decisions'][number]['action'] = 'HOLD',
      reason = 'No fresh eligible crossover.',
      quantity = amount(0);
    if (halted) {
      action = 'HALTED';
      reason = 'Account insolvent; debt retained and new orders blocked.';
    } else if (longGate === 'WARMUP') {
      action = 'WARMUP';
      reason = filtered ? 'Need 224 completed hours.' : 'Need 50 completed hours.';
    } else {
      const close = !!current && (blocked || (current.side === 'LONG' ? !bullish : !bearish));
      const openSide: Side | null =
        !blocked &&
        crossLong &&
        mode !== 'SHORT_ONLY' &&
        longGate === 'PASS' &&
        current?.side !== 'LONG'
          ? 'LONG'
          : !blocked &&
              crossShort &&
              mode !== 'LONG_ONLY' &&
              shortGate === 'PASS' &&
              current?.side !== 'SHORT'
            ? 'SHORT'
            : null;
      if (close) {
        action = 'EXIT';
        reason = blocked ? 'Daily loss limit reached.' : 'Trend crossover exit.';
        pending = { close: true, qty: '0', atr: f.atr!, targetAtr, reason };
        quantity = amount(current.qty);
      }
      if (openSide && (!current || close)) {
        const cost = new D(b.close).mul(
          new D(p.feeRate)
            .plus(p.slippageRate)
            .mul(2)
            .plus(openSide === 'SHORT' ? new D('0.1').mul(24).div(8760) : 0),
        );
        quantity = grid(
          D.min(
            value.mul(p.riskFraction).div(new D(f.atr!).mul(p.stopAtr).plus(cost)),
            value.mul(p.maxAllocation).div(b.close),
            new D(b.volume).mul(p.maxVolumeFraction),
          ),
          p.quantityStep,
        );
        if (new D(quantity).mul(b.close).gte(p.minNotional)) {
          action = openSide;
          reason = `${close ? 'Close then reverse: ' : ''}${openSide === 'LONG' ? 'Bullish' : 'Bearish'} MA20/50 crossover; ${openSide.toLowerCase()} gate passed.`;
          pending = { close, side: openSide, qty: quantity, atr: f.atr!, targetAtr, reason };
        }
      }
    }
    if (i === data.bars.length - 1 && pending) {
      reason += ' No next candle; order not filled.';
      pending = null;
    }
    const active = state.position;
    if (active && candidate && 'trailDistanceAtr' in candidate && candidate.trailDistanceAtr) {
      const reached =
        active.side === 'LONG'
          ? new D(b.close).gte(active.entry.plus(active.atr.mul(3)))
          : new D(b.close).lte(active.entry.minus(active.atr.mul(3)));
      if (reached)
        active.stop = new D(
          grid(
            active.side === 'LONG'
              ? D.max(active.stop, new D(b.close).minus(active.atr.mul(candidate.trailDistanceAtr)))
              : D.min(active.stop, new D(b.close).plus(active.atr.mul(candidate.trailDistanceAtr))),
            p.priceTick,
            active.side === 'SHORT',
          ),
        );
    }
    decisions.push({
      index: i,
      at: b.at + HOUR,
      action,
      reason,
      fast: f.fast,
      slow: f.slow,
      atr: f.atr,
      trend: f.trend,
      trendRising,
      positionSide: active?.side ?? null,
      position: amount(active ? (active.side === 'LONG' ? active.qty : active.qty.neg()) : 0),
      quantity,
      stop: active ? amount(active.stop) : null,
      target: active ? amount(active.target) : null,
      targetAtr: amount(targetAtr),
      signalRangeAtr: rangeAtr,
      closeLocation: location,
      longGate,
      shortGate,
      cash: amount(cash()),
      collateral: amount(ledger.balance('USDT', 'RESERVED')),
      loan: amount(ledger.balance(asset, 'DEBT').neg()),
      badDebt: amount(ledger.balance('USDT', 'DEBT').neg()),
      equity: amount(value),
      buyHold: amount(bhCash.plus(bhQty.mul(b.close))),
      financing: amount(financing),
    });
  }
  reconcileMarginResearchJournal(ledger.entries);
  const last = decisions.at(-1)!,
    closedNet = totals.LONG.net.plus(totals.SHORT.net),
    summary = {
      finalEquity: last.equity,
      netPnl: amount(new D(last.equity).minus(10000)),
      returnFraction: amount(new D(last.equity).div(10000).minus(1)),
      maxDrawdown: amount(maxDrawdown.toDecimalPlaces(18)),
      fees: amount(fees),
      slippage: amount(slippage),
      closedTrades: totals.LONG.closedTrades + totals.SHORT.closedTrades,
      wins: totals.LONG.wins + totals.SHORT.wins,
      buyHoldEquity: last.buyHold,
      cashEquity: '10000',
      openBase: last.position,
      financing: amount(financing),
      collateral: last.collateral,
      loan: last.loan,
      badDebt: last.badDebt,
      insolvent: halted,
      long: { ...totals.LONG, net: amount(totals.LONG.net) },
      short: { ...totals.SHORT, net: amount(totals.SHORT.net) },
      openContribution: amount(new D(last.equity).minus(10000).minus(closedNet)),
    };
  const report = DirectionReportSchema.parse({
    version: 'directional-replay.v1',
    asset,
    symbol: data.instrument.symbol,
    datasetId: canonicalHash(data),
    engineHash: DIRECTION_ENGINE_HASH,
    planHash: canonicalHash(plan),
    plan,
    origin: data.origin,
    interpretation: 'SPOT_PRICE_PROXY_WITH_ASSUMED_BORROW_NOT_FORWARD_VERIFIED',
    decisions,
    trades,
    summary,
    journalHash: canonicalHash(ledger.entries),
  });
  return { id: canonicalHash(report), report, journal: ledger.entries };
}
export function verifyDirectionalReport(input: unknown, data: unknown) {
  const report = DirectionReportSchema.parse(input),
    rebuilt = runDirectionalTest(data, report.plan.profile, report.plan.mode, report.plan.feeMode);
  if (canonicalHash(report) !== rebuilt.id) throw new Error('Directional replay mismatch');
  return rebuilt;
}
