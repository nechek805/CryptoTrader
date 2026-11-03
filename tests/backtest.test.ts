import { mkdtemp, readFile, writeFile, readdir, rm, rename } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { BacktestManifestSchema, utcNanoseconds } from '@crypto/contracts';
import { canonicalHash, decimal, fromEpoch, addDecimal } from '@crypto/core';
import { byteHash } from '@crypto/connectors';
import {
  backtestFixture,
  runBacktest,
  validateBacktestReport,
  writeBacktest,
  verifyBacktest,
  backtestMarkdown,
  createNoTradeControl,
} from '@crypto/backtest';
import type { StrategyFactory } from '@crypto/backtest';
import { createDomainFixtures } from './fixtures/domain.js';
const at = (s: number) => fromEpoch(1767225600n + BigInt(s), 'seconds'),
  dirs: string[] = [];
function setup() {
  const f = structuredClone(backtestFixture());
  f.scenarios = [];
  return f;
}
type Fixture = ReturnType<typeof setup>;
const refresh = (f: Fixture) => {
  f.inputHash = canonicalHash(f.input);
  return f;
};
const run = (f = setup(), factory?: StrategyFactory) => runBacktest(f, 'synthetic:test', factory);
const strategy = (a: ReturnType<typeof run>, i = 0) => a.cases[i]!.outcomes[0]!;
function hold() {
  const f = setup();
  f.strategy.id = 'control:buy-and-hold';
  f.strategy.config = {};
  return f;
}
async function temp() {
  const root = await mkdtemp(join(tmpdir(), 'crypto-backtest-'));
  dirs.push(root);
  return root;
}
afterEach(async () => {
  for (const root of dirs.splice(0)) {
    if (
      dirname(resolve(root)) !== resolve(tmpdir()) ||
      !basename(root).startsWith('crypto-backtest-')
    )
      throw new Error('Unsafe cleanup');
    await rm(root, { recursive: true, force: true });
  }
});

