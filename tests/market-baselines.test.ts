import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MarketStrategyConfigSchema,
  MarketStrategyStateSchema,
  MarketDecisionSchema,
  MarketBaselineManifestSchema,
  MarketBarSchema,
} from '@crypto/contracts';
import { canonicalHash, canonicalJson, decimal, fromEpoch } from '@crypto/core';
import { MarketSignalProvider, createMarketStrategy, sizeMarketTarget } from '@crypto/strategies';
import {
  executeReplay,
  marketBaselineFixture,
  marketSource,
  marketFixtureSignals,
  runMarketBaseline,
  validateMarketBaseline,
  writeMarketBaseline,
  verifyMarketBaseline,
} from '@crypto/backtest';
import { createDomainFixtures } from './fixtures/domain.js';
const at = (s: number) => fromEpoch(1767225600n + BigInt(s), 'seconds');
type Manifest = ReturnType<typeof marketBaselineFixture>;
function bind(m: Manifest) {
  m.backtest.inputHash = canonicalHash(m.backtest.input);
  const p = new MarketSignalProvider(m.provider, marketSource(m));
  m.backtest.strategy = {
    ...m.backtest.strategy,
    id: p.descriptor.id,
    config: p.descriptor.config,
  };
  return MarketBaselineManifestSchema.parse(m);
}
function replay(m = marketBaselineFixture()) {
  const p = m.backtest.assumptions.policy;
  return executeReplay(
    m.backtest.input.replay,
    {
      schemaVersion: 'replay-request.v1',
      startAt: p.startAt,
      endAt: p.endAt,
      generatedAt: p.generatedAt,
      symbols: [m.backtest.series.instrumentId],
      randomSeed: p.randomSeed,
      snapshotEvery: 1,
      maxQueriesPerEvent: 20,
    },
    'synthetic:test',
    createMarketStrategy(m.provider, marketSource(m)),
  );
}
const decisions = (r: ReturnType<typeof replay>) =>
  r.snapshots
    .map((s) => MarketStrategyStateSchema.parse(s.state).lastDecision)
    .filter((d): d is NonNullable<typeof d> => d !== null);
