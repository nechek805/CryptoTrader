import type {
  BacktestManifest,
  BacktestOutcome,
  BacktestTrade,
  SpotSimulationArtifact,
  SpotSimulationRequest,
  MarketBar,
} from '@crypto/contracts';
import { utcNanoseconds } from '@crypto/contracts';
import { canonicalHash, deterministicId, isAvailableAt, fromEpoch } from '@crypto/core';
import { D, amount } from './spot-math.js';
import { SpotEvidence } from './spot-evidence.js';
import { barIntervalSeconds } from './scheduler.js';
export const metric = (v: InstanceType<typeof D>) => amount(v.toDecimalPlaces(36));
const ratio = (a: InstanceType<typeof D>, b: InstanceType<typeof D>) => metric(a.div(b));

function trades(sim: SpotSimulationArtifact) {
  const lots: {
      fill: SpotSimulationArtifact['fills'][number]['fill'];
      quantity: InstanceType<typeof D>;
      fee: InstanceType<typeof D>;
    }[] = [],
    closed: BacktestTrade[] = [];
  for (const { fill: f } of sim.fills) {
    if (f.side === 'BUY') {
      lots.push({ fill: f, quantity: new D(f.quantity), fee: new D(f.fee) });
      continue;
    }
    let remaining = new D(f.quantity),
      fee = new D(f.fee);
    while (remaining.gt(0)) {
      const lot = lots.find((l) => l.quantity.gt(0));
      if (!lot) throw new Error('FIFO sold unavailable inventory');
      const q = D.min(remaining, lot.quantity),
        entryFee = q.eq(lot.quantity) ? lot.fee : new D(metric(lot.fee.mul(q).div(lot.quantity))),
        exitFee = q.eq(remaining) ? fee : new D(metric(fee.mul(q).div(remaining))),
        gross = q.mul(new D(f.price).minus(lot.fill.price));
      closed.push({
        id: deterministicId('backtest-trade', {
          buyFillId: lot.fill.id,
          sellFillId: f.id,
          index: closed.length,
        }),
        buyFillId: lot.fill.id,
        sellFillId: f.id,
        openedAt: lot.fill.filledAt,
        closedAt: f.filledAt,
        quantity: amount(q),
        entryPrice: lot.fill.price,
        exitPrice: f.price,
        grossPnl: amount(gross),
        entryFees: amount(entryFee),
        exitFees: amount(exitFee),
        netPnl: amount(gross.minus(entryFee).minus(exitFee)),
      });
      lot.quantity = lot.quantity.minus(q);
      lot.fee = lot.fee.minus(entryFee);
      remaining = remaining.minus(q);
      fee = fee.minus(exitFee);
    }
  }
  return closed;
}
export function measureBacktest(sim: SpotSimulationArtifact, manifest: BacktestManifest) {
  const policy = sim.request,
    base = manifest.series.asset,
    quote = policy.quoteCurrency,
    evidence = new SpotEvidence(sim.input, policy),
    extraTimes = sim.input.bars
      .filter((b) => b.availableAt !== null && b.availableAt < policy.endAt)
      .flatMap((b) => {
        const t = utcNanoseconds(b.closeAt) + BigInt(manifest.maxMarkAgeMs) * 1000000n + 1n;
        return t > utcNanoseconds(policy.startAt) && t < utcNanoseconds(policy.endAt)
          ? [fromEpoch(t, 'nanoseconds')]
          : [];
      }),
    times = [
      ...new Set([policy.startAt, ...sim.trace.map((t) => t.at), ...extraTimes, policy.endAt]),
    ].sort(),
    equity: BacktestOutcome['equity'] = [],
    initial = new D(policy.initialBalances.find((b) => b.asset === quote)!.amount);
  let journalIndex = -1;
  let positioned = 0n;
  for (const [index, at] of times.entries()) {
    const cutoffAt = at === policy.endAt ? fromEpoch(utcNanoseconds(at) - 1n, 'nanoseconds') : at;
    while (journalIndex + 1 < sim.journal.length && sim.journal[journalIndex + 1]!.at <= at)
      journalIndex++;
    const balances = journalIndex < 0 ? [] : sim.journal[journalIndex]!.balancesAfter,
      coin = balances.find((b) => b.asset === base),
      cash = balances.find((b) => b.asset === quote),
      quantity = new D(coin?.free ?? 0).plus(coin?.reserved ?? 0),
      cashValue = new D(cash?.free ?? 0).plus(cash?.reserved ?? 0),
      candidates = sim.input.bars
        .filter(
          (b) =>
            b.exchange === manifest.series.exchange &&
            b.instrumentId === manifest.series.instrumentId &&
            b.marketType === 'SPOT' &&
            barIntervalSeconds(b) === policy.intervalSeconds &&
            b.availableAt !== null &&
            b.availableAt <= cutoffAt &&
            b.closeAt <= cutoffAt,
        )
        .sort((a, b) =>
          a.closeAt > b.closeAt
            ? -1
            : a.closeAt < b.closeAt
              ? 1
              : a.availableAt! > b.availableAt!
                ? -1
                : 1,
        ),
      latest = candidates[0];
    const currentMetadata = evidence.metadata(policy.instrumentKeys[0]!, cutoffAt, cutoffAt),
      known =
        latest !== undefined &&
        isAvailableAt(latest, cutoffAt) &&
        evidence.bar(policy.instrumentKeys[0]!, latest) !== null &&
        currentMetadata !== null &&
        currentMetadata.baseCode === base &&
        currentMetadata.quoteCode === quote &&
        utcNanoseconds(at) - utcNanoseconds(latest.closeAt) <=
          BigInt(manifest.maxMarkAgeMs) * 1000000n,
      mark = known ? latest.close : null,
      value = quantity.isZero()
        ? cashValue
        : mark === null
          ? null
          : cashValue.plus(quantity.mul(mark)),
      exposure =
        value === null
          ? null
          : value.isZero()
            ? amount(0)
            : ratio(mark === null ? new D(0) : quantity.mul(mark), value);
    equity.push({
      at,
      cutoff: 'END_OF_TIMESTAMP_DELIVERED_EVENTS',
      cash: amount(cashValue),
      quantity: amount(quantity),
      mark,
      markBarId: known ? latest.id : null,
      markAvailableAt: known ? latest.availableAt : null,
      equity: value === null ? null : amount(value),
      exposureFraction: exposure,
      reason: quantity.isZero() ? 'NO_POSITION' : known ? 'KNOWN' : 'MISSING_OR_STALE_MARK',
    });
    if (quantity.gt(0) && times[index + 1])
      positioned += utcNanoseconds(times[index + 1]!) - utcNanoseconds(at);
  }
  const fees = sim.fills.reduce((s, f) => s.plus(f.fill.fee), new D(0)),
    turnover = sim.fills.reduce((s, f) => s.plus(f.fill.notional), new D(0)),
    terminal = equity.at(-1)!.equity,
    net = terminal === null ? null : new D(terminal).minus(initial),
    gross = net === null ? null : net.plus(fees),
    closed = trades(sim),
    unknown = equity.filter((p) => p.equity === null).length;
  let peak = initial,
    drawdown = new D(0),
    exposure = new D(0);
  for (const p of equity) {
    if (p.equity !== null) {
      peak = D.max(peak, p.equity);
      if (peak.gt(0)) drawdown = D.max(drawdown, peak.minus(p.equity).div(peak));
    }
    if (p.exposureFraction !== null) exposure = D.max(exposure, p.exposureFraction);
  }
  const skips = new Map<string, number>();
  for (const t of sim.trace)
    if (
      (t.kind === 'BAR' &&
        ![
          'CANDLE_COMPLETE',
          'FILLED',
          'STOP',
          'TARGET',
          'AMBIGUOUS_STOP_TARGET_STOP_FIRST',
        ].includes(t.reason)) ||
      (t.kind === 'SUBMIT' && t.reason !== 'ACCEPTED' && t.reason !== 'IDEMPOTENT_RETRY')
    )
      skips.set(t.reason, (skips.get(t.reason) ?? 0) + 1);
  return {
    equity,
    trades: closed,
    metrics: {
      initialEquity: amount(initial),
      terminalEquity: terminal,
      grossPnl: gross === null ? null : amount(gross),
      netPnl: net === null ? null : amount(net),
      grossReturn: gross === null ? null : ratio(gross, initial),
      netReturn: net === null ? null : ratio(net, initial),
      fees: amount(fees),
      feeDragReturn: ratio(fees, initial),
      maxDrawdownFraction: unknown ? null : metric(drawdown),
      maxExposureFraction: unknown ? null : metric(exposure),
      timeInMarketFraction: ratio(
        new D(positioned.toString()),
        new D((utcNanoseconds(policy.endAt) - utcNanoseconds(policy.startAt)).toString()),
      ),
      turnoverNotional: amount(turnover),
      turnoverFraction: ratio(turnover, initial),
      fillCount: sim.fills.length,
      closedLotCount: closed.length,
      rejectedOrders: sim.orders.filter((o) => o.order.status === 'REJECTED').length,
      unknownEquityPoints: unknown,
    },
    fillFingerprint: canonicalHash(
      sim.fills.map((f) => ({
        side: f.fill.side,
        quantity: f.fill.quantity,
        price: f.fill.price,
        barId: f.barId,
        trigger: f.trigger,
        liquidity: f.fill.liquidity,
      })),
    ),
    skips: [...skips]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([reason, count]) => ({ reason, count })),
    unknownMarketDepth: true as const,
  };
}
export function missingBacktestCloses(
  bars: MarketBar[],
  manifest: BacktestManifest,
  policy: SpotSimulationRequest,
) {
  const evidence = new SpotEvidence(
      {
        schemaVersion: 'spot-simulation-input.v1',
        market: manifest.input.market,
        bars,
        commands: [],
      },
      policy,
    ),
    step = BigInt(policy.intervalSeconds) * 1000000000n,
    first = utcNanoseconds(manifest.calendar.firstCloseAt),
    end = utcNanoseconds(policy.endAt),
    missing: BacktestManifest['calendar']['firstCloseAt'][] = [];
  let count = 0;
  for (let t = first; t < end; t += step) {
    if (++count > 2000) throw new Error('Backtest calendar work budget');
    const eligible = bars.some(
      (b) =>
        utcNanoseconds(b.closeAt) === t &&
        b.availableAt !== null &&
        b.availableAt < policy.endAt &&
        evidence.bar(policy.instrumentKeys[0]!, b) !== null,
    );
    if (!eligible) missing.push(fromEpoch(t, 'nanoseconds'));
  }
  return missing;
}
