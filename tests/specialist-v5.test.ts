import { describe, it, expect } from 'vitest';
import { SpecialistV5CandidateSchema } from '@crypto/contracts';
import { canonicalHash, decimal } from '@crypto/core';
import {
  runSpecialistV5,
  verifySpecialistV5Report,
  runSpecialistStrategy,
  specialistV5Baseline,
  specialistV5Candidates,
  searchSpecialistV5,
  chooseSpecialistV5,
  reconcileSpotJournal,
  diagnoseSpecialistV5Trades,
  compareSpecialistV5Trades,
} from '@crypto/backtest';
import { D } from '../packages/backtest/src/spot-math.js';
import { marketHistoryFixture } from './helpers/market-history.js';

describe('separate v5 exit research', () => {
  it.each(['SOL', 'XRP'] as const)(
    'reproduces the selected %s v4 parent with no extra exit rule, in both cost modes',
    (asset) => {
      const data = marketHistoryFixture(asset),
        candidate = specialistV5Baseline(asset);
      for (const mode of ['STANDARD', 'ZERO'] as const) {
        const a = runSpecialistStrategy(data, candidate, mode),
          b = runSpecialistV5(data, candidate, mode);
        expect(
          b.report.decisions.map((d) =>
            Object.fromEntries(Object.entries(d).filter(([name]) => name !== 'targetAtrUsed')),
          ),
        ).toEqual(a.report.decisions);
        for (const key of ['trades', 'summary', 'journalHash'] as const)
          expect(b.report[key]).toEqual(a.report[key]);
        expect(b.journal).toEqual(a.journal);
        expect(verifySpecialistV5Report(b.report, data).id).toBe(b.id);
      }
    },
  );
  it('keeps the whole registered search, rejects cross-coin rules and risk overrides', () => {
    for (const [asset, count] of [
      ['SOL', 18],
      ['XRP', 13],
    ] as const) {
      const candidates = specialistV5Candidates(asset);
      expect(candidates).toHaveLength(count);
      expect(new Set(candidates.map(canonicalHash)).size).toBe(count);
    }
    for (const bad of [
      { ...specialistV5Baseline('SOL'), adaptiveLowerAtr: '1.5', adaptiveTargetAtr: '6' },
      { ...specialistV5Baseline('XRP'), trailDistanceAtr: '2' },
      { ...specialistV5Baseline('SOL'), lowVolatilityThreshold: '0.008' },
      { ...specialistV5Baseline('SOL'), riskFraction: '1' },
    ])
      expect(SpecialistV5CandidateSchema.safeParse(bad).success).toBe(false);
    expect(() => runSpecialistV5(marketHistoryFixture('BTC'), specialistV5Baseline('SOL'))).toThrow(
      'another asset',
    );
  });
  it('selects only fee-on development results and is invariant to later prices', async () => {
    const data = marketHistoryFixture('SOL'),
      changed = structuredClone(data),
      split = 400;
    changed.bars = changed.bars.map((b, i) =>
      i < split
        ? b
        : {
            ...b,
            open: decimal('500'),
            high: decimal('510'),
            low: decimal('490'),
            close: decimal('500'),
          },
    );
    const a = await searchSpecialistV5(data, 'SOL', split),
      b = await searchSpecialistV5(changed, 'SOL', split);
    expect(a.selected.candidate).toEqual(b.selected.candidate);
    expect(a.trials.map((t) => t.result.report.summary)).toEqual(
      b.trials.map((t) => t.result.report.summary),
    );
    expect(() => chooseSpecialistV5(a.trials.slice(1))).toThrow('grid');
    const free = structuredClone(a.trials);
    free[0]!.result.report.plan.feeMode = 'ZERO';
    expect(() => chooseSpecialistV5(free)).toThrow('fee-on');
    const unsafe = structuredClone(a.trials);
    for (const t of unsafe) t.result.report.summary.maxDrawdown = decimal('0.03');
    expect(() => chooseSpecialistV5(unsafe)).toThrow('drawdown ceiling');
    const max = a.trials
      .filter((t) => new D(t.result.report.summary.maxDrawdown).lte('0.02'))
      .sort((x, y) =>
        new D(y.result.report.summary.netPnl).cmp(x.result.report.summary.netPnl),
      )[0]!;
    expect(a.selected.result.report.summary.netPnl).toBe(max.result.report.summary.netPnl);
  }, 30000);
  it('freezes targets from the signal candle, retains slippage with fees off, and reconciles closed-trade changes', () => {
    for (const asset of ['SOL', 'XRP'] as const) {
      const data = marketHistoryFixture(asset),
        base = specialistV5Baseline(asset),
        candidate = SpecialistV5CandidateSchema.parse(
          asset === 'SOL'
            ? { ...base, lowVolatilityThreshold: '0.008', lowVolatilityTargetAtr: '4' }
            : { ...base, adaptiveLowerAtr: '1', adaptiveTargetAtr: '6' },
        ),
        r = runSpecialistV5(data, candidate);
      expect(r.report.trades.length).toBeGreaterThan(0);
      for (const t of r.report.trades.filter((t) => t.side === 'BUY')) {
        const signal = r.report.decisions[t.index - 1]!;
        expect(signal.action).toBe('LONG');
        expect(
          new D(t.target!).minus(t.price).gte(new D(signal.atr!).mul(signal.targetAtrUsed)),
        ).toBe(true);
        expect(
          new D(t.target!)
            .minus(t.price)
            .minus(new D(signal.atr!).mul(signal.targetAtrUsed))
            .lt(data.instrument.filters.priceTick),
        ).toBe(true);
      }
      const free = runSpecialistV5(data, candidate, 'ZERO');
      expect(free.report.summary.fees).toBe('0');
      expect(new D(free.report.summary.slippage).gt(0)).toBe(true);
      const attribution = diagnoseSpecialistV5Trades(r.report);
      expect(new D(attribution.closedNet).plus(attribution.openContribution).toFixed()).toBe(
        r.report.summary.netPnl,
      );
      expect(() => reconcileSpotJournal(r.journal)).not.toThrow();
      const old = runSpecialistStrategy(data, base),
        changes = compareSpecialistV5Trades(old.report, r.report);
      expect(changes.reduce((s, t) => s.plus(t.delta), new D(0)).toFixed()).toBe(
        new D(attribution.closedNet)
          .minus(diagnoseSpecialistV5Trades(runSpecialistV5(data, base).report).closedNet)
          .toFixed(),
      );
      const bad = structuredClone(r.report);
      bad.summary.netPnl = decimal('999');
      expect(() => verifySpecialistV5Report(bad, data)).toThrow('mismatch');
    }
  });
  it('raises trailing stops only after a completed close, never backwards or using same-candle extremes', () => {
    const data = marketHistoryFixture('SOL'),
      candidate = { ...specialistV5Baseline('SOL'), trailDistanceAtr: '2' },
      r = runSpecialistV5(data, candidate);
    const raised = r.report.decisions.find(
      (d, i) =>
        i > 0 &&
        d.stop &&
        r.report.decisions[i - 1]!.stop &&
        new D(d.stop).gt(r.report.decisions[i - 1]!.stop!),
    );
    expect(raised).toBeDefined();
    const i = raised!.index,
      previous = r.report.decisions[i - 1]!,
      mutated = structuredClone(data),
      bar = mutated.bars[i]!;
    const low = D.min(new D(raised!.stop!).minus('0.01'), bar.open, bar.close);
    expect(low.gt(previous.stop!)).toBe(true);
    mutated.bars[i] = { ...bar, low: decimal(low.toFixed()) };
    const gap = new D(raised!.stop!).minus(2).toFixed();
    mutated.bars[i + 1] = {
      ...mutated.bars[i + 1]!,
      open: decimal(gap),
      close: decimal(gap),
      high: decimal(gap),
      low: decimal(gap),
    };
    const next = runSpecialistV5(mutated, candidate);
    expect(next.report.trades.some((t) => t.index === i && t.side === 'SELL')).toBe(false);
    const exit = next.report.trades.find((t) => t.index === i + 1 && t.side === 'SELL');
    expect(exit?.reason).toContain('STOP');
    expect(new D(exit!.price).lte(new D(gap).mul('0.9995'))).toBe(true);
    for (let j = 1; j < r.report.decisions.length; j++) {
      const x = r.report.decisions[j - 1]!,
        y = r.report.decisions[j]!;
      if (x.stop && y.stop && !r.report.trades.some((t) => t.index === j && t.side === 'BUY'))
        expect(new D(y.stop).gte(x.stop)).toBe(true);
    }
  });
});
