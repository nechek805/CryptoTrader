import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import { canonicalHash } from '@crypto/core';
import { freshLiveBook } from '@crypto/connectors';
import { LIVE_EXCHANGES, LiveRunSchema, ShortV6ProfileSchema } from '@crypto/contracts';
import type {
  LiveRun,
  LiveBook,
  LiveBars,
  LiveInstrument,
  LivePosition,
  LiveAsset,
  LiveExchange,
  BtcHour,
} from '@crypto/contracts';
const D = Decimal.clone({ precision: 48, rounding: Decimal.ROUND_HALF_UP });
const n = (v: Decimal.Value) => new D(v);
export const liveAmount = (v: Decimal.Value) => n(v).toDecimalPlaces(18).toFixed();
const floor = (value: Decimal.Value, step: string) => n(value).div(step).floor().mul(step);
function positionId(runId: string, key: string, at: number, side: string) {
  const h = canonicalHash({ runId, key, at, side }).slice(7);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const priceGrid = (value: Decimal.Value, tick: string, buy: boolean) =>
  n(value)
    .div(tick)
    .toDecimalPlaces(0, buy ? D.ROUND_CEIL : D.ROUND_FLOOR)
    .mul(tick);
export interface LiveMarket {
  book: LiveBook | null;
  bars: LiveBars | null;
  instrument: LiveInstrument | null;
}
export const liveKey = (e: LiveExchange, a: LiveAsset) => `${e}:${a}`;
export function liveSignal(
  bars: BtcHour[],
  asset: LiveAsset,
  feeRate: string,
  profileInput: unknown,
) {
  const profile = ShortV6ProfileSchema.parse(profileInput);
  if (profile.strategy !== 'V6' || profile.asset !== asset || profile.shortRules.kind !== 'TUNED')
    throw new Error('Frozen V6 profile required');
  if (bars.length < 224) return null;
  const i = bars.length - 1,
    b = bars[i]!,
    c = profile.candidate,
    s = profile.shortRules;
  const avg = (count: number, end = bars.length) =>
    bars
      .slice(end - count, end)
      .reduce((v, b) => v.plus(b.close), n(0))
      .div(count)
      .toDecimalPlaces(12);
  const fast = avg(20),
    slow = avg(50),
    oldFast = avg(20, i),
    oldSlow = avg(50, i),
    trend = avg(200),
    earlier = avg(200, bars.length - 24);
  const atr = bars
    .slice(-14)
    .reduce((v, b, j) => {
      const prev = bars[i - 14 + j]!.close;
      return v.plus(
        D.max(n(b.high).minus(b.low), n(b.high).minus(prev).abs(), n(b.low).minus(prev).abs()),
      );
    }, n(0))
    .div(14)
    .toDecimalPlaces(12);
  if (atr.lte(0)) return null;
  const range = n(b.high).minus(b.low),
    rangeAtr = range.div(atr),
    location = range.eq(0) ? n(0) : n(b.close).minus(b.low).div(range),
    slope = earlier.minus(trend).div(atr),
    distance = trend.minus(b.close).div(atr);
  let target: string = c.targetAtr;
  if (
    'lowVolatilityThreshold' in c &&
    c.lowVolatilityThreshold &&
    atr.div(b.close).lte(c.lowVolatilityThreshold)
  )
    target = c.lowVolatilityTargetAtr!;
  if (
    'adaptiveLowerAtr' in c &&
    c.adaptiveLowerAtr &&
    rangeAtr.gte(c.adaptiveLowerAtr) &&
    rangeAtr.lte('1.8')
  )
    target = c.adaptiveTargetAtr!;
  const gate = (side: 'LONG' | 'SHORT') => {
    if (
      !(side === 'LONG'
        ? trend.gt(earlier) && n(b.close).gt(trend)
        : trend.lt(earlier) && n(b.close).lt(trend))
    )
      return 'TREND_BLOCK';
    const cost = n(b.close).mul(
      n(feeRate)
        .plus('0.0005')
        .mul(2)
        .plus(side === 'SHORT' ? n('0.1').mul(24).div(8760) : 0),
    );
    if (atr.mul(side === 'SHORT' ? s.targetAtr : target).lt(cost.mul(3))) return 'COST_BLOCK';
    if (
      side === 'SHORT' &&
      (slope.lt(s.minSlopeAtr) ||
        distance.lt(s.minDistanceAtr) ||
        (s.maxDistanceAtr !== null && distance.gt(s.maxDistanceAtr)))
    )
      return 'SHORT_FILTER_BLOCK';
    if (
      c.base === 'V3' &&
      (rangeAtr.gt(2) ||
        (c.minSignalRangeAtr && rangeAtr.lt(c.minSignalRangeAtr)) ||
        (side === 'LONG' ? location.lt('0.5') : location.gt('0.5')))
    )
      return 'CANDLE_QUALITY_BLOCK';
    return 'PASS';
  };
  const longGate = gate('LONG'),
    shortGate = gate('SHORT'),
    bullish = fast.gt(slow),
    bearish = fast.lt(slow);
  const side: 'LONG' | 'SHORT' | null =
    bullish && oldFast.lte(oldSlow) && longGate === 'PASS'
      ? 'LONG'
      : bearish && oldFast.gte(oldSlow) && shortGate === 'PASS'
        ? 'SHORT'
        : null;
  return {
    side,
    bullish,
    bearish,
    atr: liveAmount(atr),
    stopAtr: c.stopAtr,
    targetAtr: side === 'SHORT' ? s.targetAtr : target,
    volume: b.volume,
    metrics: {
      barAt: b.at,
      fast: liveAmount(fast),
      slow: liveAmount(slow),
      trend: liveAmount(trend),
      earlier: liveAmount(earlier),
      atr: liveAmount(atr),
      rangeAtr: liveAmount(rangeAtr),
      location: liveAmount(location),
      slopeAtr: liveAmount(slope),
      distanceAtr: liveAmount(distance),
      longGate,
      shortGate,
    },
  };
}
export function createLiveRun(
  now: number,
  profiles: Record<LiveAsset, unknown>,
  engineHash: string,
  profileHash: string,
  markets: LiveMarket[],
): LiveRun {
  return LiveRunSchema.parse({
    version: 'live-paper.v1',
    id: randomUUID(),
    startedAt: now,
    deadlineAt: now + 86400000,
    endedAt: null,
    status: 'RUNNING',
    heartbeatAt: now,
    revision: 0,
    engineHash,
    profileHash,
    config: {
      initialPerExchange: '10000',
      durationHours: 24,
      slippageRate: '0.0005',
      annualBorrowRate: '0.1',
      feeRates: { BINANCE: '0.001', BYBIT: '0.001', OKX: '0.001', BITGET: '0.002', MEXC: '0.0005' },
      profiles,
    },
    accounts: LIVE_EXCHANGES.map((exchange) => ({
      exchange,
      cash: '10000',
      realized: '0',
      fees: '0',
      financing: '0',
      day: new Date(now).toISOString().slice(0, 10),
      dayEquity: '10000',
      blocked: false,
    })),
    positions: [],
    pending: {},
    decisions: Object.fromEntries(
      markets.map((m) => [
        liveKey(m.bars!.exchange, m.bars!.asset),
        'HOLD: waiting for the next completed hourly crossover.',
      ]),
    ),
    watermarks: Object.fromEntries(
      markets.map((m) => [
        liveKey(m.bars!.exchange, m.bars!.asset),
        m.bars!.bars.at(-1)!.at + 3600000,
      ]),
    ),
    lastEventHash: '',
  });
}
/** Conservative sampled-book execution. No reuse of already-consumed book liquidity. */
export function liveBookFill(
  book: LiveBook,
  instrument: LiveInstrument,
  quantity: string,
  buy: boolean,
  feeRate: string,
) {
  let left = n(quantity),
    qty = n(0),
    total = n(0),
    slippage = n(0);
  for (const [px, size] of buy ? book.asks : book.bids) {
    const take = floor(D.min(left, n(size).mul('0.1')), instrument.step);
    if (take.lte(0)) continue;
    const price = priceGrid(n(px).mul(buy ? '1.0005' : '0.9995'), instrument.tick, buy);
    qty = qty.plus(take);
    total = total.plus(take.mul(price));
    slippage = slippage.plus(take.mul(price.minus(px).abs()));
    left = left.minus(take);
    if (left.lte(0)) break;
  }
  if (qty.lte(0)) return null;
  return {
    quantity: liveAmount(qty),
    price: liveAmount(total.div(qty)),
    fee: liveAmount(total.mul(feeRate)),
    slippage: liveAmount(slippage),
    notional: liveAmount(total),
  };
}
function executableMark(p: LivePosition, book: LiveBook, instrument: LiveInstrument) {
  return priceGrid(
    n((p.side === 'LONG' ? book.bids : book.asks)[0]![0]).mul(
      p.side === 'LONG' ? '0.9995' : '1.0005',
    ),
    instrument.tick,
    p.side === 'SHORT',
  );
}
function refreshNet(p: LivePosition, fee: string) {
  const unreal = n(p.mark)
    .mul(p.remaining)
    .minus(p.reserved)
    .mul(p.side === 'LONG' ? 1 : -1);
  p.netPnl = liveAmount(
    n(p.grossRealized)
      .plus(unreal)
      .minus(p.fees)
      .minus(p.financing)
      .minus(n(p.mark).mul(p.remaining).mul(fee)),
  );
}
export function liveSummaries(run: LiveRun, now: number, markets: LiveMarket[]) {
  return run.accounts.map((a) => {
    const positions = run.positions.filter((p) => p.exchange === a.exchange),
      unrealized = positions.reduce(
        (v, p) =>
          v
            .plus(
              n(p.mark)
                .mul(p.remaining)
                .minus(p.reserved)
                .mul(p.side === 'LONG' ? 1 : -1),
            )
            .minus(n(p.mark).mul(p.remaining).mul(run.config.feeRates[p.exchange])),
        n(0),
      );
    const reserved = positions.reduce((v, p) => v.plus(p.reserved), n(0));
    const equity = n(a.cash).plus(reserved).plus(unrealized);
    return {
      exchange: a.exchange,
      equity: liveAmount(equity),
      netPnl: liveAmount(equity.minus(10000)),
      realized: a.realized,
      unrealized: liveAmount(unrealized),
      openNotional: liveAmount(
        positions.reduce((v, p) => v.plus(n(p.mark).mul(p.remaining)), n(0)),
      ),
      stale: positions.some((p) => {
        const m = markets.find((m) => m.book?.exchange === p.exchange && m.book.asset === p.asset);
        return !m?.book || !freshLiveBook(m.book, now) || now - p.markAt > 15000;
      }),
    };
  });
}
export function stepLiveRun(input: LiveRun, markets: LiveMarket[], now: number) {
  const run = structuredClone(input),
    changed: LivePosition[] = [],
    events: unknown[] = [];
  if (now < run.heartbeatAt) throw new Error('Clock moved backwards; worker halted');
  if (run.status === 'ENDED')
    return { state: run, positions: changed, event: { kind: 'IDLE' }, sources: [] };
  run.heartbeatAt = now;
  if (now >= run.deadlineAt) run.status = 'STOPPING';
  if (run.status !== 'RUNNING') run.pending = {};
  const recordPosition = (p: LivePosition) => {
    if (!changed.some((c) => c.id === p.id)) changed.push(p);
  };
  for (const p of run.positions) {
    const a = run.accounts.find((a) => a.exchange === p.exchange)!,
      feeRate = run.config.feeRates[p.exchange];
    if (p.side === 'SHORT') {
      const charge = n(p.reserved)
        .mul(run.config.annualBorrowRate)
        .mul(now - p.chargedThrough)
        .div(365 * 86400000)
        .toDecimalPlaces(18);
      p.financing = liveAmount(n(p.financing).plus(charge));
      a.financing = liveAmount(n(a.financing).plus(charge));
      a.cash = liveAmount(n(a.cash).minus(charge));
      a.realized = liveAmount(n(a.realized).minus(charge));
    }
    p.chargedThrough = now;
    const m = markets.find((m) => m.book?.exchange === p.exchange && m.book.asset === p.asset);
    if (m?.book && m.instrument && freshLiveBook(m.book, now)) {
      p.mark = liveAmount(executableMark(p, m.book, m.instrument));
      p.markAt = m.book.source.receivedAt;
      p.updatedAt = now;
      const stop = p.side === 'LONG' ? n(p.mark).lte(p.stop) : n(p.mark).gte(p.stop),
        target = p.side === 'LONG' ? n(p.mark).gte(p.target) : n(p.mark).lte(p.target);
      if (run.status === 'STOPPING' || stop || target || a.blocked || n(a.cash).lt(0)) {
        p.lifecycle = 'CLOSING';
        p.exitReason ??=
          run.status === 'STOPPING'
            ? 'RUN_END'
            : stop
              ? 'STOP'
              : target
                ? 'TARGET'
                : 'ACCOUNT_RISK';
      }
      if (p.lifecycle === 'CLOSING' && m.book.source.sequence !== p.consumedSequence) {
        const fill = liveBookFill(m.book, m.instrument, p.remaining, p.side === 'SHORT', feeRate);
        if (fill) {
          const release = n(fill.quantity).eq(p.remaining)
              ? n(p.reserved)
              : n(p.reserved).mul(fill.quantity).div(p.remaining).toDecimalPlaces(18),
            gross = n(fill.notional)
              .minus(release)
              .mul(p.side === 'LONG' ? 1 : -1);
          a.cash = liveAmount(n(a.cash).plus(release).plus(gross).minus(fill.fee));
          a.realized = liveAmount(n(a.realized).plus(gross).minus(fill.fee));
          a.fees = liveAmount(n(a.fees).plus(fill.fee));
          p.remaining = liveAmount(n(p.remaining).minus(fill.quantity));
          p.reserved = liveAmount(n(p.reserved).minus(release));
          p.grossRealized = liveAmount(n(p.grossRealized).plus(gross));
          p.fees = liveAmount(n(p.fees).plus(fill.fee));
          p.consumedSequence = m.book.source.sequence;
          p.fills.push({
            kind: 'CLOSE',
            at: now,
            quoteId: m.book.source.id,
            quantity: fill.quantity,
            price: fill.price,
            fee: fill.fee,
            slippage: fill.slippage,
            reason: p.exitReason ?? 'EXIT',
          });
          events.push({
            kind: 'CLOSE_FILL',
            positionId: p.id,
            fill: p.fills.at(-1),
            cashDelta: liveAmount(release.plus(gross).minus(fill.fee)),
          });
          if (n(p.remaining).eq(0)) {
            p.lifecycle = 'CLOSED';
            p.closedAt = now;
          }
        }
      }
    } else if (run.status === 'STOPPING') {
      p.lifecycle = 'CLOSING';
      p.exitReason ??= 'RUN_END';
    }
    refreshNet(p, feeRate);
    if (p.lifecycle === 'CLOSED')
      p.status = n(p.netPnl).gt(0) ? 'WIN' : n(p.netPnl).lt(0) ? 'LOSS' : 'BREAKEVEN';
    recordPosition(p);
  }
  run.positions = run.positions.filter((p) => p.lifecycle !== 'CLOSED');
  for (const summary of liveSummaries(run, now, markets)) {
    const a = run.accounts.find((a) => a.exchange === summary.exchange)!,
      day = new Date(now).toISOString().slice(0, 10);
    if (a.day !== day) {
      a.day = day;
      a.dayEquity = summary.equity;
      a.blocked = false;
    }
    if (n(summary.equity).lte(n(a.dayEquity).mul('0.98')) || n(a.cash).lt(0)) a.blocked = true;
    if (a.blocked)
      for (const p of run.positions.filter((p) => p.exchange === a.exchange)) {
        p.lifecycle = 'CLOSING';
        p.exitReason ??= 'DAILY_LOSS_LIMIT';
        recordPosition(p);
      }
  }
  for (const m of markets) {
    if (!m.bars || !m.instrument) continue;
    const { exchange, asset } = m.bars,
      key = liveKey(exchange, asset),
      a = run.accounts.find((a) => a.exchange === exchange)!,
      feeRate = run.config.feeRates[exchange],
      latest = m.bars.bars.at(-1);
    if (!latest) continue;
    const closeAt = latest.at + 3600000;
    if (closeAt > (run.watermarks[key] ?? run.startedAt)) {
      run.watermarks[key] = closeAt;
      if (
        run.status === 'RUNNING' &&
        closeAt > run.startedAt &&
        now - closeAt <= 90000 &&
        closeAt <= m.bars.source.receivedAt &&
        m.bars.source.receivedAt <= now &&
        m.bars.bars.length >= 224
      ) {
        const signal = liveSignal(m.bars.bars, asset, feeRate, run.config.profiles[asset]);
        const existing = run.positions.find((p) => p.exchange === exchange && p.asset === asset);
        if (signal && existing && (existing.side === 'LONG' ? !signal.bullish : !signal.bearish)) {
          existing.lifecycle = 'CLOSING';
          existing.exitReason = 'CROSSOVER';
          recordPosition(existing);
        }
        run.decisions[key] = signal?.side
          ? `${signal.side}: eligible hourly crossover.`
          : `HOLD: ${signal ? `no eligible crossover (long ${signal.metrics.longGate}, short ${signal.metrics.shortGate})` : '224 completed candles required'}.`;
        events.push({ kind: 'DECISION', key, at: now, candleSource: m.bars.source.id, signal });
        if (signal?.side && !a.blocked && (!existing || existing.side !== signal.side))
          run.pending[key] = {
            side: signal.side,
            createdAt: now,
            expiresAt: Math.min(now + 90000, run.deadlineAt),
            atr: signal.atr,
            stopAtr: signal.stopAtr,
            targetAtr: signal.targetAtr,
            volume: signal.volume,
            decision: { ...signal.metrics, candleSource: m.bars.source.id, decisionAt: now },
          };
      } else
        run.decisions[key] =
          run.status === 'RUNNING'
            ? 'HOLD: missed or pre-run hourly signal; waiting for the next close.'
            : `${run.status}: entries disabled.`;
    }
    const pending = run.pending[key];
    if (!pending) continue;
    if (now >= pending.expiresAt || run.status !== 'RUNNING' || a.blocked) {
      delete run.pending[key];
      continue;
    }
    if (
      run.positions.some((p) => p.exchange === exchange && p.asset === asset) ||
      !m.book ||
      !freshLiveBook(m.book, now) ||
      m.book.source.receivedAt <= pending.createdAt ||
      now - m.instrument.source.receivedAt > 7200000
    )
      continue;
    const summary = liveSummaries(run, now, markets).find((s) => s.exchange === exchange)!,
      buy = pending.side === 'LONG',
      ref = n((buy ? m.book.asks : m.book.bids)[0]![0]),
      cost = ref.mul(
        n(feeRate)
          .plus('0.0005')
          .mul(2)
          .plus(buy ? 0 : n('0.1').mul(24).div(8760)),
      );
    // Two symbols share one venue account; fully reserve entry notional for both directions.
    const allocation = D.min(
      n(summary.equity).mul('0.1'),
      n(summary.equity).mul('0.2').minus(summary.openNotional),
      n(a.cash).div(n(1).plus(feeRate)),
    );
    const q = floor(
      D.max(
        0,
        D.min(
          n(summary.equity).mul('0.0025').div(n(pending.atr).mul(pending.stopAtr).plus(cost)),
          allocation.div(ref.mul(buy ? '1.0005' : '1')),
          n(pending.volume).mul('0.01'),
        ),
      ),
      m.instrument.step,
    );
    const fill = liveBookFill(m.book, m.instrument, liveAmount(q), buy, feeRate);
    delete run.pending[key];
    if (
      !fill ||
      n(fill.quantity).lt(m.instrument.minQty) ||
      n(fill.notional).lt(m.instrument.minNotional) ||
      n(fill.notional).plus(fill.fee).gt(a.cash) ||
      n(fill.notional).gt(n(summary.equity).mul('0.1'))
    ) {
      run.decisions[key] =
        'HOLD: minimum size, liquidity, allocation or available collateral blocked the entry.';
      continue;
    }
    const entry = n(fill.price),
      stop = priceGrid(
        entry.plus(
          n(pending.atr)
            .mul(pending.stopAtr)
            .mul(buy ? -1 : 1),
        ),
        m.instrument.tick,
        !buy,
      ),
      target = priceGrid(
        entry.plus(
          n(pending.atr)
            .mul(pending.targetAtr)
            .mul(buy ? 1 : -1),
        ),
        m.instrument.tick,
        !buy,
      );
    if (stop.lte(0) || target.lte(0)) continue;
    a.cash = liveAmount(n(a.cash).minus(fill.notional).minus(fill.fee));
    a.realized = liveAmount(n(a.realized).minus(fill.fee));
    a.fees = liveAmount(n(a.fees).plus(fill.fee));
    const p: LivePosition = {
      id: positionId(run.id, key, pending.createdAt, pending.side),
      runId: run.id,
      exchange,
      asset,
      side: pending.side,
      strategy: 'V6',
      status: 'WORKING',
      lifecycle: 'OPEN',
      openedAt: now,
      closedAt: null,
      updatedAt: now,
      quantity: fill.quantity,
      remaining: fill.quantity,
      reserved: fill.notional,
      entry: fill.price,
      mark: fill.price,
      markAt: m.book.source.receivedAt,
      notional: fill.notional,
      stop: liveAmount(stop),
      target: liveAmount(target),
      fees: fill.fee,
      financing: '0',
      chargedThrough: now,
      grossRealized: '0',
      netPnl: '0',
      exitReason: null,
      decision: pending.decision,
      fills: [
        {
          kind: 'OPEN',
          at: now,
          quoteId: m.book.source.id,
          quantity: fill.quantity,
          price: fill.price,
          fee: fill.fee,
          slippage: fill.slippage,
          reason: 'V6 crossover; fresh post-decision book',
        },
      ],
      consumedSequence: m.book.source.sequence,
    };
    p.mark = liveAmount(executableMark(p, m.book, m.instrument));
    refreshNet(p, feeRate);
    run.positions.push(p);
    recordPosition(p);
    events.push({
      kind: 'OPEN_FILL',
      positionId: p.id,
      fill: p.fills[0],
      cashDelta: liveAmount(n(fill.notional).plus(fill.fee).neg()),
    });
  }
  if (run.status === 'STOPPING' && !run.positions.length) {
    run.status = 'ENDED';
    run.endedAt = now;
  }
  return {
    state: LiveRunSchema.parse(run),
    positions: changed,
    event: {
      kind: 'TICK',
      markets: markets.map((m) => ({
        exchange: m.book?.exchange ?? m.bars?.exchange ?? m.instrument?.exchange ?? null,
        asset: m.book?.asset ?? m.bars?.asset ?? m.instrument?.asset ?? null,
        book: m.book?.source.id ?? null,
        bars: m.bars?.source.id ?? null,
        instrument: m.instrument?.source.id ?? null,
      })),
      at: now,
      previousStateHash: canonicalHash(input),
      events,
      quotes: markets.flatMap((m) => (m.book ? [m.book.source.id] : [])),
      candles: markets.flatMap((m) => (m.bars ? [m.bars.source.id] : [])),
      accounts: run.accounts,
    },
    sources: markets.flatMap((m) =>
      [m.book?.source, m.bars?.source, m.instrument?.source].filter(
        (s): s is NonNullable<typeof s> => !!s,
      ),
    ),
  };
}
