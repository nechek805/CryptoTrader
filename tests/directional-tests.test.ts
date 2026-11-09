import { describe, it, expect } from 'vitest';
import { DirectionProfileSchema, SHORT_ASSUMPTIONS, MARKET_ASSETS } from '@crypto/contracts';
import { canonicalHash, decimal } from '@crypto/core';
import {
  runDirectionalTest,
  verifyDirectionalReport,
  runMarketStrategy,
  runSpecialistStrategy,
  runSpecialistV5,
  specialistV5Baseline,
  MarginResearchLedger,
  reconcileMarginResearchJournal,
} from '@crypto/backtest';
import { D } from '../packages/backtest/src/spot-math.js';
import { marketHistoryFixture } from './helpers/market-history.js';
function falling() {
  const data = marketHistoryFixture('BTC');
  data.bars = data.bars.map((b, i) => {
    const price = 250 - i * 0.1 + 8 * Math.sin(i / 12);
    return {
      ...b,
      open: decimal(price.toFixed(8)),
      close: decimal(price.toFixed(8)),
      high: decimal((price + 0.8).toFixed(8)),
      low: decimal((price - 0.8).toFixed(8)),
    };
  });
  return data;
}
describe('collateralized short research', () => {
  it.each(MARKET_ASSETS)('records %s debt in its own token and uses its tick/lot grid', (asset) => {
    const data = marketHistoryFixture(asset),
      r = runDirectionalTest(data, { asset, strategy: 'V1' }, 'SHORT_ONLY');
    expect(r.report.trades.length).toBeGreaterThan(0);
    for (const t of r.report.trades) {
      expect(new D(t.price).mod(data.instrument.filters.priceTick).isZero()).toBe(true);
      expect(new D(t.quantity).mod(data.instrument.filters.quantityStep).isZero()).toBe(true);
    }
    expect(r.journal.some((e) => new D(e.balances[asset + '/DEBT'] ?? 0).lt(0))).toBe(true);
    expect(() => reconcileMarginResearchJournal(r.journal)).not.toThrow();
  });
  it.each(['V1', 'V2', 'V3'] as const)(
    'preserves frozen %s long behavior across both fee modes',
    (strategy) => {
      const data = marketHistoryFixture();
      for (const fee of ['STANDARD', 'ZERO'] as const) {
        const old = runMarketStrategy(data, strategy, fee),
          r = runDirectionalTest(data, { asset: 'BTC', strategy }, 'LONG_ONLY', fee);
        for (const k of [
          'finalEquity',
          'netPnl',
          'maxDrawdown',
          'fees',
          'slippage',
          'closedTrades',
          'wins',
          'openBase',
        ] as const)
          expect(r.report.summary[k]).toBe(old.report.summary[k]);
        expect(
          r.report.trades.map((t) => [t.index, t.side, t.quantity, t.price, t.fee, t.slippage]),
        ).toEqual(
          old.report.trades.map((t) => [t.index, t.side, t.quantity, t.price, t.fee, t.slippage]),
        );
        expect(r.report.summary.financing).toBe('0');
      }
    },
  );
  it.each(['SOL', 'XRP'] as const)(
    'preserves selected %s specialist profiles for V4 and V5',
    (asset) => {
      const data = marketHistoryFixture(asset),
        v4 = specialistV5Baseline(asset),
        v5 = {
          ...v4,
          ...(asset === 'SOL'
            ? { lowVolatilityThreshold: '0.008', lowVolatilityTargetAtr: '4' }
            : { adaptiveLowerAtr: '1.5', adaptiveTargetAtr: '6' }),
        };
      for (const strategy of ['V4', 'V5'] as const) {
        const candidate = strategy === 'V4' ? v4 : v5,
          old =
            strategy === 'V4'
              ? runSpecialistStrategy(data, candidate)
              : runSpecialistV5(data, candidate),
          r = runDirectionalTest(data, { asset, strategy, candidate }, 'LONG_ONLY');
        expect(r.report.summary.netPnl).toBe(old.report.summary.netPnl);
        expect(r.report.trades.map((t) => [t.index, t.side, t.price, t.quantity])).toEqual(
          old.report.trades.map((t) => [t.index, t.side, t.price, t.quantity]),
        );
      }
    },
  );
  it('earns on a declining fixture, freezes borrow terms and reconciles each completed short by hand', () => {
    const data = falling(),
      r = runDirectionalTest(data, { asset: 'BTC', strategy: 'V2' }, 'SHORT_ONLY');
    expect(r.report.trades.length).toBeGreaterThan(0);
    expect(r.report.trades.every((t) => t.direction === 'SHORT')).toBe(true);
    expect(new D(r.report.summary.netPnl).gt(0)).toBe(true);
    let entry: (typeof r.report.trades)[number] | undefined;
    for (const t of r.report.trades) {
      if (t.kind === 'OPEN') {
        entry = t;
        expect(t.side).toBe('SELL');
        expect(new D(t.stop).gt(t.price)).toBe(true);
        expect(new D(t.target).lt(t.price)).toBe(true);
      } else {
        expect(t.side).toBe('BUY');
        const n = new D(entry!.quantity).mul(entry!.price),
          hours = Math.ceil((t.at - entry!.at) / 3600000),
          borrow = n.mul('0.1').div(8760).toDecimalPlaces(18).mul(hours),
          net = new D(t.quantity)
            .mul(new D(entry!.price).minus(t.price))
            .minus(entry!.fee)
            .minus(t.fee)
            .minus(borrow);
        expect(t.financing).toBe(borrow.toFixed());
        expect(t.net).toBe(net.toFixed());
        entry = undefined;
      }
    }
    const after = reconcileMarginResearchJournal(r.journal);
    expect(after.balance('USDT', 'FINANCING').toFixed()).toBe(r.report.summary.financing);
    expect(
      new D(r.report.summary.long.net)
        .plus(r.report.summary.short.net)
        .plus(r.report.summary.openContribution)
        .toFixed(),
    ).toBe(r.report.summary.netPnl);
    for (const d of r.report.decisions) {
      expect(new D(d.cash).gte(0)).toBe(true);
      expect(new D(d.collateral).gte(0)).toBe(true);
      if (d.positionSide === 'SHORT') {
        expect(new D(d.position).lt(0)).toBe(true);
        expect(new D(d.loan).gt(0)).toBe(true);
        expect(new D(d.collateral).gt(0)).toBe(true);
      }
    }
    expect(r.report.plan.assumptions).toEqual(SHORT_ASSUMPTIONS);
    expect(verifyDirectionalReport(r.report, data).id).toBe(r.id);
  });
  it('uses a mirrored lower-half close for shorts and keeps fees-off borrowing enabled', () => {
    const data = falling(),
      r = runDirectionalTest(data, { asset: 'BTC', strategy: 'V3' }, 'SHORT_ONLY', 'ZERO');
    expect(r.report.summary.fees).toBe('0');
    expect(new D(r.report.summary.financing).gt(0)).toBe(true);
    expect(new D(r.report.summary.slippage).gt(0)).toBe(true);
    for (const fill of r.report.trades.filter((t) => t.kind === 'OPEN')) {
      const signal = r.report.decisions[fill.index - 1]!;
      expect(signal.action).toBe('SHORT');
      expect(signal.shortGate).toBe('PASS');
      expect(new D(signal.closeLocation!).lte('.5')).toBe(true);
      expect(signal.trendRising).toBe(false);
    }
  });
  it('closes before reversing, locks short proceeds and applies both fill fees', () => {
    const data = marketHistoryFixture(),
      r = runDirectionalTest(data, { asset: 'BTC', strategy: 'V1' }, 'LONG_SHORT');
    expect(r.report.trades.some((t) => t.direction === 'LONG')).toBe(true);
    expect(r.report.trades.some((t) => t.direction === 'SHORT')).toBe(true);
    let side: string | null = null;
    for (const t of r.report.trades) {
      if (t.kind === 'OPEN') {
        expect(side).toBeNull();
        side = t.direction;
        expect(
          new D(t.quantity)
            .mul(t.price)
            .lte(new D(r.report.decisions[Math.max(0, t.index - 1)]!.equity).mul('.101')),
        ).toBe(true);
      } else {
        expect(t.direction).toBe(side);
        side = null;
      }
      expect(new D(t.fee).gt(0)).toBe(true);
    }
    const shorts = r.journal.filter(
      (e) => e.kind === 'OPEN' && new D(e.balances['BTC/DEBT'] ?? 0).lt(0),
    );
    expect(shorts.length).toBeGreaterThan(0);
    for (const e of shorts) {
      expect(e.balances['USDT/RESERVED']).toBe(e.balances['USDT/PROCEEDS']);
      expect(new D(e.balances['USDT/FREE']!).lt(10000)).toBe(true);
    }
  });
  it('uses adverse-first short exits and a worse opening gap without future signal leakage', () => {
    const data = falling(),
      r = runDirectionalTest(data, { asset: 'BTC', strategy: 'V1' }, 'SHORT_ONLY'),
      entry = r.report.trades.find((t) => t.kind === 'OPEN')!,
      changed = structuredClone(data),
      i = entry.index + 1;
    const gap = new D(entry.stop).plus(3);
    changed.bars[i] = {
      ...changed.bars[i]!,
      open: decimal(gap.toFixed()),
      high: decimal(gap.plus(1).toFixed()),
      low: decimal(new D(entry.target).minus(1).toFixed()),
      close: decimal(entry.price),
    };
    const b = runDirectionalTest(changed, { asset: 'BTC', strategy: 'V1' }, 'SHORT_ONLY');
    expect(b.report.decisions.slice(0, i)).toEqual(r.report.decisions.slice(0, i));
    const exit = b.report.trades.find((t) => t.index === i && t.kind === 'CLOSE')!;
    expect(exit.reason).toContain('STOP');
    expect(new D(exit.price).gte(gap.mul('1.0005'))).toBe(true);
    expect(new D(exit.net!).lt(0)).toBe(true);
  });
  it('records catastrophic gap debt and halts instead of creating negative spendable cash', () => {
    const data = falling(),
      a = runDirectionalTest(data, { asset: 'BTC', strategy: 'V1' }, 'SHORT_ONLY'),
      entry = a.report.trades.find((t) => t.kind === 'OPEN')!,
      i = entry.index + 1,
      price = new D(entry.price).mul(100).toFixed();
    for (let j = i; j < data.bars.length; j++)
      data.bars[j] = {
        ...data.bars[j]!,
        open: decimal(price),
        high: decimal(price),
        low: decimal(price),
        close: decimal(price),
      };
    const r = runDirectionalTest(data, { asset: 'BTC', strategy: 'V1' }, 'SHORT_ONLY');
    expect(r.report.summary.insolvent).toBe(true);
    expect(new D(r.report.summary.badDebt).gt(0)).toBe(true);
    expect(new D(r.report.summary.finalEquity).lt(0)).toBe(true);
    expect(
      r.report.decisions.slice(i).every((d) => d.action === 'HALTED' && new D(d.cash).gte(0)),
    ).toBe(true);
    expect(r.report.trades.filter((t) => t.kind === 'OPEN')).toHaveLength(1);
    expect(() => reconcileMarginResearchJournal(r.journal)).not.toThrow();
  });
  it('rejects counterfeit loans, profile overrides and mutated reports', () => {
    expect(
      DirectionProfileSchema.safeParse({
        asset: 'BTC',
        strategy: 'V4',
        candidate: specialistV5Baseline('SOL'),
      }).success,
    ).toBe(false);
    expect(
      DirectionProfileSchema.safeParse({ asset: 'BTC', strategy: 'V1', leverage: '20' }).success,
    ).toBe(false);
    const ledger = new MarginResearchLedger();
    expect(() =>
      ledger.post(1, 'OPEN', [
        { asset: 'USDT', account: 'FREE', amount: decimal('-1') },
        { asset: 'USDT', account: 'EXTERNAL', amount: decimal('1') },
      ]),
    ).toThrow('Negative');
    expect(() =>
      ledger.post(1, 'DEPOSIT', [
        { asset: 'USDT', account: 'FREE', amount: decimal('1') },
        { asset: 'USDT', account: 'EXTERNAL', amount: decimal('0') },
      ]),
    ).toThrow('Unbalanced');
    const data = falling(),
      r = runDirectionalTest(data, { asset: 'BTC', strategy: 'V2' }, 'SHORT_ONLY'),
      bad = structuredClone(r.report);
    bad.summary.netPnl = decimal('999');
    expect(() => verifyDirectionalReport(bad, data)).toThrow('mismatch');
    const journal = structuredClone(r.journal);
    journal[0]!.balances['USDT/FREE'] = decimal('99999');
    expect(() => reconcileMarginResearchJournal(journal)).toThrow('mismatch');
    expect(canonicalHash(r.report)).toBe(r.id);
  });
});