describe('backtest research controls and performance contracts', () => {
  it('retains an intentionally unprofitable strategy with hand-calculated gross/net results', () => {
    const a = run(),
      o = strategy(a);
    expect(o.metrics).toMatchObject({
      initialEquity: '1000',
      terminalEquity: '959.8',
      grossPnl: '-40',
      netPnl: '-40.2',
      grossReturn: '-0.04',
      netReturn: '-0.0402',
      fees: '0.2',
      maxDrawdownFraction: '0.0402',
      turnoverNotional: '200',
      turnoverFraction: '0.2',
      fillCount: 2,
      closedLotCount: 1,
    });
    expect(o.trades[0]).toMatchObject({
      quantity: '1',
      entryPrice: '120',
      exitPrice: '80',
      entryFees: '0.12',
      exitFees: '0.08',
      grossPnl: '-40',
      netPnl: '-40.2',
    });
    expect(o.replay.candidates.some((c) => c.side === 'HOLD')).toBe(true);
  });
  it('compares independent cash and buy-and-hold under identical execution assumptions', () => {
    const a = run(),
      out = a.cases[0]!.outcomes;
    expect(out.map((o) => o.role)).toEqual(['STRATEGY', 'CASH', 'BUY_AND_HOLD']);
    expect(out[1]!.metrics).toMatchObject({
      terminalEquity: '1000',
      netReturn: '0',
      fees: '0',
      turnoverNotional: '0',
      timeInMarketFraction: '0',
    });
    expect(out[2]!.metrics).toMatchObject({
      terminalEquity: '969.88',
      grossPnl: '-30',
      netPnl: '-30.12',
      fees: '0.12',
      closedLotCount: 0,
    });
    for (const o of out) {
      expect(o.simulation.request).toEqual(a.cases[0]!.assumptions.policy);
      expect(o.simulation.input.bars).toEqual(out[0]!.simulation.input.bars);
      expect(o.metrics.initialEquity).toBe('1000');
    }
  });
  it('keeps gross identical and net nonincreasing when higher fees leave execution unchanged', () => {
    const f = setup();
    f.scenarios = [
      {
        id: 'FEE',
        overrides: { makerRate: decimal('0.002'), takerRate: decimal('0.002') },
        omittedBarIds: [],
      },
    ];
    const a = run(f);
    expect(a.cases[1]!.feeCheck).toBe('IDENTICAL_GROSS_NET_NONINCREASING');
    expect(strategy(a, 1).fillFingerprint).toBe(strategy(a).fillFingerprint);
    expect(strategy(a, 1).metrics.grossPnl).toBe('-40');
    expect(strategy(a, 1).metrics.netPnl).toBe('-40.4');
  });
  it('satisfies fee invariance over a seeded range of nonnegative fee rates', () => {
    fc.assert(
      fc.property(fc.integer({ min: 10, max: 50 }), (n) => {
        const f = setup(),
          rate = decimal(`0.00${String(n).padStart(2, '0')}`);
        f.scenarios = [
          { id: 'FEE', overrides: { makerRate: rate, takerRate: rate }, omittedBarIds: [] },
        ];
        const a = run(f);
        expect(strategy(a, 1).metrics.grossPnl).toBe(strategy(a).metrics.grossPnl);
        expect(Number(strategy(a, 1).metrics.netPnl)).toBeLessThanOrEqual(
          Number(strategy(a).metrics.netPnl),
        );
      }),
      { numRuns: 8, seed: 42 },
    );
  }, 30000);
  it('does not attribute changed execution to an identical-trade fee effect', () => {
    const f = setup();
    f.assumptions.policy.initialBalances[0]!.amount = decimal('200.3');
    f.scenarios = [
      {
        id: 'FEE',
        overrides: { makerRate: decimal('0.002'), takerRate: decimal('0.002') },
        omittedBarIds: [],
      },
    ];
    const a = run(f);
    expect(a.cases[1]!.feeCheck).toBe('CHANGED_EXECUTION_OR_UNKNOWN_MARKS');
    expect(strategy(a).metrics.fillCount).toBe(2);
    expect(strategy(a, 1).metrics.fillCount).toBe(0);
    expect(strategy(a, 1).metrics.netPnl).toBe('0');
  });
  it('runs the fee, spread, slippage, latency and missing-candle scenario matrix', () => {
    const a = run(backtestFixture());
    expect(a.cases.map((c) => c.id)).toEqual([
      'BASE',
      'HIGH_FEES',
      'HIGH_SLIPPAGE',
      'WIDE_SPREAD',
      'LATENCY',
      'MISSING_CANDLE',
    ]);
    expect(strategy(a, 2).metrics.netPnl).toBe('-40.60008');
    expect(strategy(a, 3).metrics.netPnl).toBe('-40.60008');
    expect(strategy(a, 4).metrics.rejectedOrders).toBe(1);
    expect(strategy(a, 4).metrics.fillCount).toBe(1);
    expect(a.cases[5]!.missingCloseTimes).toEqual([at(180)]);
    expect(a.cases[5]!.omittedBarIds).toEqual(['synthetic:backtest:bar:3']);
    expect(a.cases[5]!.effectiveInputHash).not.toBe(a.cases[0]!.effectiveInputHash);
  }, 30000);
  it('records distinct versioned assumptions and retains the original frozen input', () => {
    const f = backtestFixture(),
      before = canonicalHash(f.input),
      a = run(f);
    expect(canonicalHash(f.input)).toBe(before);
    expect(a.manifest.inputHash).toBe(before);
    for (const c of a.cases) {
      expect(c.assumptionsHash).toBe(canonicalHash(c.assumptions));
      expect(c.assumptions.schemaVersion).toBe('execution-assumptions.v1');
    }
    expect(a.cases[1]!.assumptionsHash).not.toBe(a.cases[0]!.assumptionsHash);
  }, 30000);
  it('marks only source observations available at each equity cutoff', () => {
    const a = run();
    for (const o of a.cases[0]!.outcomes)
      for (const p of o.equity) {
        if (p.markAvailableAt !== null) expect(p.markAvailableAt <= p.at).toBe(true);
        if (p.markBarId !== null)
          expect(
            o.simulation.input.bars.some(
              (b) => b.id === p.markBarId && b.availableAt === p.markAvailableAt,
            ),
          ).toBe(true);
      }
    expect(strategy(a).equity.find((p) => p.at === at(60))!.quantity).toBe('0');
    expect(strategy(a).equity.find((p) => p.at === at(120))!.quantity).toBe('1');
  });
  it('reports stale/missing equity as unknown without zero prices or invented drawdown', () => {
    const f = hold();
    f.input.replay.bars = f.input.replay.bars.slice(0, 4);
    refresh(f);
    const o = strategy(run(f));
    expect(o.metrics.terminalEquity).toBeNull();
    expect(o.metrics.netPnl).toBeNull();
    expect(o.metrics.grossReturn).toBeNull();
    expect(o.metrics.maxDrawdownFraction).toBeNull();
    expect(o.metrics.maxExposureFraction).toBeNull();
    expect(o.equity.at(-1)!.quantity).toBe('1');
    expect(o.equity.at(-1)!.mark).toBeNull();
  });
  it('retains known terminal cash while disclosing unknown intermediate equity under gaps', () => {
    const f = setup();
    f.scenarios = [{ id: 'GAP', overrides: {}, omittedBarIds: ['synthetic:backtest:bar:3'] }];
    const o = strategy(run(f), 1);
    expect(o.metrics.netPnl).toBe('-30.21');
    expect(o.metrics.unknownEquityPoints).toBeGreaterThan(0);
    expect(o.metrics.maxDrawdownFraction).toBeNull();
  });
  it('honors the exact freshness boundary down to a nanosecond', () => {
    const f = hold();
    f.input.replay.bars.pop();
    refresh(f);
    f.assumptions.policy.endAt = at(360);
    expect(strategy(run(f)).metrics.terminalEquity).toBe('969.88');
    f.assumptions.policy.endAt = fromEpoch(utcNanoseconds(at(360)) + 1n, 'nanoseconds');
    expect(strategy(run(f)).metrics.terminalEquity).toBeNull();
  });
  it('does not use a candle arriving at the excluded run end for the final mark', () => {
    const f = hold(),
      b = f.input.replay.bars.at(-1)!;
    Object.assign(b, {
      availableAt: f.assumptions.policy.endAt,
      open: decimal('999'),
      high: decimal('999'),
      low: decimal('999'),
      close: decimal('999'),
    });
    b.provenance.capturedAt = b.availableAt!;
    refresh(f);
    expect(strategy(run(f)).metrics.terminalEquity).toBeNull();
    f.maxMarkAgeMs = 120000;
    const o = strategy(run(f));
    expect(o.metrics.terminalEquity).toBe('969.88');
    expect(o.equity.at(-1)!.markBarId).toBe('synthetic:backtest:bar:5');
  });
  it('retains original as-of marks when a later source correction becomes available', () => {
    const f = hold(),
      b = structuredClone(f.input.replay.bars[1]!);
    Object.assign(b, {
      id: 'synthetic:correction',
      availableAt: at(150),
      open: decimal('130'),
      high: decimal('130'),
      low: decimal('130'),
      close: decimal('130'),
    });
    b.provenance.capturedAt = at(150);
    f.input.replay.bars.push(b);
    refresh(f);
    const o = strategy(run(f));
    expect(o.equity.find((p) => p.at === at(120))!.mark).toBe('120');
    expect(o.equity.find((p) => p.at === at(150))!.mark).toBe('130');
    expect(o.simulation.fills).toHaveLength(1);
  });
  it('does not liquidate a delisted holding at a fabricated price', () => {
    const f = hold();
    f.input.market.instruments.find((m) => m.instrumentKey === 'cross:SPOT:BTC')!.delistedAt =
      at(350);
    refresh(f);
    const o = strategy(run(f));
    expect(o.metrics.netPnl).toBeNull();
    expect(o.equity.at(-1)!.quantity).toBe('1');
    expect(o.simulation.fills).toHaveLength(1);
  });
  it('leaves a renamed holding unpriced rather than inventing a wallet conversion', () => {
    const f = hold(),
      m = f.input.market.instruments.find((m) => m.instrumentKey === 'cross:SPOT:BTC')!;
    f.input.market.instruments.push({
      ...m,
      id: 'synthetic:rename:2',
      revision: 2,
      effectiveFrom: at(300),
      observedAt: at(300),
      availableAt: at(300),
      baseCode: 'XBT',
      providerSymbol: 'XBTUSDT',
    });
    refresh(f);
    expect(strategy(run(f)).metrics.terminalEquity).toBeNull();
  });
  it('allocates entry fees exactly across partially closed FIFO lots', () => {
    const f = setup();
    f.input.replay.bars[3]!.volume = decimal('5');
    f.input.replay.bars[4]!.volume = decimal('5');
    refresh(f);
    const o = strategy(run(f));
    expect(o.metrics.fillCount).toBe(3);
    expect(o.trades).toHaveLength(2);
    expect(o.trades.map((t) => t.entryFees)).toEqual(['0.06', '0.06']);
    expect(o.trades.map((t) => t.exitFees)).toEqual(['0.04', '0.045']);
    expect(o.trades.reduce((s, t) => addDecimal(s, t.netPnl), decimal('0'))).toBe(o.metrics.netPnl);
    expect(o.metrics.netPnl).toBe('-35.205');
  });
  it('reports exact time positioned and gross two-way turnover without annualizing short fixtures', () => {
    const o = strategy(run());
    expect(o.metrics.timeInMarketFraction).toBe('0.33240997229916897506925207756232687');
    expect(o.metrics.turnoverFraction).toBe('0.2');
    expect('annualizedReturn' in o.metrics).toBe(false);
    expect(o.metrics.maxExposureFraction).not.toBe('1');
  });
  it('discloses skipped attempts, rejected orders and unknown market depth', () => {
    const a = run(backtestFixture());
    expect(strategy(a).skips).toContainEqual({
      reason: 'ORDER_NOT_ACTIVE_FOR_FULL_CANDLE',
      count: 2,
    });
    expect(strategy(a, 4).skips).toContainEqual({
      reason: 'INSUFFICIENT_UNRESERVED_BALANCE',
      count: 1,
    });
    for (const c of a.cases) for (const o of c.outcomes) expect(o.unknownMarketDepth).toBe(true);
    expect(backtestMarkdown(run())).toContain('Market depth and maker queues are UNKNOWN');
  }, 30000);
  it('rejects deliberate future reads before any report bundle is published', async () => {
    const f = setup();
    f.strategy = {
      id: 'synthetic:future-leak',
      version: '1',
      config: {},
      requiredFields: ['CLOSED_OHLCV'],
    };
    expect(() => run(f)).toThrow('REPLAY_FUTURE_QUERY');
    const root = await temp();
    await expect(writeBacktest(f, root, 'synthetic:test')).rejects.toThrow('REPLAY_FUTURE_QUERY');
    expect(await readdir(root)).toEqual([]);
  });
  it('preserves sticky future access failures from trusted custom strategies too', () => {
    const f = setup();
    f.strategy.id = 'synthetic:probe';
    f.strategy.config = {};
    const factory: StrategyFactory = () => ({
      ...createNoTradeControl(),
      descriptor: { id: f.strategy.id, version: '1', portfolio: 'BASELINE', config: {} },
      onEvent: (_e, c, s) => {
        try {
          c.bar({ id: 'synthetic:backtest:bar:6', asOf: c.clock.now() });
        } catch {
          /* cannot bypass the context gate */
        }
        return { state: s, candidates: [] };
      },
    });
    expect(() => run(f, factory)).toThrow('REPLAY_DATA_NOT_VISIBLE');
  });
  it('rejects required depth/funding/news fields instead of supplying zero proxies', () => {
    for (const field of ['ORDER_BOOK_DEPTH', 'FUNDING_RATE', 'TIMED_NEWS'] as const) {
      const f = setup();
      f.strategy.requiredFields = [field];
      expect(() => run(f)).toThrow(`UNAVAILABLE_REQUIRED_FIELD:${field}`);
    }
    const g = setup();
    g.input.replay.bars = [];
    refresh(g);
    expect(() => run(g)).toThrow('UNAVAILABLE_REQUIRED_FIELD:CLOSED_OHLCV');
  });
  it('does not satisfy a timed-news requirement with an excluded end-boundary document', () => {
    const f = setup(),
      n = structuredClone(createDomainFixtures().newsDocument),
      end = f.assumptions.policy.endAt;
    Object.assign(n, { firstObservedAt: end, availableAt: end });
    n.provenance.capturedAt = end;
    f.input.replay.news = [n];
    f.strategy.requiredFields = ['TIMED_NEWS'];
    refresh(f);
    expect(() => run(f)).toThrow('UNAVAILABLE_REQUIRED_FIELD:TIMED_NEWS');
  });
  it('rejects a scenario with no eligible source candles rather than reporting fake cash performance', () => {
    const f = setup();
    f.scenarios = [
      { id: 'NO_DATA', overrides: {}, omittedBarIds: f.input.replay.bars.map((b) => b.id) },
    ];
    expect(() => run(f)).toThrow('UNAVAILABLE_REQUIRED_FIELD:CLOSED_OHLCV');
  });
  it('rejects corrupted input hashes and undeclared omission identities', () => {
    const f = setup();
    f.input.replay.bars[0]!.volume = decimal('11');
    expect(() => run(f)).toThrow('input hash');
    const g = setup();
    g.scenarios = [{ id: 'GAP', overrides: {}, omittedBarIds: ['missing'] }];
    expect(() => run(g)).toThrow('Unknown omitted');
  });
  it('requires predeclared, bounded, single-asset cash/spot comparison assumptions', () => {
    const f = setup();
    for (const edit of [
      (m: Fixture) => {
        m.assumptions.declaredAt = at(1);
      },
      (m: Fixture) => {
        m.assumptions.policy.portfolios.push('NEWS_ONLY');
      },
      (m: Fixture) => {
        m.assumptions.policy.initialBalances[1]!.amount = decimal('1');
      },
      (m: Fixture) => {
        m.strategy.requiredFields = ['CLOSED_OHLCV', 'CLOSED_OHLCV'];
      },
      (m: Fixture) => {
        m.scenarios = [{ id: 'BASE', overrides: {}, omittedBarIds: [] }];
      },
    ]) {
      const bad = structuredClone(f);
      edit(bad);
      expect(BacktestManifestSchema.safeParse(bad).success).toBe(false);
    }
    expect(BacktestManifestSchema.safeParse({ ...f, execute: true }).success).toBe(false);
    f.calendar.firstCloseAt = at(120);
    expect(() => run(f)).toThrow('calendar starts too late');
  });
  it('rejects excessive scenario and calendar work instead of running unbounded reports', () => {
    const f = backtestFixture(),
      b = f.input.replay.bars[0]!;
    f.scenarios.push({ id: 'EXTRA', overrides: {}, omittedBarIds: [] });
    f.input.replay.bars = Array.from({ length: 600 }, (_, i) => ({
      ...b,
      id: `synthetic:budget:${i}`,
    }));
    refresh(f);
    expect(() => run(f)).toThrow('scenario work budget');
    const g = setup();
    g.assumptions.policy.endAt = at(120061);
    g.assumptions.policy.generatedAt = at(120062);
    expect(() => run(g)).toThrow('calendar work budget');
  });
  it('rejects unknown strategies, mismatched descriptors and real-input diagnostic misuse', () => {
    const f = setup();
    f.strategy.id = 'unregistered';
    expect(() => run(f)).toThrow('Unregistered');
    expect(() => run(f, createNoTradeControl)).toThrow('descriptor mismatch');
    const wrongPortfolio: StrategyFactory = () => ({
      ...createNoTradeControl(),
      descriptor: {
        id: f.strategy.id,
        version: '1',
        portfolio: 'NEWS_ONLY',
        config: f.strategy.config,
      },
    });
    expect(() => run(f, wrongPortfolio)).toThrow('descriptor mismatch');
    const g = setup();
    g.input.market.sources[0]!.origin = 'PUBLIC_READ_ONLY';
    g.input.market.sources[0]!.license = 'UNDETERMINED';
    refresh(g);
    expect(() => run(g)).toThrow('synthetic evidence');
  });
  it('supports the neutral control without implicitly submitting trades', () => {
    const f = setup();
    f.strategy.id = 'control:no-trade';
    f.strategy.config = {};
    const o = strategy(run(f));
    expect(o.metrics.netPnl).toBe('0');
    expect(o.simulation.orders).toEqual([]);
    expect(o.replay.candidates.every((c) => c.side === 'HOLD')).toBe(true);
  });
  it('produces deterministic frozen reports and separate code/config identities', () => {
    const f = setup(),
      a = run(f);
    expect(canonicalHash(a)).toBe(canonicalHash(run(f)));
    expect(Object.isFrozen(a.cases[0]!.outcomes[0]!.equity)).toBe(true);
    expect(runBacktest(f, 'synthetic:other').manifestHash).toBe(a.manifestHash);
    expect(runBacktest(f, 'synthetic:other').runId).not.toBe(a.runId);
  });
  it('rejects modified metrics, benchmark results, source traces and gross/net identities', () => {
    const a = run();
    for (const edit of [
      (b: typeof a) => {
        strategy(b).metrics.grossPnl = decimal('100');
      },
      (b: typeof a) => {
        b.cases[0]!.outcomes[1]!.metrics.netPnl = decimal('100');
      },
      (b: typeof a) => {
        strategy(b).trades[0]!.entryFees = decimal('0');
      },
      (b: typeof a) => {
        strategy(b).equity[0]!.cash = decimal('999');
      },
    ]) {
      const b = structuredClone(a);
      edit(b);
      expect(() => validateBacktestReport(b)).toThrow('integrity');
    }
  });
  it('writes JSON/Markdown/manifest together and reproduces all bytes in independent roots', async () => {
    const f = setup(),
      root = await temp(),
      other = await temp(),
      a = await writeBacktest(f, root, 'synthetic:test'),
      b = await writeBacktest(f, other, 'synthetic:test'),
      again = await writeBacktest(f, root, 'synthetic:test');
    expect(a.hash).toBe(b.hash);
    expect(again.hash).toBe(a.hash);
    expect((await verifyBacktest(a.directory)).report).toEqual(a.report);
    for (const name of ['report.json', 'report.md', 'manifest.json', 'bundle.json'])
      expect(await readFile(join(a.directory, name))).toEqual(
        await readFile(join(b.directory, name)),
      );
    expect(await readdir(root)).toEqual([basename(a.directory)]);
    expect(await readFile(join(a.directory, 'report.md'), 'utf8')).toContain(
      '−40'.replace('−', '-'),
    );
  }, 30000);
  it('refuses corrupt existing bundles without replacing evidence or leaving staging folders', async () => {
    const f = setup(),
      root = await temp(),
      a = await writeBacktest(f, root, 'synthetic:test');
    await writeFile(join(a.directory, 'report.md'), 'corrupt');
    await expect(verifyBacktest(a.directory)).rejects.toThrow('checksum');
    await expect(writeBacktest(f, root, 'synthetic:test')).rejects.toThrow();
    expect(await readFile(join(a.directory, 'report.md'), 'utf8')).toBe('corrupt');
    expect(await readdir(root)).toEqual([basename(a.directory)]);
  }, 30000);
  it('refuses non-repeatable custom strategy state before publishing files', async () => {
    const f = setup();
    f.strategy.id = 'synthetic:non-repeatable';
    f.strategy.config = {};
    let count = 0;
    const factory: StrategyFactory = () => ({
        ...createNoTradeControl(),
        descriptor: { id: f.strategy.id, version: '1', portfolio: 'BASELINE', config: {} },
        initialState: () => ({ events: 0, run: ++count }),
      }),
      root = await temp();
    await expect(writeBacktest(f, root, 'synthetic:test', factory)).rejects.toThrow('integrity');
    expect(await readdir(root)).toEqual([]);
  }, 30000);
  it('rejects altered Markdown even after its byte checksum is recomputed', async () => {
    const f = setup(),
      root = await temp(),
      a = await writeBacktest(f, root, 'synthetic:test'),
      bad = 'Fabricated positive performance';
    await writeFile(join(a.directory, 'report.md'), bad);
    const bundle = structuredClone(a.metadata);
    bundle.files.reportMarkdown = byteHash(bad);
    await writeFile(join(a.directory, 'bundle.json'), JSON.stringify(bundle));
    await expect(verifyBacktest(a.directory)).rejects.toThrow('integrity');
  }, 30000);
  it('checks the content-addressed directory identity', async () => {
    const f = setup(),
      root = await temp(),
      a = await writeBacktest(f, root, 'synthetic:test'),
      wrong = join(root, 'wrong');
    expect(dirname(a.directory)).toBe(root);
    expect(dirname(wrong)).toBe(root);
    await rename(a.directory, wrong);
    await expect(verifyBacktest(wrong)).rejects.toThrow('integrity');
  }, 30000);
  it('keeps negative results, model limitations and interfaces in the Markdown handoff', () => {
    const text = backtestMarkdown(run());
    for (const value of [
      '-40.2',
      'BUY_AND_HOLD',
      'Cash and buy-and-hold',
      'equity',
      'FIFO',
      'Strategy',
      'ExecutionSimulator',
      'BacktestReport',
      'not guaranteed historical fills',
    ])
      expect(text).toContain(value);
  });
  it('rejects secret/live CLI flags and future leakage without printing a report', async () => {
    const root = await temp(),
      f = setup();
    f.strategy = {
      id: 'synthetic:future-leak',
      version: '1',
      config: {},
      requiredFields: ['CLOSED_OHLCV'],
    };
    const manifest = join(root, 'leak.json');
    await writeFile(manifest, JSON.stringify(f));
    for (const args of [
      ['fixture', '--execute', 'true'],
      ['run', '--manifest', 'missing', '--private-key', 'forbidden'],
      ['run', '--manifest', manifest, '--out', join(root, 'out')],
    ]) {
      const p = spawnSync(
        process.execPath,
        ['--import', 'tsx', 'apps/cli/src/backtest.ts', ...args],
        { cwd: process.cwd(), encoding: 'utf8', timeout: 15000 },
      );
      expect(p.status).toBe(1);
      expect(p.stdout).toBe('');
      expect(p.stderr).not.toContain('forbidden');
    }
    expect(await readdir(root)).toEqual(['leak.json']);
  }, 30000);
});
