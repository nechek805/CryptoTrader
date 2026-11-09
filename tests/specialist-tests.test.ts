import { describe, it, expect } from 'vitest';
import { SpecialistCandidateSchema } from '@crypto/contracts';
import { canonicalHash, decimal } from '@crypto/core';
import {
  runMarketStrategy,
  runSpecialistStrategy,
  verifySpecialistReport,
  specialistBaseline,
  specialistCandidates,
  searchSpecialist,
  chooseSpecialist,
  reconcileSpotJournal,
} from '@crypto/backtest';
import { marketHistoryFixture } from './helpers/market-history.js';
describe('coin-specific v4 research', () => {
  it.each(['SOL', 'XRP'] as const)(
    'preserves all baseline %s decisions, fills, summary and journal for both cost modes',
    (asset) => {
      const data = marketHistoryFixture(asset),
        candidate = specialistBaseline(asset);
      for (const mode of ['STANDARD', 'ZERO'] as const) {
        const legacy = runMarketStrategy(data, candidate.base, mode),
          compat = runSpecialistStrategy(data, candidate, mode);
        for (const key of ['decisions', 'trades', 'summary', 'journalHash'] as const)
          expect(compat.report[key]).toEqual(legacy.report[key]);
        expect(compat.journal).toEqual(legacy.journal);
        expect(verifySpecialistReport(compat.report, data).id).toBe(compat.id);
      }
    },
  );
  it('exposes the entire distinct development grids and rejects cross-coin or risk overrides', () => {
    expect(specialistCandidates('SOL')).toHaveLength(12);
    expect(specialistCandidates('XRP')).toHaveLength(24);
    expect(new Set(specialistCandidates('XRP').map(canonicalHash)).size).toBe(24);
    expect(
      SpecialistCandidateSchema.safeParse({
        ...specialistBaseline('SOL'),
        minSignalRangeAtr: '0.8',
      }).success,
    ).toBe(false);
    expect(
      SpecialistCandidateSchema.safeParse({ ...specialistBaseline('XRP'), base: 'V2' }).success,
    ).toBe(false);
    expect(
      SpecialistCandidateSchema.safeParse({ ...specialistBaseline('SOL'), riskFraction: '1' })
        .success,
    ).toBe(false);
    expect(() =>
      runSpecialistStrategy(marketHistoryFixture('BTC'), specialistBaseline('SOL')),
    ).toThrow('another asset');
  });
  it('never fills using pre-window candles and does not use later prices to choose a development candidate', async () => {
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
    const a = await searchSpecialist(data, 'SOL', split),
      b = await searchSpecialist(changed, 'SOL', split);
    expect(a.selected.candidate).toEqual(b.selected.candidate);
    expect(a.trials.map((t) => t.result.report.summary)).toEqual(
      b.trials.map((t) => t.result.report.summary),
    );
    const window = runSpecialistStrategy(data, a.selected.candidate, 'STANDARD', {
      fromIndex: 400,
      toIndex: 600,
    });
    expect(window.report.trades.every((t) => t.index >= 400)).toBe(true);
    expect(
      window.report.decisions
        .slice(0, 400)
        .every((d) => d.action === 'WARMUP' && d.cash === '10000' && d.position === '0'),
    ).toBe(true);
    expect(() => reconcileSpotJournal(window.journal)).not.toThrow();
    const maximum = a.trials
      .filter((t) => Number(t.result.report.summary.maxDrawdown) <= 0.02)
      .sort(
        (x, y) => Number(y.result.report.summary.netPnl) - Number(x.result.report.summary.netPnl),
      )[0]!;
    expect(a.selected.result.report.summary.netPnl).toBe(maximum.result.report.summary.netPnl);
    expect(() => chooseSpecialist(a.trials.slice(1))).toThrow('grid');
    const unfair = structuredClone(a.trials);
    unfair[0]!.result.report.plan.feeMode = 'ZERO';
    expect(() => chooseSpecialist(unfair)).toThrow('fee-on');
    const unsafe = structuredClone(a.trials);
    for (const trial of unsafe) trial.result.report.summary.maxDrawdown = decimal('0.03');
    expect(() => chooseSpecialist(unsafe)).toThrow('drawdown ceiling');
  }, 30000);
  it('enforces the XRP impulse filter, keeps fees and risk accounting explicit, and detects changed reports', () => {
    const data = marketHistoryFixture('XRP'),
      candidate = SpecialistCandidateSchema.parse({
        ...specialistBaseline('XRP'),
        minSignalRangeAtr: '1.25',
        targetAtr: '3.5',
      }),
      r = runSpecialistStrategy(data, candidate);
    expect(r.report.decisions.some((d) => d.entryGate === 'QUIET_BLOCK')).toBe(true);
    expect(r.report.plan.candidate.minSignalRangeAtr).toBe('1.25');
    expect(r.report.plan.reference.riskFraction).toBe('0.0025');
    expect(r.report.plan.reference.maxAllocation).toBe('0.1');
    const bad = structuredClone(r.report);
    bad.summary.netPnl = decimal('999');
    expect(() => verifySpecialistReport(bad, data)).toThrow('mismatch');
  });
});
