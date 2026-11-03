import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  SpotOrderIntentSchema,
  SpotSimulationRequestSchema,
  utcNanoseconds,
} from '@crypto/contracts';
import type { SpotCommand, SpotSimulationArtifact } from '@crypto/contracts';
import { canonicalHash, decimal, fromEpoch, addDecimal } from '@crypto/core';
import {
  spotSimulationFixture,
  simulateSpot,
  ExecutionSimulator,
  reconcileSpotJournal,
  validateSpotSimulationArtifact,
  writeSpotSimulationArtifact,
  verifySpotSimulationArtifact,
  spotSimulationReport,
} from '@crypto/backtest';

const at = (s: number) => fromEpoch(1767225600n + BigInt(s), 'seconds'),
  shift = (s: number, n: bigint) => fromEpoch(utcNanoseconds(at(s)) + n, 'nanoseconds'),
  dirs: string[] = [];
const setup = () => structuredClone(spotSimulationFixture());
type Fixture = ReturnType<typeof setup>;
const submit = (f: Fixture, index = 0) => {
  const c = f.input.commands[index]!;
  if (c.kind !== 'SUBMIT') throw new Error('Expected submit');
  return c;
};
const onlyBuy = () => {
  const f = setup();
  f.input.commands = [f.input.commands[0]!];
  return f;
};
const run = (f = setup()) => simulateSpot(f.input, f.request, 'synthetic:test');
const wallet = (a: SpotSimulationArtifact, asset = 'USDT', portfolio = 'BASELINE') =>
  a.balances.find((b) => b.asset === asset && b.portfolio === portfolio)!;
const quantity = (f: Fixture, q: string) => {
  const c = submit(f);
  c.intent.quantity = decimal(q);
  c.risk.sizing.quantity = decimal(q);
};
function cloneSubmit(
  c: Extract<SpotCommand, { kind: 'SUBMIT' }>,
  suffix: string,
  sequence: number,
) {
  const copy = structuredClone(c);
  copy.id += suffix;
  copy.intent.clientOrderId += suffix;
  copy.candidate.id += suffix;
  copy.risk.id += suffix;
  copy.risk.candidateId = copy.candidate.id;
  copy.sequence = sequence;
  return copy;
}
function protectedBuy() {
  const f = onlyBuy();
  submit(f).intent.protection = { stopLoss: decimal('95'), takeProfit: decimal('105') };
  return f;
}
function candle(f: Fixture, index: number, low: string, high: string, close = '100') {
  const b = f.input.bars[index]!;
  Object.assign(b, {
    open: decimal(close),
    close: decimal(close),
    low: decimal(low),
    high: decimal(high),
  });
  return b;
}
afterEach(async () => {
  for (const path of dirs.splice(0)) {
    if (dirname(resolve(path)) !== resolve(tmpdir()) || !basename(path).startsWith('crypto-spot-'))
      throw new Error('Unsafe cleanup');
    await rm(path, { recursive: true, force: true });
  }
});
async function temp() {
  const root = await mkdtemp(join(tmpdir(), 'crypto-spot-'));
  dirs.push(root);
  return root;
}