const dirs: string[] = [];
async function temp() {
  const d = await mkdtemp(join(tmpdir(), 'crypto-market-baselines-'));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  for (const d of dirs.splice(0)) {
    if (
      dirname(resolve(d)) !== resolve(tmpdir()) ||
      !basename(d).startsWith('crypto-market-baselines-')
    )
      throw new Error('Unsafe cleanup');
    await rm(d, { recursive: true, force: true });
  }
});
describe('market-only interpretable providers', () => {
  it.each(['BTC', 'ETH', 'SOL'] as const)('%s SMA trend enters once after warm-up', (asset) => {
    const r = replay(marketBaselineFixture(asset));
    expect(r.candidates.filter((c) => c.side === 'LONG')).toHaveLength(1);
    expect(r.candidates.filter((c) => c.side === 'SHORT')).toHaveLength(0);
    expect(r.candidates.find((c) => c.side === 'LONG')!.decisionAt).toBe(at(240));
    expect(decisions(r)[0]!.reason).toBe('MISSING_FEATURE');
  });
  it('EMA uses the declared seeded history and does not repeat entries', () => {
    const m = marketBaselineFixture();
    m.provider = MarketStrategyConfigSchema.parse({ ...m.provider, average: 'EMA' });
    const r = replay(bind(m));
    expect(r.candidates.filter((c) => c.side === 'LONG')).toHaveLength(1);
    expect(
      decisions(r)
        .at(-1)!
        .features.map((f) => f.value),
    ).toEqual(['122.5', '121.5']);
  });
  it('prior-window breakout enters on a strict new high', () => {
    const r = replay(marketBaselineFixture('BTC', 'TREND', 'BREAKOUT'));
    expect(r.candidates.find((c) => c.side === 'LONG')!.decisionAt).toBe(at(300));
    expect(r.candidates.filter((c) => c.side === 'LONG')).toHaveLength(1);
    expect(decisions(r)[4]!.features[0]!.value).toBe('103');
  });
  it('z-score reversion buys a negative excursion and exits its declared band', () => {
    const ds = decisions(replay(marketBaselineFixture('BTC', 'WHIPSAW', 'ZSCORE_REVERSION')));
    expect(ds.some((d) => d.action === 'ENTER_LONG')).toBe(true);
    expect(ds.some((d) => d.action === 'EXIT_LONG')).toBe(true);
    for (const d of ds.filter((d) => d.action === 'ENTER_LONG'))
      expect(Number(d.features[0]!.value)).toBeLessThanOrEqual(-1.25);
  });
  it('constant prices preserve undefined z-score rather than inventing zero', () => {
    const m = marketBaselineFixture('BTC', 'TREND', 'ZSCORE_REVERSION');
    m.backtest.input.replay.bars = m.backtest.input.replay.bars.map((b) =>
      MarketBarSchema.parse({ ...b, open: '100', high: '100', low: '100', close: '100' }),
    );
    const r = replay(bind(m));
    expect(r.candidates.every((c) => c.side === 'HOLD')).toBe(true);
    expect(decisions(r).at(-1)!.features[0]!.value).toBeNull();
  });
  it('always-neutral cash never enters', () => {
    const r = replay(marketBaselineFixture('BTC', 'REVERSAL', 'CASH'));
    expect(
      r.candidates.every(
        (c) => c.side === 'HOLD' && c.score.status === 'KNOWN' && c.score.value === 0,
      ),
    ).toBe(true);
  });
  it('buy-and-hold enters once and holds through reversals', () => {
    const r = replay(marketBaselineFixture('BTC', 'REVERSAL', 'BUY_AND_HOLD'));
    expect(r.candidates.filter((c) => c.side === 'LONG')).toHaveLength(1);
    expect(r.candidates.some((c) => c.side === 'SHORT')).toBe(false);
  });
  it('symmetric fixtures contain both virtual targets with no financial execution', () => {
    const m = marketBaselineFixture('BTC', 'REVERSAL', 'SYMMETRIC_MA_FIXTURE'),
      r = marketFixtureSignals(m, 'synthetic:test');
    expect(r.execution).toBe('DISABLED');
    expect(decisions(r.replay).map((d) => d.action)).toContain('ENTER_SHORT');
    expect(
      r.replay.candidates.some((c) => c.score.status === 'KNOWN' && c.score.value === -1),
    ).toBe(true);
    expect(() => runMarketBaseline(m, 'test')).toThrow(/signal-only/);
  });
  it('rejects symmetric fixtures over public source metadata', () => {
    const m = marketBaselineFixture('BTC', 'REVERSAL', 'SYMMETRIC_MA_FIXTURE');
    m.backtest.input.market.sources[0]!.origin = 'PUBLIC_READ_ONLY';
    expect(() => new MarketSignalProvider(m.provider, marketSource(m))).toThrow(/synthetic/);
  });
  it('never queries or mutates state for news deliveries', () => {
    const m = marketBaselineFixture(),
      p = new MarketSignalProvider(m.provider, marketSource(m)),
      news = createDomainFixtures().newsDocument;
    const context = new Proxy(
      {},
      {
        get() {
          throw new Error('News must not query context');
        },
      },
    );
    const state = p.initialState();
    const r = p.evaluate(
      { kind: 'NEWS_DOCUMENT', record: news, recordId: news.id } as Parameters<
        typeof p.evaluate
      >[0],
      context as Parameters<typeof p.evaluate>[1],
      state,
    );
    expect(r.decision).toBeNull();
    expect(r.state).toEqual(state);
  });
  it('bounds holding duration and records an explicit exit', () => {
    const m = marketBaselineFixture();
    m.provider = MarketStrategyConfigSchema.parse({ ...m.provider, maxHoldingBars: 2 });
    const ds = decisions(replay(bind(m)));
    expect(ds.find((d) => d.reason === 'MAX_HOLD_EXIT')).toMatchObject({
      action: 'EXIT_LONG',
      closeAt: at(360),
      target: 'FLAT',
    });
  });
  it('waits the configured cooldown before re-entering', () => {
    const m = marketBaselineFixture('BTC', 'WHIPSAW');
    m.provider = MarketStrategyConfigSchema.parse({ ...m.provider, cooldownBars: 3 });
    const ds = decisions(replay(bind(m)));
    expect(ds.filter((d) => d.reason === 'COOLDOWN').length).toBeGreaterThan(2);
    expect(ds.filter((d) => d.action === 'ENTER_LONG').length).toBeLessThan(3);
  });
  it('missing candles trigger an explicit exit and reset warm-up', () => {
    const m = marketBaselineFixture();
    m.backtest.input.replay.bars.splice(5, 1);
    const ds = decisions(replay(bind(m)));
    expect(ds.find((d) => d.closeAt === at(420))).toMatchObject({
      action: 'EXIT_LONG',
      reason: 'MISSING_FEATURE_EXIT',
    });
  });
  it('HOLD missing policy retains target without fabricated values', () => {
    const m = marketBaselineFixture();
    m.provider = MarketStrategyConfigSchema.parse({ ...m.provider, onMissing: 'HOLD' });
    m.backtest.input.replay.bars.splice(5, 1);
    const d = decisions(replay(bind(m))).find((d) => d.closeAt === at(420))!;
    expect(d).toMatchObject({ action: 'HOLD', target: 'LONG', reason: 'MISSING_FEATURE' });
    expect(d.features.some((f) => f.value === null)).toBe(true);
  });
  it('rejects a historical bar known without its precision metadata', () => {
    const m = marketBaselineFixture();
    m.backtest.input.market.instruments[0]!.listedAt = at(180);
    const ds = decisions(replay(bind(m)));
    expect(ds.find((d) => d.closeAt === at(240))!.reason).toBe('HISTORICAL_INPUT_INELIGIBLE');
    expect(ds.find((d) => d.action === 'ENTER_LONG')!.closeAt).toBe(at(420));
  });
  it('metadata cannot be consumed before availability', () => {
    const m = marketBaselineFixture();
    m.backtest.input.market.instruments[0]!.availableAt = at(600);
    const ds = decisions(replay(bind(m)));
    expect(
      ds
        .filter((d) => d.closeAt < at(600))
        .every((d) => d.target === 'FLAT' && d.inputMetadataIds.length === 0),
    ).toBe(true);
  });
  it('low volume cannot open exposure', () => {
    const m = marketBaselineFixture();
    m.provider = MarketStrategyConfigSchema.parse({ ...m.provider, minimumBaseVolume: '1001' });
    expect(replay(bind(m)).candidates.every((c) => c.side === 'HOLD')).toBe(true);
  });
  it('stale receipts cannot open exposure even inside the publication-delay budget', () => {
    const m = marketBaselineFixture();
    m.provider = MarketStrategyConfigSchema.parse({ ...m.provider, staleAfterSeconds: 1 });
    m.backtest.input.replay.bars = m.backtest.input.replay.bars.map((b) =>
      MarketBarSchema.parse({
        ...b,
        availableAt: fromEpoch(BigInt(Date.parse(b.closeAt)) + 2000n, 'milliseconds'),
      }),
    );
    expect(replay(bind(m)).candidates.every((c) => c.side === 'HOLD')).toBe(true);
  });
  it('bad raw precision is excluded from feature eligibility', () => {
    const m = marketBaselineFixture();
    m.backtest.input.replay.bars[2] = MarketBarSchema.parse({
      ...m.backtest.input.replay.bars[2],
      open: '102.001',
      high: '102.001',
      low: '102.001',
      close: '102.001',
    });
    const d = decisions(replay(bind(m))).find((d) => d.closeAt === at(240))!;
    expect(d.action).toBe('HOLD');
    expect(d.reason).toBe('HISTORICAL_INPUT_INELIGIBLE');
  });
  it('late corrections do not create duplicate decisions for consumed closes', () => {
    const m = marketBaselineFixture(),
      b = m.backtest.input.replay.bars[3]!;
    m.backtest.input.replay.bars.push(
      MarketBarSchema.parse({
        ...b,
        id: 'synthetic:late-correction',
        availableAt: at(241),
        qualityFlags: ['SYNTHETIC', 'CORRECTED'],
      }),
    );
    expect(replay(bind(m)).candidates).toHaveLength(24);
  });
  it('future price perturbations do not change earlier feature decisions', () => {
    const a = marketBaselineFixture(),
      b = structuredClone(a);
    b.backtest.input.replay.bars = b.backtest.input.replay.bars.map((bar, i) =>
      i < 12
        ? bar
        : MarketBarSchema.parse({ ...bar, open: '50', high: '50', low: '50', close: '50' }),
    );
    expect(decisions(replay(a)).filter((d) => d.closeAt <= at(720))).toEqual(
      decisions(replay(bind(b))).filter((d) => d.closeAt <= at(720)),
    );
  });
  it('audits contain only known inputs and uncalibrated target codes', () => {
    const r = replay();
    for (const d of decisions(r)) {
      expect(d.maxInputAvailableAt <= d.featureAsOf).toBe(true);
      expect(d.maxInputCloseAt <= d.featureAsOf).toBe(true);
      expect(d.inputBarIds.length).toBeGreaterThan(0);
    }
    expect(r.candidates.every((c) => c.calibration.status === 'MISSING')).toBe(true);
    expect(Object.isFrozen(r)).toBe(true);
  });
  it('invalid periods, bands and hidden sizing inputs fail closed', () => {
    const m = marketBaselineFixture();
    expect(() => MarketStrategyConfigSchema.parse({ ...m.provider, fastPeriod: 5 })).toThrow();
    expect(() => MarketStrategyConfigSchema.parse({ ...m.provider, leverage: '2' })).toThrow();
    expect(() =>
      MarketDecisionSchema.parse({ ...decisions(replay())[0], maxInputAvailableAt: at(1500) }),
    ).toThrow();
  });
});
describe('fixed target sizing and costed backtests', () => {
  const q = {
    schemaVersion: 'market-target-sizing.v1',
    target: 'LONG',
    fixedQuantity: '1',
    heldQuantity: '0.4',
    quantityStep: '0.01',
  };
  it('sizes only the fixed target gap and never adds hidden leverage', () => {
    expect(sizeMarketTarget(q)).toMatchObject({ side: 'BUY', quantity: '0.6' });
    expect(sizeMarketTarget({ ...q, target: 'FLAT' })).toMatchObject({
      side: 'SELL',
      quantity: '0.4',
    });
    expect(sizeMarketTarget({ ...q, heldQuantity: '1' }).side).toBe('NONE');
    expect(() => sizeMarketTarget({ ...q, score: 100 })).toThrow();
    expect(() => sizeMarketTarget({ ...q, fixedQuantity: '1.001' })).toThrow();
  });
  it.each(['BTC', 'ETH', 'SOL'] as const)(
    '%s sideways whipsaw retains costs and negative performance',
    (asset) => {
      const r = runMarketBaseline(marketBaselineFixture(asset, 'WHIPSAW'), 'synthetic:test'),
        o = r.outcomes[0]!;
      expect(Number(o.metrics.netPnl)).toBeLessThan(0);
      expect(Number(o.metrics.fees)).toBeGreaterThan(0);
      expect(Number(o.metrics.netPnl)).toBeLessThan(Number(o.metrics.grossPnl));
      expect(o.metrics.fillCount).toBe(6);
      expect(r.outcomes[1]!.metrics.netReturn).toBe('0');
    },
    20000,
  );
  it('post-receipt execution retains a distinct immutable derived candidate', () => {
    const r = runMarketBaseline(marketBaselineFixture(), 'synthetic:test'),
      o = r.outcomes[0]!,
      orders = o.simulation.input.commands.filter((c) => c.kind === 'SUBMIT');
    expect(orders).toHaveLength(1);
    const c = orders[0]!;
    expect(c.candidate.id).not.toBe(o.replay.candidates.find((s) => s.side === 'LONG')!.id);
    expect(c.candidate.rationaleIds).toContain(
      o.replay.candidates.find((s) => s.side === 'LONG')!.id,
    );
    expect(c.at).toBe('2026-01-01T00:04:00.000000001Z');
    expect(o.simulation.fills[0]!.fill.filledAt).toBe(at(360));
  }, 20000);
  it('cash rejection is retained without retrying every HOLD', () => {
    const m = marketBaselineFixture();
    m.backtest.assumptions.policy.initialBalances[0]!.amount = decimal('1');
    const r = runMarketBaseline(m, 'synthetic:test');
    expect(r.outcomes[0]!.metrics.rejectedOrders).toBe(1);
    expect(
      r.outcomes[0]!.simulation.input.commands.filter((c) => c.kind === 'SUBMIT'),
    ).toHaveLength(1);
    expect(r.sizing[0]!.decisions.some((d) => d.reason === 'NO_RETRY_SAME_TARGET')).toBe(true);
  }, 20000);
  it('pending partial fills block stacking and retain bounded exposure', () => {
    const m = marketBaselineFixture();
    m.backtest.assumptions.policy.participationFraction = decimal('0.0001');
    m.backtest.orderLifetimeSeconds = 600;
    const r = runMarketBaseline(m, 'synthetic:test');
    expect(
      r.outcomes[0]!.simulation.input.commands.filter((c) => c.kind === 'SUBMIT'),
    ).toHaveLength(1);
    expect(r.sizing[0]!.decisions.some((d) => d.reason === 'WAIT_PENDING')).toBe(true);
    expect(r.outcomes[0]!.equity.every((p) => Number(p.quantity) <= 1)).toBe(true);
  }, 20000);
  it('an opposite target cancels a pending entry instead of stacking a sell', () => {
    const m = marketBaselineFixture('BTC', 'WHIPSAW');
    m.backtest.assumptions.policy.participationFraction = decimal('0.0001');
    m.backtest.orderLifetimeSeconds = 600;
    const r = runMarketBaseline(m, 'synthetic:test'),
      commands = r.outcomes[0]!.simulation.input.commands;
    expect(commands.some((c) => c.kind === 'CANCEL')).toBe(true);
    expect(r.outcomes[0]!.equity.every((p) => Number(p.quantity) <= 1)).toBe(true);
    expect(
      r.outcomes[0]!.simulation.orders.some((o) =>
        ['ACCEPTED', 'PARTIALLY_FILLED'].includes(o.order.status),
      ),
    ).toBe(false);
  }, 20000);
  it('higher fees preserve fill paths and gross PnL but reduce net PnL', () => {
    const m = marketBaselineFixture('ETH', 'WHIPSAW'),
      a = runMarketBaseline(m, 'synthetic:test');
    m.backtest.assumptions.policy.takerRate = decimal('0.002');
    const b = runMarketBaseline(m, 'synthetic:test');
    expect(a.outcomes[0]!.fillFingerprint).toBe(b.outcomes[0]!.fillFingerprint);
    expect(a.outcomes[0]!.metrics.grossPnl).toBe(b.outcomes[0]!.metrics.grossPnl);
    expect(Number(b.outcomes[0]!.metrics.netPnl)).toBeLessThan(
      Number(a.outcomes[0]!.metrics.netPnl),
    );
  }, 30000);
  it('equivalent manifests reproduce the entire report bit-for-bit', () => {
    const m = marketBaselineFixture(),
      a = runMarketBaseline(m, 'synthetic:test'),
      b = runMarketBaseline(JSON.parse(canonicalJson(m)), 'synthetic:test');
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(validateMarketBaseline(a)).toEqual(a);
  }, 30000);
  it('fails input tampering, unavailable prices and descriptor drift before reporting', () => {
    const m = marketBaselineFixture();
    m.backtest.input.replay.bars.pop();
    expect(() => runMarketBaseline(m, 'test')).toThrow(/hash/);
    const empty = marketBaselineFixture();
    empty.backtest.input.replay.bars = [];
    expect(() => runMarketBaseline(bind(empty), 'test')).toThrow(/eligible/);
    const drift = marketBaselineFixture();
    drift.backtest.strategy.config = {};
    expect(() => runMarketBaseline(drift, 'test')).toThrow(/fingerprint/);
  });
  it('rejects financial report tampering through semantic recomputation', () => {
    const r = structuredClone(runMarketBaseline(marketBaselineFixture(), 'synthetic:test'));
    r.outcomes[0]!.metrics.netPnl = decimal('999');
    expect(() => validateMarketBaseline(r)).toThrow(/integrity/);
  }, 30000);
  it('writes immutable bundles and reproduces equal JSON/Markdown bytes', async () => {
    const root = await temp(),
      m = marketBaselineFixture(),
      a = await writeMarketBaseline(m, join(root, 'a'), 'synthetic:test'),
      b = await writeMarketBaseline(
        JSON.parse(canonicalJson(m)),
        join(root, 'b'),
        'synthetic:test',
      );
    expect((await verifyMarketBaseline(a.directory)).hash).toBe(a.hash);
    for (const file of ['report.json', 'report.md', 'manifest.json', 'bundle.json'])
      expect(await readFile(join(a.directory, file))).toEqual(
        await readFile(join(b.directory, file)),
      );
    expect((await writeMarketBaseline(m, join(root, 'a'), 'synthetic:test')).hash).toBe(a.hash);
    expect((await readdir(join(root, 'a'))).filter((s) => s.startsWith('.'))).toHaveLength(0);
    await writeFile(join(a.directory, 'report.md'), 'forged');
    await expect(verifyMarketBaseline(a.directory)).rejects.toThrow(/checksum/);
  }, 60000);
  it('signal-only artifacts also bind the complete manifest and replay', async () => {
    const root = await temp(),
      a = await writeMarketBaseline(
        marketBaselineFixture('SOL', 'REVERSAL', 'SYMMETRIC_MA_FIXTURE'),
        root,
        'synthetic:test',
      );
    expect((await verifyMarketBaseline(a.directory)).report.execution).toBe('DISABLED');
  }, 20000);
  it('CLI denies unknown flags and unregistered strategies', () => {
    for (const args of [
      ['market-fixture', '--live', 'true'],
      ['market-fixture', '--strategy', 'unknown'],
    ]) {
      const r = spawnSync(
        process.execPath,
        ['--import', 'tsx', 'apps/cli/src/backtest.ts', ...args],
        { encoding: 'utf8', timeout: 20000 },
      );
      expect(r.status).toBe(1);
      expect(r.stderr).not.toMatch(/PRIVATE|PASSWORD/);
    }
  }, 50000);
});
