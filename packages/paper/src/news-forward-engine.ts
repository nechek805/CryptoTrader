import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import { canonicalHash } from '@crypto/core';
import { freshLiveBook } from '../../connectors/src/news-forward-exchanges.js';
import {
  LIVE_EXCHANGES,
  ForwardRun as LiveRunSchema,
  ForwardManifest,
} from '../../contracts/src/news-forward.js';
import type {
  LiveRun,
  LiveBook,
  LiveBars,
  LiveInstrument,
  LivePosition,
  LiveAsset,
  LiveExchange,
  Manifest,
} from '../../contracts/src/news-forward.js';
import { MARKET_ASSETS } from '../../contracts/src/market-tests.js';
import { LiveNewsVersionSchema, LiveNewsSourceView } from '../../contracts/src/live-news.js';
import type { z } from 'zod';
import { newsHistoryClassify } from '../../research/src/news-history-study.js';
import { historicalSourceRole } from '../../research/src/news-events-v4.js';
const D = Decimal.clone({ precision: 48, rounding: Decimal.ROUND_HALF_UP });
const n = (v: Decimal.Value) => new D(v);
export const liveAmount = (v: Decimal.Value) => n(v).toDecimalPlaces(18).toFixed();
const floor = (value: Decimal.Value, step: string) => n(value).div(step).floor().mul(step);
function positionId(runId: string, key: string, at: number, side: string, event: unknown) {
  const h = canonicalHash({ runId, key, at, side, event }).slice(7);
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
export function fenceForwardPermissions(
  input: LiveRun,
  sources: z.infer<typeof LiveNewsSourceView>[],
  now: number,
) {
  const run = structuredClone(input);
  for (const [key, p] of Object.entries(run.pending)) {
    const proof = LiveNewsVersionSchema.parse(p.decision.news),
      source = sources.find((s) => s.config.id === proof.sourceId);
    if (
      !source ||
      !source.config.enabled ||
      !source.config.collectionApproved ||
      !source.config.aiAllowed ||
      source.config.revision !== proof.sourceRevision ||
      source.health.lastSuccessAt === null ||
      now - source.health.lastSuccessAt >
        Math.max(1800000, source.config.pollIntervalSeconds * 2000)
    ) {
      delete run.pending[key];
      run.decisions[key] = 'HOLD: pending news source changed, was disabled, or became stale.';
      run.counters.PENDING_SOURCE_CHANGED = (run.counters.PENDING_SOURCE_CHANGED ?? 0) + 1;
    }
  }
  return run;
}
export function createNewsForwardRun(now: number, input: Manifest, engineHash: string): LiveRun {
  const manifest = ForwardManifest.parse(input);
  return LiveRunSchema.parse({
    version: 'news-forward.v1',
    id: randomUUID(),
    startedAt: now,
    deadlineAt: now + 86400000,
    endedAt: null,
    status: 'RUNNING',
    heartbeatAt: now,
    revision: 0,
    engineHash,
    profileHash: canonicalHash(manifest),
    manifest,
    config: {
      initialPerExchange: '10000',
      durationHours: 24,
      slippageRate: '0.0005',
      annualBorrowRate: '0.02628',
      feeRates: { BINANCE: '0.001', BYBIT: '0.001', OKX: '0.001', BITGET: '0.002', MEXC: '0.0005' },
      profiles: manifest.profiles,
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
      LIVE_EXCHANGES.flatMap((e) =>
        MARKET_ASSETS.map((a) => [
          liveKey(e, a),
          'HOLD: waiting for fresh post-start news with a supported frozen V6 rule.',
        ]),
      ),
    ),
    watermarks: {},
    lastEventHash: '',
    processed: [],
    deduplicated: {},
    commands: {},
    counters: {},
  });
}
/** Frozen V6 taxonomy and rules; actual receipt times replace historical publication proxies. */
export function stageForwardNews(
  input: LiveRun,
  observations: { version: unknown; source: unknown }[],
  now: number,
) {
  const run = structuredClone(input),
    decisions: unknown[] = [];
  const count = (key: string) => {
    run.counters[key] = (run.counters[key] ?? 0) + 1;
  };
  for (const observation of observations) {
    const v = LiveNewsVersionSchema.parse(observation.version),
      source = LiveNewsSourceView.parse(observation.source);
    if (run.processed.includes(v.id)) continue;
    if (v.availableAt > now) continue;
    if (run.processed.length >= 20000) throw Error('NEWS_FORWARD_EVENT_LIMIT');
    run.processed.push(v.id);
    const c = newsHistoryClassify(historicalSourceRole(v.sourceId), v.title + ' ' + v.excerpt);
    let reason = '';
    if (run.status !== 'RUNNING' || now >= run.deadlineAt) reason = 'ENTRIES_DISABLED';
    else if (
      !source.config.enabled ||
      !source.config.collectionApproved ||
      !source.config.aiAllowed ||
      !v.aiAllowed ||
      source.config.id !== v.sourceId ||
      source.config.revision !== v.sourceRevision
    )
      reason = 'SOURCE_PERMISSION_OR_REVISION';
    else if (
      source.health.lastSuccessAt === null ||
      now - source.health.lastSuccessAt >
        Math.max(1800000, source.config.pollIntervalSeconds * 2000)
    )
      reason = 'SOURCE_STALE';
    else if (
      v.firstSeenAt < run.startedAt ||
      v.availableAt < run.startedAt ||
      v.captureKind !== 'LIVE_POLL'
    )
      reason = 'PRE_RUN_OR_INITIAL_SNAPSHOT';
    else if (
      v.publishedAt === null ||
      v.timestampStatus !== 'VALID' ||
      v.publishedAt > v.availableAt ||
      now - v.publishedAt > 7200000 ||
      now - v.availableAt > 7200000
    )
      reason = 'STALE_OR_UNCERTAIN_NEWS_TIME';
    else if (c.group.includes('UNCERTAIN') || c.group === 'OTHER' || !c.assets.length)
      reason = 'UNCLEAR_OR_RESOLVED_EVENT';
    if (reason) {
      count(reason);
      if (c.group.includes('UNCERTAIN'))
        for (const [key, p] of Object.entries(run.pending))
          if (p.decision.articleId === v.articleId) {
            delete run.pending[key];
            run.decisions[key] =
              'HOLD: new correction or uncertainty cancelled the pending news entry.';
          }
      decisions.push({ versionId: v.id, reason, at: now });
      continue;
    }
    const dedup = canonicalHash({
      origin: v.independenceGroup,
      group: c.group,
      assets: [...c.assets].sort(),
      window: Math.floor(v.publishedAt! / 21600000),
    });
    if (run.deduplicated[dedup]) {
      count('DUPLICATE_EVENT');
      decisions.push({ versionId: v.id, reason: 'DUPLICATE_EVENT', at: now });
      continue;
    }
    run.deduplicated[dedup] = now;
    for (const asset of c.assets) {
      const profile = run.config.profiles[asset],
        rule = profile.rules.find((r) => r.group === c.group);
      const side = rule && rule.count >= profile.config.minSamples ? rule.side : 'HOLD';
      count(side === 'HOLD' ? 'NO_SUPPORTED_NEWS_EDGE' : 'ELIGIBLE_ASSET_EVENT');
      const notBefore = Math.ceil((now + 300000) / 3600000) * 3600000;
      for (const exchange of LIVE_EXCHANGES) {
        const key = liveKey(exchange, asset);
        if (side === 'HOLD') {
          run.decisions[key] = `HOLD: no frozen V6 edge for ${c.group}.`;
          continue;
        }
        if (
          run.pending[key] ||
          run.positions.some((p) => p.exchange === exchange && p.asset === asset)
        ) {
          count('POSITION_OR_SIGNAL_ALREADY_ACTIVE');
          continue;
        }
        run.pending[key] = {
          side,
          createdAt: now,
          notBefore,
          expiresAt: Math.min(notBefore + 90000, run.deadlineAt),
          horizonHours: profile.config.horizonHours,
          decision: {
            engine: 'NEWS_ONLY',
            versionId: v.id,
            articleId: v.articleId,
            eventKey: dedup,
            group: c.group,
            sourceId: v.sourceId,
            url: v.url,
            title: v.title,
            knownAt: v.availableAt,
            publishedAt: v.publishedAt,
            decisionAt: now,
            notBefore,
            modelHash: profile.modelHash,
            rule,
            selectedCase: profile.selectedCase,
            source: source.config,
            news: v,
          },
        };
        run.decisions[key] =
          `${side}: ${c.group}; waiting for ${new Date(notBefore).toISOString()} and a fresh book.`;
      }
      decisions.push({ versionId: v.id, asset, group: c.group, side, at: now, rule: rule ?? null });
    }
  }
  return { run: LiveRunSchema.parse(run), decisions };
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
export function stepNewsForward(input: LiveRun, markets: LiveMarket[], now: number) {
  const run = structuredClone(input),
    changed: LivePosition[] = [],
    events: unknown[] = [];
  if (now < run.heartbeatAt) throw new Error('Clock moved backwards; worker halted');
  if (run.status === 'ENDED')
    return { state: run, positions: changed, event: { kind: 'IDLE' }, sources: [] };
  run.heartbeatAt = now;
  if (now >= run.deadlineAt) run.status = 'STOPPING';
  if (run.status !== 'RUNNING') run.pending = {};
  for (const [key, p] of Object.entries(run.pending))
    if (now >= p.expiresAt) {
      delete run.pending[key];
      run.decisions[key] = 'HOLD: news entry expired before a permitted fill.';
    }
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
    if (
      m?.book &&
      m.instrument &&
      m.instrument.asset === p.asset &&
      m.instrument.exchange === p.exchange &&
      freshLiveBook(m.book, now)
    ) {
      p.mark = liveAmount(executableMark(p, m.book, m.instrument));
      p.markAt = m.book.source.receivedAt;
      p.updatedAt = now;
      const stop = p.side === 'LONG' ? n(p.mark).lte(p.stop) : n(p.mark).gte(p.stop),
        target = p.side === 'LONG' ? n(p.mark).gte(p.target) : n(p.mark).lte(p.target);
      if (
        run.status === 'STOPPING' ||
        stop ||
        target ||
        now >= Number(p.decision.expiresAt) ||
        a.blocked ||
        n(a.cash).lt(0)
      ) {
        p.lifecycle = 'CLOSING';
        p.exitReason ??=
          run.status === 'STOPPING'
            ? 'RUN_END'
            : stop
              ? 'STOP'
              : target
                ? 'TARGET'
                : now >= Number(p.decision.expiresAt)
                  ? 'HORIZON'
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
    if (!m.book || !m.instrument) continue;
    if (
      m.book.asset !== m.instrument.asset ||
      m.book.exchange !== m.instrument.exchange ||
      m.instrument.source.receivedAt > now
    )
      continue;
    const { exchange, asset } = m.book,
      key = liveKey(exchange, asset),
      a = run.accounts.find((a) => a.exchange === exchange)!,
      feeRate = run.config.feeRates[exchange];
    const pending = run.pending[key];
    if (!pending || now < pending.notBefore) continue;
    if (now >= pending.expiresAt || run.status !== 'RUNNING' || a.blocked) {
      delete run.pending[key];
      continue;
    }
    if (
      run.positions.some((p) => p.exchange === exchange && p.asset === asset) ||
      !m.book ||
      !freshLiveBook(m.book, now) ||
      m.book.source.requestedAt <= pending.createdAt ||
      m.book.source.requestedAt < pending.notBefore ||
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
          .plus(buy ? 0 : n(run.config.annualBorrowRate).mul(pending.horizonHours).div(8760)),
      );
    if (n(m.book.asks[0]![0]).minus(m.book.bids[0]![0]).div(m.book.bids[0]![0]).gt('0.005')) {
      run.decisions[key] = 'HOLD: executable spread exceeds 0.5%.';
      delete run.pending[key];
      continue;
    }
    // Ten news tokens share one independent venue account; fully reserve entry notional for both directions.
    const allocation = D.min(
      n(summary.equity).mul('0.1'),
      n(summary.equity).mul('0.2').minus(summary.openNotional),
      n(a.cash).div(n(1).plus(feeRate)),
    );
    const q = floor(
      D.max(
        0,
        D.min(
          n(summary.equity).mul('0.0025').div(ref.mul('0.025').plus(cost)),
          allocation.div(ref.mul(buy ? '1.0005' : '1')),
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
      stop = priceGrid(entry.plus(entry.mul('0.025').mul(buy ? -1 : 1)), m.instrument.tick, !buy),
      target = priceGrid(entry.plus(entry.mul('0.05').mul(buy ? 1 : -1)), m.instrument.tick, !buy);
    if (stop.lte(0) || target.lte(0)) continue;
    a.cash = liveAmount(n(a.cash).minus(fill.notional).minus(fill.fee));
    a.realized = liveAmount(n(a.realized).minus(fill.fee));
    a.fees = liveAmount(n(a.fees).plus(fill.fee));
    const p: LivePosition = {
      id: positionId(run.id, key, pending.createdAt, pending.side, pending.decision.eventKey),
      runId: run.id,
      exchange,
      asset,
      side: pending.side,
      strategy: 'NEWS_V6',
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
      decision: { ...pending.decision, expiresAt: now + pending.horizonHours * 3600000 },
      fills: [
        {
          kind: 'OPEN',
          at: now,
          quoteId: m.book.source.id,
          quantity: fill.quantity,
          price: fill.price,
          fee: fill.fee,
          slippage: fill.slippage,
          reason: 'Frozen news V6 rule; fresh post-decision public book',
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