describe('spot virtual fills and double-entry accounting', () => {
  it('matches an independent exact round-trip calculation', () => {
    const a = run();
    expect(a.fills.map((f) => [f.fill.side, f.fill.price, f.fill.fee])).toEqual([
      ['BUY', '100', '0.1'],
      ['SELL', '110', '0.11'],
    ]);
    // 1 * 100 * 0.001 + 1 * 110 * 0.001 = 0.21; 1000 - 100 - .1 + 110 - .11.
    expect(addDecimal(a.fills[0]!.fill.fee, a.fills[1]!.fill.fee)).toBe('0.21');
    expect(wallet(a).free).toBe('1009.79');
    expect(wallet(a, 'BTC').free).toBe('0');
    expect(a.journal).toHaveLength(10);
  });
  it('reconciles all posting groups, snapshots and per-action ledger heads', () => {
    const a = run();
    expect(reconcileSpotJournal(a.journal)).toEqual(a.balances);
    for (const entry of a.journal) {
      const sums = new Map<string, ReturnType<typeof decimal>>();
      for (const p of entry.postings) {
        const k = `${p.portfolio}|${p.asset}`;
        sums.set(k, addDecimal(sums.get(k) ?? decimal('0'), p.amount));
      }
      expect([...sums.values()].every((v) => v === '0')).toBe(true);
      expect(
        entry.balancesAfter.every((b) => !b.free.startsWith('-') && !b.reserved.startsWith('-')),
      ).toBe(true);
    }
    for (const t of a.trace) {
      const e = a.journal.find((e) => e.hash === t.journalHead)!;
      expect(t.balancesHash).toBe(canonicalHash(e.balancesAfter));
    }
    for (const f of a.fills) {
      expect(f.journalIds.every((id) => a.journal.some((j) => j.id === id))).toBe(true);
      expect(a.journal.filter((j) => j.fillId === f.fill.id).map((j) => j.kind)).toEqual([
        'TRADE',
        'FEE',
      ]);
    }
  });
  it('reserves full buy cost including fees and rejects use of already reserved cash', () => {
    const f = onlyBuy();
    f.request.initialBalances[0]!.amount = decimal('100.1');
    f.input.commands.push(cloneSubmit(submit(f), ':second', 2));
    const a = run(f);
    expect(a.orders[1]!.rejectionReason).toBe('INSUFFICIENT_UNRESERVED_BALANCE');
    expect(a.fills).toHaveLength(1);
    expect(wallet(a).free).toBe('0');
    expect(
      a.journal.find((j) => j.kind === 'RESERVE')!.balancesAfter.find((b) => b.asset === 'USDT')!
        .reserved,
    ).toBe('100.1');
  });
  it('does not fund fees from negative unreserved cash', () => {
    const f = onlyBuy();
    f.request.initialBalances[0]!.amount = decimal('100');
    const a = run(f);
    expect(a.orders[0]!.order.status).toBe('REJECTED');
    expect(a.fills).toEqual([]);
    expect(wallet(a).free).toBe('100');
  });
  it('reserves inventory and refuses short selling or double reservation of assets', () => {
    const f = setup();
    f.input.commands = [f.input.commands[1]!];
    const a = run(f);
    expect(a.orders[0]!.rejectionReason).toBe('INSUFFICIENT_UNRESERVED_BALANCE');
    const g = setup();
    g.input.commands = [g.input.commands[1]!];
    g.request.initialBalances[1]!.amount = decimal('1');
    const first = submit(g);
    first.at = at(0);
    first.candidate.decisionAt = at(0);
    first.candidate.dataCutoff = at(0);
    first.risk.decisionAt = at(0);
    g.input.commands.push(cloneSubmit(first, ':second', 3));
    expect(run(g).orders[1]!.rejectionReason).toBe('INSUFFICIENT_UNRESERVED_BALANCE');
  });
  it('isolates wallets and volume budgets across portfolios', () => {
    const f = setup();
    f.request.portfolios.push('NEWS_ONLY');
    const originals = f.input.commands.slice();
    for (const c of originals) {
      if (c.kind !== 'SUBMIT') continue;
      const copy = cloneSubmit(c, ':news', c.sequence + 10);
      copy.intent.portfolio = 'NEWS_ONLY';
      copy.candidate.portfolio = 'NEWS_ONLY';
      copy.risk.portfolio = 'NEWS_ONLY';
      f.input.commands.push(copy);
    }
    const a = run(f);
    expect(wallet(a).free).toBe('1009.79');
    expect(wallet(a, 'USDT', 'NEWS_ONLY').free).toBe('1009.79');
    expect(a.fills).toHaveLength(4);
  });
  it('applies adverse market envelope, half-spread, slippage and adverse tick rounding', () => {
    const f = onlyBuy();
    submit(f).intent.marketPriceBound = decimal('120');
    f.request.spreadBps = decimal('20');
    f.request.slippageBps = decimal('5');
    candle(f, 0, '99', '101');
    const a = run(f);
    expect(a.fills[0]!.fill.price).toBe('101.16');
    expect(a.fills[0]!.fill.fee).toBe('0.10116');
    expect(a.fills[0]!.referencePrice).toBe('101');
    expect(a.fills[0]!.flags).toContain('OHLCV_DEPTH_UNKNOWN');
  });
  it('never crosses a market price bound', () => {
    const f = onlyBuy();
    submit(f).intent.marketPriceBound = decimal('99');
    const a = run(f);
    expect(a.fills).toEqual([]);
    expect(a.trace.some((t) => t.reason === 'PRICE_BOUND')).toBe(true);
  });
  it('requires strict limit penetration and charges declared maker fees', () => {
    const f = onlyBuy(),
      c = submit(f);
    c.intent.orderType = 'LIMIT';
    c.intent.limitPrice = decimal('100');
    c.intent.marketPriceBound = null;
    candle(f, 1, '99', '100');
    const a = run(f);
    expect(a.fills[0]!.fill.filledAt).toBe(at(120));
    expect(a.fills[0]!.fill.price).toBe('100');
    expect(a.fills[0]!.fill.liquidity).toBe('MAKER');
    expect(a.fills[0]!.fill.fee).toBe('0.05');
    expect(a.fills[0]!.flags).toContain('MAKER_QUEUE_UNKNOWN_ASSUMED_PENETRATION');
  });
  it('does not treat a limit touch as a guaranteed fill', () => {
    const f = onlyBuy(),
      c = submit(f);
    c.intent.orderType = 'LIMIT';
    c.intent.limitPrice = decimal('100');
    c.intent.marketPriceBound = null;
    expect(run(f).fills).toEqual([]);
  });
  it('requires penetration sufficient to cover modeled spread/slippage for limits', () => {
    const f = onlyBuy(),
      c = submit(f);
    c.intent.orderType = 'LIMIT';
    c.intent.limitPrice = decimal('100');
    c.intent.marketPriceBound = null;
    f.request.spreadBps = decimal('1000');
    candle(f, 1, '99', '100');
    expect(run(f).fills).toEqual([]);
  });
  it('supports sell limits with inventory and respects their minimum execution price', () => {
    const f = setup();
    f.input.commands = [f.input.commands[1]!];
    f.request.initialBalances[1]!.amount = decimal('1');
    const c = submit(f);
    c.intent.orderType = 'LIMIT';
    c.intent.limitPrice = decimal('110');
    c.intent.marketPriceBound = null;
    candle(f, 2, '109', '111', '110');
    const a = run(f);
    expect(a.fills[0]!.fill.price).toBe('110');
    expect(a.fills[0]!.fill.liquidity).toBe('MAKER');
    expect(a.fills[0]!.fill.fee).toBe('0.055');
  });
  it('caps partial fills and tracks exact remaining reservations across candles', () => {
    const f = onlyBuy();
    quantity(f, '2');
    f.request.participationFraction = decimal('0.05');
    candle(f, 2, '100', '100');
    const a = run(f);
    expect(a.fills.map((f) => f.fill.quantity)).toEqual(['0.5', '0.5', '0.5', '0.5']);
    expect(a.orders[0]!.filledQuantity).toBe('2');
    expect(a.orders[0]!.order.status).toBe('FILLED');
    expect(wallet(a).free).toBe('799.8');
    expect(wallet(a, 'BTC').free).toBe('2');
  });
  it('does not partially fill an all-or-none virtual order', () => {
    const f = onlyBuy();
    quantity(f, '2');
    f.request.participationFraction = decimal('0.05');
    submit(f).intent.allowPartial = false;
    const a = run(f);
    expect(a.fills).toEqual([]);
    expect(a.orders[0]!.order.status).toBe('EXPIRED');
  });
  it('shares available candle volume within a portfolio and uses command FIFO for ties', () => {
    const f = onlyBuy();
    f.input.bars = [f.input.bars[0]!];
    const first = submit(f);
    first.intent.clientOrderId = 'synthetic:z-first';
    const second = cloneSubmit(first, ':second', 2);
    second.intent.clientOrderId = 'synthetic:a-second';
    f.input.commands.push(second);
    expect(run(f).fills[0]!.fill.clientOrderId).toBe('synthetic:z-first');
    f.input.commands.reverse();
    expect(run(f).fills[0]!.fill.clientOrderId).toBe('synthetic:z-first');
    const future = structuredClone(f.input.bars[0]!);
    future.id = 'synthetic:future';
    future.availableAt = at(360);
    future.provenance.capturedAt = at(360);
    future.high = decimal('900');
    f.input.bars.push(future);
    expect(run(f).fills[0]!.fill.clientOrderId).toBe('synthetic:z-first');
  });
  it('prevents reused or late-corrected candles from adding fill capacity', () => {
    const f = onlyBuy();
    quantity(f, '2');
    const correction = structuredClone(f.input.bars[0]!);
    correction.id = 'synthetic:correction';
    correction.availableAt = at(61);
    correction.provenance.capturedAt = at(61);
    f.input.bars.push(correction);
    const a = run(f);
    expect(a.fills.map((f) => f.fill.filledAt)).toEqual([at(60), at(120)]);
    expect(a.trace.some((t) => t.reason === 'LATE_OR_CORRECTED_CANDLE_NO_NEW_LIQUIDITY')).toBe(
      true,
    );
    expect(new Set(a.fills.map((f) => f.fill.id)).size).toBe(a.fills.length);
  });
  it('treats submission retries idempotently without reserving or filling twice', () => {
    const f = setup(),
      retry = structuredClone(submit(f));
    retry.id += ':retry';
    retry.sequence = 3;
    retry.at = at(295);
    f.input.commands.push(retry);
    const a = run(f);
    expect(a.orders).toHaveLength(2);
    expect(a.fills).toHaveLength(2);
    expect(a.trace.some((t) => t.reason === 'IDEMPOTENT_RETRY')).toBe(true);
    retry.intent.quantity = decimal('0.5');
    expect(() => run(f)).toThrow('idempotency');
  });
  it('returns the same immutable result on repeated simulator runs', () => {
    const f = setup(),
      engine = new ExecutionSimulator(f.input, f.request, 'synthetic:test'),
      a = engine.run();
    expect(engine.run()).toBe(a);
    expect(canonicalHash(a)).toBe(canonicalHash(run(f)));
    expect(Object.isFrozen(a.journal[0]!.postings)).toBe(true);
    f.input.bars[0]!.high = decimal('999');
    expect(engine.run()).toBe(a);
  });
  it('releases unfilled cash when an order is canceled, without repeated release', () => {
    const f = onlyBuy();
    quantity(f, '2');
    f.input.commands.push(
      {
        kind: 'CANCEL',
        id: 'synthetic:cancel',
        sequence: 3,
        at: at(61),
        portfolio: 'BASELINE',
        clientOrderId: submit(f).intent.clientOrderId,
      },
      {
        kind: 'CANCEL',
        id: 'synthetic:cancel-again',
        sequence: 4,
        at: at(62),
        portfolio: 'BASELINE',
        clientOrderId: submit(f).intent.clientOrderId,
      },
    );
    const a = run(f);
    expect(a.fills).toHaveLength(1);
    expect(a.orders[0]!.order.status).toBe('CANCELED');
    expect(wallet(a).free).toBe('899.9');
    expect(wallet(a).reserved).toBe('0');
  });
  it('applies cancellation latency before making reserved funds reusable', () => {
    const f = onlyBuy();
    f.request.latencyMs = 1000;
    f.request.initialBalances[0]!.amount = decimal('100.1');
    const original = submit(f),
      early = cloneSubmit(original, ':early', 3),
      after = cloneSubmit(original, ':after', 4);
    early.at = shift(30, 500000000n);
    after.at = at(31);
    f.input.commands.push(
      {
        kind: 'CANCEL',
        id: 'synthetic:cancel',
        sequence: 2,
        at: at(30),
        portfolio: 'BASELINE',
        clientOrderId: original.intent.clientOrderId,
      },
      early,
      after,
    );
    const a = run(f);
    expect(a.orders[1]!.rejectionReason).toBe('INSUFFICIENT_UNRESERVED_BALANCE');
    expect(a.orders[2]!.order.status).toBe('FILLED');
    expect(a.trace.find((t) => t.reason === 'CLIENT_CANCEL')!.at).toBe(at(31));
  });
  it('expires orders at their exact lifetime and releases reservations before a same-time candle', () => {
    const f = onlyBuy();
    submit(f).intent.expiresAt = at(60);
    const a = run(f);
    expect(a.fills).toEqual([]);
    expect(a.orders[0]!.order.status).toBe('EXPIRED');
    expect(a.orders[0]!.order.updatedAt).toBe(at(60));
    expect(wallet(a).free).toBe('1000');
  });
  it('requires activity before the entire candle and respects a nanosecond boundary', () => {
    const f = onlyBuy();
    submit(f).at = shift(0, 1n);
    const a = run(f);
    expect(a.fills[0]!.fill.filledAt).toBe(at(120));
    expect(a.trace.some((t) => t.reason === 'ORDER_NOT_ACTIVE_FOR_FULL_CANDLE')).toBe(true);
    const g = onlyBuy();
    g.request.latencyMs = 1;
    expect(run(g).fills[0]!.fill.filledAt).toBe(at(120));
  });
  it('records fills only after the price evidence is available and rejects excessive publication delay', () => {
    const f = onlyBuy();
    f.input.bars[0]!.availableAt = at(61);
    f.input.bars[0]!.provenance.capturedAt = at(61);
    const a = run(f);
    expect(a.fills[0]!.fill.priceAvailableAt).toBe(at(61));
    expect(a.fills[0]!.fill.filledAt).toBe(at(61));
    f.request.maxBarDelayMs = 0;
    expect(run(f).fills[0]!.fill.filledAt).toBe(at(120));
  });
  it('rejects denied, stale, mismatched or oversized authorizations without moving funds', () => {
    for (const edit of [
      (c: ReturnType<typeof submit>) => {
        c.risk.allowed = false;
        c.risk.sizing.quantity = decimal('0');
        c.risk.sizing.maxNotional = decimal('0');
      },
      (c: ReturnType<typeof submit>) => {
        c.candidate.side = 'HOLD';
      },
      (c: ReturnType<typeof submit>) => {
        c.risk.candidateId = 'wrong';
      },
      (c: ReturnType<typeof submit>) => {
        c.risk.sizing.quantity = decimal('0.5');
      },
      (c: ReturnType<typeof submit>) => {
        c.candidate.validUntil = at(10);
      },
      (c: ReturnType<typeof submit>) => {
        c.risk.decisionAt = at(1);
      },
    ]) {
      const f = onlyBuy();
      edit(submit(f));
      const a = run(f);
      expect(a.orders[0]!.order.status).toBe('REJECTED');
      expect(a.fills).toEqual([]);
      expect(wallet(a).free).toBe('1000');
    }
  });
  it('enforces cumulative authorized notional on actual sell fills', () => {
    const f = setup();
    submit(f, 1).risk.sizing.maxNotional = decimal('100');
    const a = run(f);
    expect(a.fills.map((f) => f.fill.side)).toEqual(['BUY', 'SELL']);
    expect(a.fills[1]!.fill.filledAt).toBe(at(240));
    expect(a.trace.some((t) => t.reason === 'RISK_NOTIONAL_AT_FILL')).toBe(true);
  });
  it('rejects tick/lot mismatches and invalid protective prices', () => {
    for (const edit of [
      (c: ReturnType<typeof submit>) => {
        c.intent.quantity = decimal('0.001');
      },
      (c: ReturnType<typeof submit>) => {
        c.intent.marketPriceBound = decimal('100.001');
      },
      (c: ReturnType<typeof submit>) => {
        c.intent.protection = { stopLoss: decimal('99'), takeProfit: decimal('100') };
      },
    ]) {
      const f = onlyBuy();
      edit(submit(f));
      expect(run(f).orders[0]!.rejectionReason).toBe('PRECISION_OR_PROTECTION');
    }
  });
  it('honors fixed stop/target requirements in the risk decision', () => {
    const f = onlyBuy();
    submit(f).risk.stopTargetPolicy = {
      kind: 'FIXED',
      stopPrice: decimal('95'),
      targetPrice: decimal('105'),
    };
    expect(run(f).orders[0]!.rejectionReason).toBe('RISK_PROTECTION_POLICY');
    submit(f).intent.protection = { stopLoss: decimal('95'), takeProfit: decimal('106') };
    expect(run(f).orders[0]!.rejectionReason).toBe('RISK_PROTECTION_POLICY');
    submit(f).intent.protection!.takeProfit = decimal('105');
    expect(run(f).orders[0]!.order.status).toBe('FILLED');
  });
  it('requires historical listing/mapping/precision and correctly bound source evidence', () => {
    const f = onlyBuy();
    f.input.market.instruments.find((m) => m.instrumentKey === 'cross:SPOT:BTC')!.availableAt =
      at(90);
    expect(run(f).orders[0]!.rejectionReason).toBe('HISTORICAL_METADATA_UNAVAILABLE');
    const g = onlyBuy();
    for (const b of g.input.bars) b.provenance.sourceIds = ['synthetic:wrong'];
    expect(run(g).fills).toEqual([]);
    const h = onlyBuy();
    h.input.market.instruments.find((m) => m.instrumentKey === 'cross:SPOT:BTC')!.delistedAt =
      at(30);
    expect(run(h).fills).toEqual([]);
  });
  it('cancels a remaining order when known precision changes rather than silently rounding it', () => {
    const f = onlyBuy();
    quantity(f, '2');
    f.request.participationFraction = decimal('0.05');
    const original = f.input.market.instruments.find((m) => m.instrumentKey === 'cross:SPOT:BTC')!;
    f.input.market.instruments.push({
      ...original,
      id: 'synthetic:precision:2',
      revision: 2,
      effectiveFrom: at(120),
      observedAt: at(120),
      availableAt: at(150),
      tickSize: decimal('0.1'),
    });
    const a = run(f);
    expect(a.orders[0]!.order.status).toBe('CANCELED');
    expect(a.orders[0]!.filledQuantity).toBe('1');
    expect(a.trace.some((t) => t.reason === 'METADATA_CHANGED')).toBe(true);
  });
  it('chooses the adverse stop when stop and target are hit in one full candle', () => {
    const f = protectedBuy();
    candle(f, 1, '90', '110');
    const a = run(f);
    expect(a.orders).toHaveLength(2);
    expect(a.fills[1]!.trigger).toBe('STOP');
    expect(a.fills[1]!.fill.price).toBe('90');
    expect(a.fills[1]!.fill.fee).toBe('0.09');
    expect(a.fills[1]!.flags).toContain('STOP_AND_TARGET_TOUCHED_STOP_FIRST');
    expect(wallet(a).free).toBe('989.81');
    expect(wallet(a, 'BTC').free).toBe('0');
  });
  it('prices a target-only protective exit with conservative taker fees', () => {
    const f = protectedBuy();
    candle(f, 1, '96', '110');
    const a = run(f);
    expect(a.fills[1]!.trigger).toBe('TARGET');
    expect(a.fills[1]!.fill.price).toBe('105');
    expect(a.fills[1]!.fill.liquidity).toBe('TAKER');
    expect(a.fills[1]!.fill.fee).toBe('0.105');
  });
  it('allows a stop gap to execute worse than the stop and never fabricates the stop quote', () => {
    const f = protectedBuy();
    candle(f, 1, '85', '94', '90');
    const a = run(f);
    expect(a.fills[1]!.fill.price).toBe('85');
    expect(a.fills[1]!.fill.priceAvailableAt).toBe(at(120));
  });
  it('latches an unfilled stop and retains its source evidence after a volume outage', () => {
    const f = protectedBuy();
    candle(f, 1, '90', '110').volume = decimal('0');
    candle(f, 2, '100', '100');
    const a = run(f);
    expect(a.fills[1]!.fill.filledAt).toBe(at(180));
    expect(a.fills[1]!.trigger).toBe('STOP');
    expect(a.fills[1]!.fill.evidenceIds).toContain(f.input.bars[1]!.id);
    expect(a.trace.some((t) => t.reason === 'AMBIGUOUS_STOP_TARGET_STOP_FIRST')).toBe(true);
  });
  it('does not create a protective exit using earlier movement in the entry candle', () => {
    const f = protectedBuy();
    candle(f, 0, '90', '100');
    const a = run(f);
    expect(a.fills.filter((f) => f.fill.side === 'SELL')).toHaveLength(1);
    expect(a.fills[1]!.fill.filledAt).toBe(at(180));
    expect(a.fills[1]!.barId).not.toBe(f.input.bars[0]!.id);
  });
  it('cancels attached protection explicitly and releases its reserved inventory once', () => {
    const f = protectedBuy();
    f.input.commands.push({
      kind: 'CANCEL',
      id: 'synthetic:cancel',
      sequence: 3,
      at: at(61),
      portfolio: 'BASELINE',
      clientOrderId: submit(f).intent.clientOrderId,
    });
    const a = run(f);
    expect(a.fills).toHaveLength(1);
    expect(a.orders[1]!.order.status).toBe('CANCELED');
    expect(wallet(a, 'BTC')).toMatchObject({ free: '1', reserved: '0' });
  });
  it('bounds fees on tiny partial fills without exhausting reserved quote dust', () => {
    const f = onlyBuy();
    f.request.quoteScale = 2;
    f.request.participationFraction = decimal('0.001');
    quantity(f, '0.04');
    candle(f, 2, '100', '100');
    const a = run(f);
    expect(a.fills).toHaveLength(4);
    expect(a.fills.every((f) => f.fill.fee === '0.01')).toBe(true);
    expect(wallet(a).free).toBe('995.96');
  });
  it('retains missing and descriptive price evidence without inventing executions', () => {
    const f = onlyBuy();
    f.input.bars = [];
    const a = run(f);
    expect(a.fills).toEqual([]);
    expect(wallet(a).free).toBe('1000');
    expect(a.orders[0]!.order.status).toBe('EXPIRED');
    const g = onlyBuy();
    for (const b of g.input.bars) {
      b.researchUse = 'DESCRIPTIVE_ONLY';
      b.availableAt = null;
      b.availabilityBasis = 'UNKNOWN';
    }
    expect(run(g).excludedBars).toHaveLength(4);
    expect(run(g).fills).toEqual([]);
  });
  it('releases outstanding reservations at run end without inventing liquidation trades', () => {
    const f = onlyBuy();
    f.input.bars = [];
    submit(f).intent.expiresAt = at(600);
    const a = run(f);
    expect(a.orders[0]!.order.status).toBe('CANCELED');
    expect(a.orders[0]!.order.updatedAt).toBe(f.request.endAt);
    expect(a.fills).toEqual([]);
    expect(wallet(a).free).toBe('1000');
  });
  it('does not consume evidence arriving at the half-open run end', () => {
    const f = onlyBuy();
    f.input.bars = [f.input.bars[0]!];
    f.input.bars[0]!.availableAt = f.request.endAt;
    f.input.bars[0]!.provenance.capturedAt = f.request.endAt;
    const a = run(f);
    expect(a.fills).toEqual([]);
    expect(a.excludedBars[0]!.reason).toBe('OUTSIDE_PERIOD');
  });
  it('rejects a candidate whose known rationale points to a later-available candle', () => {
    const f = onlyBuy();
    submit(f).candidate.rationaleIds = [f.input.bars[2]!.id];
    const a = run(f);
    expect(a.orders[0]!.rejectionReason).toBe('FUTURE_CANDIDATE_EVIDENCE');
    expect(a.fills).toEqual([]);
  });
  it('retains inventory when rounded fees exceed tiny sale proceeds', () => {
    const f = setup();
    f.input.commands = [f.input.commands[1]!];
    f.request.initialBalances[0]!.amount = decimal('0');
    f.request.initialBalances[1]!.amount = decimal('0.01');
    f.request.quoteScale = 0;
    const c = submit(f);
    c.intent.quantity = decimal('0.01');
    c.risk.sizing.quantity = decimal('0.01');
    c.intent.marketPriceBound = decimal('0.01');
    for (let i = 0; i < f.input.bars.length; i++) candle(f, i, '0.01', '0.01', '0.01');
    const a = run(f);
    expect(a.fills).toEqual([]);
    expect(wallet(a, 'BTC').free).toBe('0.01');
    expect(a.trace.some((t) => t.reason === 'FEE_EXCEEDS_SALE_PROCEEDS')).toBe(true);
  });
  it('caps aggregate partial-sale notional rather than checking each fill independently', () => {
    const f = setup();
    f.input.commands = [f.input.commands[1]!];
    const c = submit(f);
    c.at = at(0);
    c.candidate.decisionAt = at(0);
    c.candidate.dataCutoff = at(0);
    c.risk.decisionAt = at(0);
    c.intent.quantity = decimal('2');
    c.risk.sizing.quantity = decimal('2');
    c.risk.sizing.maxNotional = decimal('150');
    c.intent.marketPriceBound = decimal('50');
    f.request.initialBalances[1]!.amount = decimal('2');
    const a = run(f);
    expect(a.fills).toHaveLength(1);
    expect(a.orders[0]!.filledQuantity).toBe('1');
    expect(wallet(a, 'BTC').free).toBe('1');
  });
  it('backs multiple protective lots only with their acquired inventory', () => {
    const f = protectedBuy();
    quantity(f, '2');
    candle(f, 1, '90', '110');
    const a = run(f);
    expect(a.fills.map((f) => [f.fill.side, f.fill.quantity])).toEqual([
      ['BUY', '1'],
      ['SELL', '1'],
      ['BUY', '1'],
    ]);
    expect(a.orders.filter((o) => o.parentOrderId !== null)).toHaveLength(2);
    expect(wallet(a, 'BTC')).toMatchObject({ free: '1', reserved: '0' });
    expect(reconcileSpotJournal(a.journal)).toEqual(a.balances);
  });
  it('can settle an explicit zero-fee scenario with exact cash exhaustion', () => {
    const f = onlyBuy();
    f.request.makerRate = decimal('0');
    f.request.takerRate = decimal('0');
    f.request.initialBalances[0]!.amount = decimal('100');
    const a = run(f);
    expect(a.fills[0]!.fill.fee).toBe('0');
    expect(wallet(a).free).toBe('0');
    expect(wallet(a, 'BTC').free).toBe('1');
  });
  it('keeps reservations and executed quantities valid over varied synthetic capacities', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 4 }), fc.integer({ min: 1, max: 10 }), (q, volume) => {
        const f = onlyBuy();
        quantity(f, String(q));
        for (const b of f.input.bars) b.volume = decimal(String(volume));
        const a = run(f);
        expect(a.balances.every((b) => !b.free.startsWith('-') && b.reserved === '0')).toBe(true);
        expect(Number(a.orders[0]!.filledQuantity)).toBeLessThanOrEqual(q);
        expect(reconcileSpotJournal(a.journal)).toEqual(a.balances);
      }),
      { numRuns: 20, seed: 42 },
    );
  });
  it('rejects conflicting source/command/authorization identities and unsupported derivative modes', () => {
    const f = setup();
    f.input.commands.push(f.input.commands[0]!);
    expect(() => run(f)).toThrow('Duplicate');
    const g = onlyBuy();
    g.input.bars.push(g.input.bars[0]!);
    expect(() => run(g)).toThrow('Duplicate');
    const h = onlyBuy(),
      copy = structuredClone(submit(h));
    copy.id += ':other';
    copy.sequence = 2;
    copy.candidate.side = 'SHORT';
    h.input.commands.push(copy);
    expect(() => run(h)).toThrow('authorization evidence');
    for (const bad of [
      { ...f.request, marketType: 'PERPETUAL' },
      { ...f.request, derivatives: 'ENABLED' },
      { ...f.request, leverage: '2' },
      { ...f.request, allowShort: true },
      { ...f.request, participationFraction: '0' },
      { ...f.request, takerRate: '0.2' },
      { ...f.request, execute: true },
    ])
      expect(SpotSimulationRequestSchema.safeParse(bad).success).toBe(false);
    expect(
      SpotOrderIntentSchema.safeParse({ ...submit(f).intent, marketPriceBound: null }).success,
    ).toBe(false);
  });
  it('detects changed journal balances, fill prices, traces and configuration by semantic rebuild', () => {
    const a = run();
    for (const edit of [
      (b: typeof a) => {
        b.balances[0]!.free = decimal('999');
      },
      (b: typeof a) => {
        b.fills[0]!.fill.price = decimal('99');
      },
      (b: typeof a) => {
        b.trace[0]!.reason = 'fabricated';
      },
      (b: typeof a) => {
        b.request.spreadBps = decimal('1');
      },
    ]) {
      const b = structuredClone(a);
      edit(b);
      expect(() => validateSpotSimulationArtifact(b)).toThrow();
    }
    const j = structuredClone(a.journal);
    j[0]!.postings[0]!.amount = decimal('999');
    expect(() => reconcileSpotJournal(j)).toThrow();
  });
  it('writes byte-stable immutable artifacts and refuses to replace corrupt files', async () => {
    const f = setup(),
      root = await temp(),
      a = await writeSpotSimulationArtifact(f.input, f.request, root, 'synthetic:test'),
      b = await writeSpotSimulationArtifact(f.input, f.request, root, 'synthetic:test');
    expect(a.hash).toBe(b.hash);
    expect((await verifySpotSimulationArtifact(a.path)).artifact).toEqual(a.artifact);
    expect(await readdir(root)).toEqual([basename(a.path)]);
    const wrong = join(root, 'wrong.json');
    await writeFile(wrong, await readFile(a.path));
    await expect(verifySpotSimulationArtifact(wrong)).rejects.toThrow('name');
    await writeFile(a.path, '{}');
    await expect(
      writeSpotSimulationArtifact(f.input, f.request, root, 'synthetic:test'),
    ).rejects.toThrow();
    expect(await readFile(a.path, 'utf8')).toBe('{}');
    expect((await readdir(root)).some((n) => n.startsWith('.spot-'))).toBe(false);
  });
  it('reports execution uncertainty and rejects credential/live CLI flags', () => {
    const report = spotSimulationReport(run());
    expect(report).toContain('live execution: DISABLED');
    expect(report).toContain('maker queues are unknown');
    expect(report).toContain('No strategy performance');
    for (const args of [
      ['spot-fixture', '--execute', 'true'],
      ['spot-run', '--input', 'missing'],
      ['spot-verify', '--artifact', 'missing', '--private-key', 'forbidden'],
    ]) {
      const p = spawnSync(
        process.execPath,
        ['--import', 'tsx', 'apps/cli/src/replay.ts', ...args],
        { cwd: process.cwd(), encoding: 'utf8', timeout: 15000 },
      );
      expect(p.status).toBe(1);
      expect(p.stdout).toBe('');
      expect(p.stderr).not.toContain('forbidden');
    }
  }, 30000);
});
