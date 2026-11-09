import { describe, it, expect } from 'vitest';
import { ShortV6CandidateSchema } from '@crypto/contracts';
import type { SpecialistAsset } from '@crypto/contracts';
import { canonicalHash, decimal } from '@crypto/core';
import {
  runDirectionalTest,
  runShortV6Test,
  verifyShortV6Report,
  shortV6Profile,
  shortV6Candidates,
  chooseShortV6,
  searchShortV6,
  specialistV5Baseline,
  analyseShortV6Trades,
  compareShortV6Trades,
  reconcileMarginResearchJournal,
} from '@crypto/backtest';
import { D } from '../packages/backtest/src/spot-math.js';
import { marketHistoryFixture } from './helpers/market-history.js';
function history(asset: SpecialistAsset) {
  const data = marketHistoryFixture(asset);
  data.bars = data.bars.map((b, i) => {
    const price =
      250 - i * (asset === 'SOL' ? 0.2 : 0.02) + (asset === 'SOL' ? 8 : 2) * Math.sin(i / 12);
    return {
      ...b,
      open: decimal(price.toFixed(8)),
      high: decimal((price + 0.8).toFixed(8)),
      low: decimal((price - 0.8).toFixed(8)),
      close: decimal(price.toFixed(8)),
    };
  });
  return data;
}
function parent(asset: SpecialistAsset) {
  return {
    asset,
    strategy: 'V5',
    candidate: {
      ...specialistV5Baseline(asset),
      ...(asset === 'SOL'
        ? { lowVolatilityThreshold: '0.008', lowVolatilityTargetAtr: '4' }
        : { adaptiveLowerAtr: '1.5', adaptiveTargetAtr: '6' }),
    },
  };
}
describe('separate V6 short research', () => {
  it.each(['SOL', 'XRP'] as const)(
    'reproduces every %s V5 fill, decision and ledger with no new rule, in all modes and fee settings',
    (asset) => {
      const data = history(asset),
        p = parent(asset);
      for (const mode of ['LONG_ONLY', 'SHORT_ONLY', 'LONG_SHORT'] as const)
        for (const fee of ['STANDARD', 'ZERO'] as const) {
          const a = runDirectionalTest(data, p, mode, fee),
            b = runShortV6Test(data, p, mode, fee);
          expect(
            b.report.decisions.map((d) =>
              Object.fromEntries(
                Object.entries(d).filter(
                  ([k]) => !['shortSlopeAtr', 'shortDistanceAtr', 'shortTargetAtr'].includes(k),
                ),
              ),
            ),
          ).toEqual(a.report.decisions);
          for (const key of ['trades', 'summary', 'journalHash'] as const)
            expect(b.report[key]).toEqual(a.report[key]);
          expect(b.journal).toEqual(a.journal);
        }
    },
  );
  it('enforces complete distinct registered grids and coin-specific rules without risk overrides', () => {
    expect(shortV6Candidates('SOL')).toHaveLength(25);
    expect(shortV6Candidates('XRP')).toHaveLength(19);
    expect(new Set(shortV6Candidates('SOL').map(canonicalHash)).size).toBe(25);
    expect(
      ShortV6CandidateSchema.safeParse({
        asset: 'XRP',
        kind: 'TUNED',
        minSlopeAtr: '0.75',
        minDistanceAtr: '0',
        maxDistanceAtr: '4',
        targetAtr: '3.5',
      }).success,
    ).toBe(false);
    expect(
      ShortV6CandidateSchema.safeParse({ ...shortV6Candidates('SOL')[1], riskFraction: '1' })
        .success,
    ).toBe(false);
    expect(() => shortV6Profile(parent('SOL'), { asset: 'XRP', kind: 'BASELINE' })).toThrow(
      'parent',
    );
  });
  it('selects on earlier fee-on short-only net without later prices or a changed parent', async () => {
    const data = history('SOL'),
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
    const a = await searchShortV6(data, parent('SOL'), split),
      b = await searchShortV6(changed, parent('SOL'), split);
    expect(a.selected.candidate).toEqual(b.selected.candidate);
    expect(a.trials.map((t) => t.result.report.summary)).toEqual(
      b.trials.map((t) => t.result.report.summary),
    );
    expect(() => chooseShortV6(a.trials.slice(1))).toThrow('grid');
    const unfair = structuredClone(a.trials);
    unfair[0]!.result.report.plan.feeMode = 'ZERO';
    expect(() => chooseShortV6(unfair)).toThrow('fee-on');
    const changedParent = structuredClone(a.trials);
    changedParent[0]!.result.report.plan.profile.candidate!.targetAtr = '6';
    expect(() => chooseShortV6(changedParent)).toThrow('grid');
    const tooFew = structuredClone(a.trials);
    for (const t of tooFew) t.result.report.summary.closedTrades = 1;
    expect(() => chooseShortV6(tooFew)).toThrow('two-trade minimum');
    const unsafe = structuredClone(a.trials);
    for (const t of unsafe) t.result.report.summary.maxDrawdown = decimal('.03'.replace('.', '0.'));
    expect(() => chooseShortV6(unsafe)).toThrow('drawdown');
    expect(a.selected.result.report.window.toIndex).toBe(split);
  }, 30000);
  it.each(['SOL', 'XRP'] as const)(
    'applies %s short gates and targets while leaving every long-only outcome unchanged',
    (asset) => {
      const data = history(asset),
        p = parent(asset),
        rules =
          asset === 'SOL'
            ? {
                asset,
                kind: 'TUNED',
                minSlopeAtr: '0.75',
                minDistanceAtr: '0',
                maxDistanceAtr: null,
                targetAtr: '2.5',
              }
            : {
                asset,
                kind: 'TUNED',
                minSlopeAtr: '0',
                minDistanceAtr: '0.75',
                maxDistanceAtr: '4',
                targetAtr: '3.5',
              },
        profile = shortV6Profile(p, rules),
        r = runShortV6Test(data, profile, 'SHORT_ONLY');
      const entries = r.report.trades.filter((t) => t.kind === 'OPEN');
      expect(entries.length).toBeGreaterThan(0);
      for (const t of entries) {
        const s = r.report.decisions[t.index - 1]!;
        expect(s.action).toBe('SHORT');
        expect(s.shortGate).toBe('PASS');
        if (asset === 'SOL') expect(new D(s.shortSlopeAtr!).gte('.75')).toBe(true);
        else {
          expect(new D(s.shortDistanceAtr!).gte('.75')).toBe(true);
          expect(new D(s.shortDistanceAtr!).lte(4)).toBe(true);
        }
        expect(new D(t.price).minus(t.target).gte(new D(s.atr!).mul(rules.targetAtr))).toBe(true);
      }
      for (const fee of ['STANDARD', 'ZERO'] as const)
        expect(runShortV6Test(data, profile, 'LONG_ONLY', fee).report.summary).toEqual(
          runShortV6Test(data, p, 'LONG_ONLY', fee).report.summary,
        );
      const free = runShortV6Test(data, profile, 'SHORT_ONLY', 'ZERO');
      expect(free.report.summary.fees).toBe('0');
      expect(new D(free.report.summary.financing).gt(0)).toBe(true);
      expect(() => reconcileMarginResearchJournal(r.journal)).not.toThrow();
    },
  );
  it('resets later-slice capital, never fills pre-window trades, and reconciles diagnosis and trade changes', () => {
    const data = history('SOL'),
      p = parent('SOL'),
      profile = shortV6Profile(p, {
        asset: 'SOL',
        kind: 'TUNED',
        minSlopeAtr: '0.75',
        minDistanceAtr: '0',
        maxDistanceAtr: null,
        targetAtr: '2.5',
      }),
      window = runShortV6Test(data, profile, 'SHORT_ONLY', 'STANDARD', {
        fromIndex: 400,
        toIndex: 600,
      });
    expect(
      window.report.decisions
        .slice(0, 400)
        .every((d) => d.action === 'WARMUP' && d.equity === '10000' && d.position === '0'),
    ).toBe(true);
    expect(window.report.trades.every((t) => t.index >= 400)).toBe(true);
    const a = runDirectionalTest(data, p, 'SHORT_ONLY'),
      b = runShortV6Test(data, profile, 'SHORT_ONLY'),
      rows = analyseShortV6Trades(a.report, data),
      changes = compareShortV6Trades(a.report, b.report);
    expect(rows.length).toBe(a.report.summary.closedTrades);
    expect(rows.reduce((v, t) => v.plus(t.net), new D(0)).toFixed()).toBe(
      a.report.summary.short.net,
    );
    expect(changes.reduce((v, t) => v.plus(t.delta), new D(0)).toFixed()).toBe(
      new D(b.report.summary.short.net).minus(a.report.summary.short.net).toFixed(),
    );
    const wrong = structuredClone(data);
    wrong.bars[0]!.volume = decimal('999');
    expect(() => analyseShortV6Trades(a.report, wrong)).toThrow('history mismatch');
    expect(verifyShortV6Report(b.report, data).id).toBe(b.id);
    const bad = structuredClone(b.report);
    bad.summary.netPnl = decimal('999');
    expect(() => verifyShortV6Report(bad, data)).toThrow('mismatch');
  });
  it('applies a short trailing stop only after its trigger close and keeps worse-gap execution', () => {
    const data = history('SOL'),
      profile = shortV6Profile(parent('SOL'), {
        asset: 'SOL',
        kind: 'TUNED',
        minSlopeAtr: '0',
        minDistanceAtr: '0',
        maxDistanceAtr: null,
        targetAtr: '4',
        trailDistanceAtr: '1.5',
      }),
      r = runShortV6Test(data, profile, 'SHORT_ONLY');
    const raised = r.report.decisions.find(
      (d, i) =>
        i > 0 &&
        d.stop &&
        r.report.decisions[i - 1]!.stop &&
        new D(d.stop).lt(r.report.decisions[i - 1]!.stop!) &&
        !r.report.trades.some((t) => t.index === i && t.kind === 'OPEN'),
    );
    expect(raised).toBeDefined();
    const i = raised!.index,
      previous = r.report.decisions[i - 1]!,
      changed = structuredClone(data),
      b = changed.bars[i]!,
      high = D.max(new D(raised!.stop!).plus('.01'), b.open, b.close);
    expect(high.lt(previous.stop!)).toBe(true);
    changed.bars[i] = { ...b, high: decimal(high.toFixed()) };
    const gap = new D(raised!.stop!).plus(2).toFixed();
    changed.bars[i + 1] = {
      ...changed.bars[i + 1]!,
      open: decimal(gap),
      high: decimal(gap),
      low: decimal(gap),
      close: decimal(gap),
    };
    const next = runShortV6Test(changed, profile, 'SHORT_ONLY');
    expect(next.report.trades.some((t) => t.index === i && t.kind === 'CLOSE')).toBe(false);
    const exit = next.report.trades.find((t) => t.index === i + 1 && t.kind === 'CLOSE')!;
    expect(exit.reason).toContain('STOP');
    expect(new D(exit.price).gte(new D(gap).mul('1.0005'))).toBe(true);
  });
});
