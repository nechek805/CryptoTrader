import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, it, expect } from 'vitest';
import {
  ReplayRequestSchema,
  ReplayInputSchema,
  ReplayStepSchema,
  utcNanoseconds,
} from '@crypto/contracts';
import type { ReplayEvent, ReplayState, ReplayIntent } from '@crypto/contracts';
import { canonicalHash, decimal, fromEpoch } from '@crypto/core';
import { technicalFeatureFixture } from '@crypto/research';
import {
  replayFixture,
  executeReplay,
  scheduleReplayEvents,
  createNoTradeControl,
  validateReplayArtifact,
  writeReplayArtifact,
  verifyReplayArtifact,
  replayReport,
} from '@crypto/backtest';
import type { StrategyFactory, ReplayContext } from '@crypto/backtest';

const at = (s: number) => fromEpoch(1767225600n + BigInt(s), 'seconds'),
  shift = (s: number, n: bigint) => fromEpoch(utcNanoseconds(at(s)) + n, 'nanoseconds'),
  dirs: string[] = [];
const probe =
  (
    onEvent: (e: Readonly<ReplayEvent>, c: ReplayContext, s: ReplayState) => unknown,
  ): StrategyFactory =>
  () => ({
    ...createNoTradeControl(),
    descriptor: { id: 'synthetic:probe', version: '1', portfolio: 'BASELINE', config: {} },
    onEvent,
  });
const unchanged = (state: ReplayState) => ({ state, candidates: [] });
const transformControl =
  (edit: (intent: ReplayIntent) => unknown): StrategyFactory =>
  () => {
    const control = createNoTradeControl();
    return {
      ...control,
      onEvent: (e, c, s) => {
        const step = ReplayStepSchema.parse(control.onEvent(e, c, s));
        return { ...step, candidates: step.candidates.map(edit) };
      },
    };
  };
const run = (f = replayFixture(), factory: StrategyFactory = createNoTradeControl) =>
  executeReplay(f.input, f.request, 'synthetic:test', factory);
const featureQuery = (asOf: ReturnType<typeof at>) => ({
  schemaVersion: 'technical-feature-query.v1',
  series: {
    asset: 'BTC',
    exchange: 'synthetic-replay',
    instrumentId: 'BTC/USDT',
    marketType: 'SPOT',
  },
  intervalSeconds: 60,
  historyStartCloseAt: at(60),
  featureAsOf: asOf,
  config: { ...technicalFeatureFixture().request.config, smaPeriod: 2, returnHorizonsBars: [1] },
});
const barQuery = (asOf: ReturnType<typeof at>, toCloseAt = at(120)) => ({
  series: featureQuery(asOf).series,
  intervalSeconds: 60,
  fromCloseAt: at(60),
  toCloseAt,
  asOf,
});
afterEach(async () => {
  for (const path of dirs.splice(0)) {
    if (
      dirname(resolve(path)) !== resolve(tmpdir()) ||
      !basename(path).startsWith('crypto-replay-')
    )
      throw new Error('Unsafe cleanup');
    await rm(path, { recursive: true, force: true });
  }
});
async function temp() {
  const root = await mkdtemp(join(tmpdir(), 'crypto-replay-'));
  dirs.push(root);
  return root;
}

describe('causal deterministic replay kernel', () => {
  it('replays identical inputs into identical candidate logs, snapshots and state', () => {
    const a = run(),
      b = run();
    expect(canonicalHash(a)).toBe(canonicalHash(b));
    expect(a.manifest.eventCount).toBe(6);
    expect(a.manifest.decisionCount).toBe(5);
    expect(a.candidates).toHaveLength(3);
    expect(a.finalState).toMatchObject({ events: 5, lastDecisionAt: at(190) });
    expect(a.candidates.every((c) => c.side === 'HOLD')).toBe(true);
  });
  it('sorts simultaneous observations, delays and late corrections by availability with stable ties', () => {
    expect(run().log.map((l) => [l.event.recordId, l.event.availableAt, l.phase])).toEqual([
      ['synthetic:bar:1', at(60), 'WARMUP'],
      ['synthetic:bar:2', at(150), 'DECISION'],
      ['synthetic:news:1', at(150), 'DECISION'],
      ['synthetic:bar:3', at(180), 'DECISION'],
      ['synthetic:news:1-update', at(180), 'DECISION'],
      ['synthetic:bar:1-corrected', at(190), 'DECISION'],
    ]);
  });
  it('normalizes input order without changing hashes or tie order', () => {
    const f = replayFixture(),
      a = run(f);
    f.input.bars.reverse();
    f.input.news.reverse();
    const b = run(f);
    expect(a.manifest.inputHash).toBe(b.manifest.inputHash);
    expect(canonicalHash(a)).toBe(canonicalHash(b));
  });
  it('uses original record IDs to break same-kind timestamp ties independently of input position', () => {
    const f = replayFixture(),
      b = structuredClone(f.input.bars[0]!);
    b.id = 'synthetic:bar:0';
    b.instrumentId = 'ETH/USDT';
    b.availableAt = at(150);
    b.provenance.capturedAt = at(150);
    f.input.bars.push(b);
    f.request.symbols.push('ETH/USDT');
    expect(
      run(f)
        .log.filter((l) => l.event.availableAt === at(150))
        .map((l) => l.event.recordId),
    ).toEqual(['synthetic:bar:0', 'synthetic:bar:2', 'synthetic:news:1']);
  });
  it('warms up the visible store without calling the strategy or changing its initial state', () => {
    const a = run();
    expect(a.log[0]!.candidateIds).toEqual([]);
    expect(a.log[0]!.stateHash).toBe(a.snapshots[0]!.stateHash);
    const seen: string[] = [];
    run(
      replayFixture(),
      probe((_e, c, s) => {
        seen.push(...c.bars(barQuery(c.clock.now())).map((b) => b.id));
        return unchanged(s);
      }),
    );
    expect(seen).toContain('synthetic:bar:1');
  });
  it('excludes descriptive/unknown data and the half-open end boundary with explicit reasons', () => {
    const a = run();
    expect(a.manifest.exclusions).toEqual([
      { kind: 'MARKET_BAR', recordId: 'synthetic:bar:4', reason: 'OUTSIDE_PERIOD' },
      { kind: 'MARKET_BAR', recordId: 'synthetic:bar:descriptive', reason: 'DESCRIPTIVE_ONLY' },
    ]);
    expect(a.log.every((l) => l.event.availableAt < a.request.endAt)).toBe(true);
    expect(a.manifest.execution).toBe('DISABLED');
  });
  it('admits start-boundary events as decisions with nanosecond precision', () => {
    const f = replayFixture();
    f.request.startAt = at(150);
    expect(run(f).manifest.decisionCount).toBe(5);
    f.request.startAt = shift(150, 1n);
    expect(run(f).manifest.decisionCount).toBe(3);
    f.request.endAt = shift(190, 1n);
    expect(run(f).log.at(-1)!.event.recordId).toBe('synthetic:bar:1-corrected');
    f.request.endAt = at(190);
    expect(run(f).log.at(-1)!.event.recordId).toBe('synthetic:news:1-update');
  });
  it('reveals only the delivered prefix at identical timestamps', () => {
    const observed: { id: string; news: string[] }[] = [];
    run(
      replayFixture(),
      probe((e, c, s) => {
        observed.push({ id: e.recordId, news: c.news({ asOf: c.clock.now() }).map((n) => n.id) });
        return unchanged(s);
      }),
    );
    expect(observed[0]).toEqual({ id: 'synthetic:bar:2', news: [] });
    expect(observed[1]!.news).toEqual(['synthetic:news:1']);
    expect(observed[2]!.news).toEqual(['synthetic:news:1']);
    expect(observed[3]!.news).toEqual(['synthetic:news:1-update']);
  });
  it('rejects undelivered same-timestamp news by ID instead of returning a future record', () => {
    expect(() =>
      run(
        replayFixture(),
        probe((_e, c, s) => {
          c.newsById({ id: 'synthetic:news:1', asOf: c.clock.now() });
          return unchanged(s);
        }),
      ),
    ).toThrow('REPLAY_DATA_NOT_VISIBLE');
  });
  it('rejects future bars by ID even if they close before the current clock', () => {
    expect(() =>
      run(
        replayFixture(),
        probe((_e, c, s) => {
          c.bar({ id: 'synthetic:bar:1-corrected', asOf: c.clock.now() });
          return unchanged(s);
        }),
      ),
    ).toThrow('REPLAY_DATA_NOT_VISIBLE');
  });
  it('fails the run for a future-time query even if a strategy catches the error', () => {
    expect(() =>
      run(
        replayFixture(),
        probe((_e, c, s) => {
          try {
            c.news({ asOf: at(151) });
          } catch {
            /* A callback cannot neutralize the causal gate. */
          }
          return unchanged(s);
        }),
      ),
    ).toThrow('REPLAY_FUTURE_QUERY');
  });
  it('rejects future bar windows and future feature cutoffs loudly', () => {
    expect(() =>
      run(
        replayFixture(),
        probe((_e, c, s) => {
          c.bars(barQuery(c.clock.now(), at(180)));
          return unchanged(s);
        }),
      ),
    ).toThrow('REPLAY_FUTURE_QUERY');
    expect(() =>
      run(
        replayFixture(),
        probe((_e, c, s) => {
          c.features(featureQuery(shift(150, 1n)));
          return unchanged(s);
        }),
      ),
    ).toThrow('REPLAY_FUTURE_QUERY');
  });
  it('selects old/new price revisions at their own cutoffs without rewriting earlier reads', () => {
    const prices: string[] = [],
      ids: string[][] = [];
    const a = run(
      replayFixture(),
      probe((_e, c, s) => {
        const q = c.bars(barQuery(c.clock.now()));
        prices.push(q[0]!.close);
        ids.push(q.map((b) => b.id));
        return unchanged(s);
      }),
    );
    expect(prices).toEqual(['100', '100', '100', '100', '101']);
    expect(ids[0]).toContain('synthetic:bar:1');
    expect(ids.at(-1)).toContain('synthetic:bar:1-corrected');
    expect(a.log[1]!.queries[0]!.recordIds).toContain('synthetic:bar:1');
    expect(a.log[1]!.queries[0]!.maxInputAvailableAt).toBe(at(150));
  });
  it('reconstructs earlier historical queries after a correction has arrived', () => {
    const old: string[] = [];
    run(
      replayFixture(),
      probe((_e, c, s) => {
        old.push(c.bar({ id: 'synthetic:bar:1', asOf: at(60) }).close);
        return unchanged(s);
      }),
    );
    expect(new Set(old)).toEqual(new Set(['100']));
    run(
      replayFixture(),
      probe((_e, c, s) => {
        expect(c.bars(barQuery(at(150)))[0]!.id).toBe('synthetic:bar:1');
        return unchanged(s);
      }),
    );
  });
  it('computes causal features from delivered bars and audits their actual source clocks', () => {
    const smas: (string | null)[] = [];
    const a = run(
      replayFixture(),
      probe((_e, c, s) => {
        const r = c.features(featureQuery(c.clock.now()));
        smas.push(r.features.find((f) => f.featureId === 'sma')!.value);
        expect(r.maxInputAvailableAt! <= c.clock.now()).toBe(true);
        return unchanged(s);
      }),
    );
    expect(smas).toEqual(['101', '101', '102.5', '102.5', '102.5']);
    expect(a.log[1]!.queries[0]!.kind).toBe('FEATURES');
    expect(a.log[1]!.queries[0]!.recordIds).not.toContain('synthetic:bar:1-corrected');
  });
  it('does not expose future inputs through feature diagnostics or dataset hashes', () => {
    const f = replayFixture(),
      views: unknown[] = [],
      factory = probe((_e, c, s) => {
        views.push(c.features(featureQuery(c.clock.now())));
        return unchanged(s);
      });
    run(f, factory);
    const first = views[0];
    f.input.bars.find((b) => b.id === 'synthetic:bar:4')!.close = decimal('109');
    views.length = 0;
    run(f, factory);
    expect(views[0]).toEqual(first);
    expect(JSON.stringify(first)).not.toContain('synthetic:bar:4');
  });
  it('returns immutable events, query results, strategy state, descriptors and run outputs', () => {
    const a = run(
      replayFixture(),
      probe((e, c, s) => {
        expect(Object.isFrozen(e.record.provenance)).toBe(true);
        expect(Object.isFrozen(c.bars(barQuery(c.clock.now())))).toBe(true);
        expect(Object.isFrozen(s)).toBe(true);
        expect(() => {
          s.changed = true;
        }).toThrow();
        return unchanged(s);
      }),
    );
    expect(Object.isFrozen(a.snapshots)).toBe(true);
    expect(Object.isFrozen(a.manifest)).toBe(true);
  });
  it('expires query, clock and randomness capabilities after each callback', () => {
    let saved: ReplayContext | undefined;
    run(
      replayFixture(),
      probe((_e, c, s) => {
        if (saved)
          expect(() => saved!.bar({ id: 'synthetic:bar:1', asOf: at(60) })).toThrow('EXPIRED');
        saved = c;
        return unchanged(s);
      }),
    );
    expect(() => saved!.clock.now()).toThrow('EXPIRED');
    expect(() => saved!.random.next()).toThrow('EXPIRED');
  });
  it('repeats seeded strategy randomness and records draw counts in checkpoints', () => {
    const factory = probe((_e, c, s) => ({
        state: { ...s, draws: [...(Array.isArray(s.draws) ? s.draws : []), c.random.next()] },
        candidates: [],
      })),
      f = replayFixture(),
      a = run(f, factory);
    expect(a.finalState).toEqual(run(f, factory).finalState);
    expect(a.log.at(-1)!.randomDraws).toBe(5);
    expect(a.snapshots.at(-1)!.randomDraws).toBe(5);
    f.request.randomSeed++;
    expect(run(f, factory).finalState).not.toEqual(a.finalState);
    expect(run(f, factory).manifest.configHash).not.toBe(a.manifest.configHash);
  });
  it('records exact dataCutoff, bound provenance and HOLD expiration without accepting clock overrides', () => {
    const a = run();
    for (const c of a.candidates) {
      expect(c.dataCutoff).toBe(c.decisionAt);
      expect(c.reproducibility.datasetHashes).toEqual([a.manifest.inputHash]);
      expect(c.reproducibility.feeAssumptionsHash).toBe(a.manifest.feeAssumptionsHash);
      expect(utcNanoseconds(c.validUntil) - utcNanoseconds(c.decisionAt)).toBe(60000000000n);
    }
    const factory = transformControl((i) => ({ ...i, dataCutoff: at(0) }));
    expect(() => run(replayFixture(), factory)).toThrow();
  });
  it('accepts intent-only LONG/SHORT candidates while keeping execution disabled', () => {
    const factory = transformControl((i) => ({ ...i, side: 'LONG' }));
    const a = run(replayFixture(), factory);
    expect(a.candidates.every((c) => c.side === 'LONG')).toBe(true);
    expect(a.manifest.executionAssumptions).toBe('NO_EXECUTION_NO_COST_MODEL');
    expect('orders' in a).toBe(false);
  });
  it('rejects fabricated or future rationale IDs, unknown fields and out-of-cohort candidates', () => {
    for (const change of [
      { rationaleIds: ['synthetic:bar:4'] },
      { symbol: 'ETH/USDT' },
      { execute: true },
    ]) {
      const factory = transformControl((i) => ({ ...i, ...change }));
      expect(() => run(replayFixture(), factory)).toThrow();
    }
  });
  it('rejects ambiguous IDs, same-cutoff revisions and mislabeled fixtures', () => {
    const f = replayFixture();
    f.input.bars.push(f.input.bars[0]!);
    expect(() => run(f)).toThrow('Duplicate');
    f.input.bars.pop();
    f.input.bars.push({ ...f.input.bars[0]!, id: 'synthetic:other' });
    expect(() => run(f)).toThrow('Ambiguous');
    f.input.bars.pop();
    f.input.news[0]!.id = f.input.bars[0]!.id;
    expect(() => run(f)).toThrow('Duplicate');
    const g = replayFixture();
    g.input.bars[0]!.qualityFlags = [];
    expect(() => run(g)).toThrow('synthetic');
  });
  it('validates periods, seeds, interfaces and unknown execution options with Zod', () => {
    const { input, request } = replayFixture();
    for (const bad of [
      { ...request, startAt: request.endAt },
      { ...request, generatedAt: at(0) },
      { ...request, randomSeed: -1 },
      { ...request, snapshotEvery: 0 },
      { ...request, symbols: ['BTC/USDT', 'BTC/USDT'] },
      { ...request, execute: true },
    ])
      expect(ReplayRequestSchema.safeParse(bad).success).toBe(false);
    expect(ReplayInputSchema.safeParse({ ...input, orders: [] }).success).toBe(false);
  });
  it('enforces query, random, feature and result-work budgets even if callbacks catch failures', () => {
    const f = replayFixture();
    f.request.maxQueriesPerEvent = 1;
    expect(() =>
      run(
        f,
        probe((_e, c, s) => {
          try {
            c.news({ asOf: c.clock.now() });
            c.news({ asOf: c.clock.now() });
          } catch {
            /* checked by kernel */
          }
          return unchanged(s);
        }),
      ),
    ).toThrow('QUERY_BUDGET');
    expect(() =>
      run(
        replayFixture(),
        probe((_e, c, s) => {
          for (let i = 0; i < 1025; i++) c.random.next();
          return unchanged(s);
        }),
      ),
    ).toThrow('RANDOM_BUDGET');
    expect(() =>
      run(
        replayFixture(),
        probe((_e, c, s) => {
          for (let i = 0; i < 3; i++) c.features(featureQuery(c.clock.now()));
          return unchanged(s);
        }),
      ),
    ).toThrow('FEATURE_QUERY_BUDGET');
  });
  it('rejects non-JSON/oversized state and async callbacks instead of persisting hidden state', () => {
    for (const state of [
      { invalid: BigInt(1) },
      { invalid: NaN },
      { invalid: 'x'.repeat(17000) },
      { invalid: new Date() },
    ])
      expect(() =>
        run(
          replayFixture(),
          probe(() => ({ state, candidates: [] })),
        ),
      ).toThrow();
    expect(() =>
      run(
        replayFixture(),
        probe(() => Promise.resolve({ state: {}, candidates: [] })),
      ),
    ).toThrow('plain JSON');
  });
  it('keeps snapshot state, visible IDs and log chain consistent at every checkpoint', () => {
    const a = run();
    expect(a.snapshots.map((s) => s.sequence)).toEqual([0, 2, 4, 6]);
    for (const s of a.snapshots) {
      expect(s.stateHash).toBe(canonicalHash(s.state));
      expect(s.visibleBarIds).toEqual(
        a.log
          .slice(0, s.sequence)
          .filter((l) => l.event.kind === 'MARKET_BAR')
          .map((l) => l.event.recordId),
      );
      if (s.sequence) expect(s.logHead).toBe(a.log[s.sequence - 1]!.hash);
    }
    for (const [i, l] of a.log.entries()) {
      const { hash, ...body } = l;
      expect(hash).toBe(canonicalHash(body));
      if (i) expect(l.previousHash).toBe(a.log[i - 1]!.hash);
    }
  });
  it('handles an empty schedule without invented decisions and records the initial snapshot', () => {
    const f = replayFixture();
    f.input.bars = [];
    f.input.news = [];
    const a = run(f);
    expect(a.candidates).toEqual([]);
    expect(a.log).toEqual([]);
    expect(a.snapshots).toHaveLength(1);
    expect(a.snapshots[0]!.clock).toBe(f.request.startAt);
  });
  it('enforces snapshot work bounds before strategy callbacks and audits outside-cohort prices', () => {
    const f = replayFixture(),
      base = f.input.bars[0]!;
    f.input.bars = Array.from({ length: 501 }, (_, i) => {
      const availableAt = shift(60, BigInt(i));
      return {
        ...base,
        id: `synthetic:budget:${i}`,
        availableAt,
        provenance: { ...base.provenance, capturedAt: availableAt },
      };
    });
    f.input.news = [];
    f.request.snapshotEvery = 1;
    expect(scheduleReplayEvents(f.input, f.request).events).toHaveLength(501);
    expect(() => run(f)).toThrow('snapshot work budget');
    const g = replayFixture();
    g.input.bars[0]!.instrumentId = 'ETH/USDT';
    expect(run(g).manifest.exclusions).toContainEqual({
      kind: 'MARKET_BAR',
      recordId: 'synthetic:bar:1',
      reason: 'OUTSIDE_COHORT',
    });
  });
  it('treats invalid query shapes and out-of-cohort requests as sticky failures', () => {
    expect(() =>
      run(
        replayFixture(),
        probe((_e, c, s) => {
          try {
            c.news({ asOf: c.clock.now(), execute: true });
          } catch {
            /* cannot neutralize validation */
          }
          return unchanged(s);
        }),
      ),
    ).toThrow('REPLAY_INVALID_QUERY');
    expect(() =>
      run(
        replayFixture(),
        probe((_e, c, s) => {
          const q = barQuery(c.clock.now());
          q.series.instrumentId = 'ETH/USDT';
          c.bars(q);
          return unchanged(s);
        }),
      ),
    ).toThrow('REPLAY_SYMBOL_OUTSIDE_COHORT');
    expect(() =>
      run(
        replayFixture(),
        probe((_e, c, s) => {
          c.bar({ id: 'missing', asOf: c.clock.now() });
          return unchanged(s);
        }),
      ),
    ).toThrow('REPLAY_DATA_NOT_VISIBLE');
  });
  it('retains known bad corrections without silently reviving an older clean feature input', () => {
    const f = replayFixture();
    f.input.bars.find((b) => b.id === 'synthetic:bar:1-corrected')!.qualityFlags.push('GAP');
    const values: (string | null)[] = [];
    run(
      f,
      probe((_e, c, s) => {
        const q = featureQuery(c.clock.now());
        q.config.smaPeriod = 3;
        values.push(c.features(q).features.find((f) => f.featureId === 'sma')!.value);
        if (c.clock.now() === at(190))
          expect(c.bars(barQuery(c.clock.now()))[0]!.id).toBe('synthetic:bar:1-corrected');
        return unchanged(s);
      }),
    );
    expect(values[2]).not.toBeNull();
    expect(values.at(-1)).toBeNull();
  });
  it('accepts historical rationale evidence only through a current delivered query', () => {
    const factory: StrategyFactory = () => {
      const control = createNoTradeControl();
      return {
        ...control,
        onEvent: (e, c, s) => {
          c.bar({ id: 'synthetic:bar:1', asOf: at(60) });
          const step = ReplayStepSchema.parse(control.onEvent(e, c, s));
          return {
            ...step,
            candidates: step.candidates.map((i) => ({ ...i, rationaleIds: ['synthetic:bar:1'] })),
          };
        },
      };
    };
    const a = run(replayFixture(), factory);
    expect(a.candidates).toHaveLength(3);
    expect(a.log[1]!.queries[0]!.recordIds).toEqual(['synthetic:bar:1']);
    expect(() =>
      run(
        replayFixture(),
        transformControl((i) => ({ ...i, rationaleIds: ['synthetic:bar:1'] })),
      ),
    ).toThrow('REPLAY_RATIONALE_NOT_VISIBLE');
  });
  it('detects modified state, candidates, order logs, snapshots and manifests through semantic replay', () => {
    const a = run();
    for (const edit of [
      (b: typeof a) => {
        b.finalState.events = 999;
      },
      (b: typeof a) => {
        b.candidates[0]!.side = 'LONG';
      },
      (b: typeof a) => {
        b.log.reverse();
      },
      (b: typeof a) => {
        b.snapshots[0]!.visibleBarIds = ['future'];
      },
      (b: typeof a) => {
        b.manifest.eventCount++;
      },
    ]) {
      const changed = structuredClone(a);
      edit(changed);
      expect(() => validateReplayArtifact(changed)).toThrow('integrity');
    }
    const custom = run(
      replayFixture(),
      probe((_e, _c, s) => unchanged(s)),
    );
    expect(() => validateReplayArtifact(custom)).toThrow('integrity');
  });
  it('publishes immutable artifacts with stable hashes and refuses corrupted reuse', async () => {
    const f = replayFixture(),
      root = await temp(),
      a = await writeReplayArtifact(f.input, f.request, root, 'synthetic:test'),
      b = await writeReplayArtifact(f.input, f.request, root, 'synthetic:test');
    expect(a.hash).toBe(b.hash);
    expect((await verifyReplayArtifact(a.path)).artifact).toEqual(a.artifact);
    expect(await readdir(root)).toEqual([basename(a.path)]);
    const wrong = join(root, 'wrong.json');
    await writeFile(wrong, await readFile(a.path));
    await expect(verifyReplayArtifact(wrong)).rejects.toThrow('name');
    await writeFile(a.path, '{}');
    await expect(writeReplayArtifact(f.input, f.request, root, 'synthetic:test')).rejects.toThrow();
    expect(await readFile(a.path, 'utf8')).toBe('{}');
    expect((await readdir(root)).some((n) => n.startsWith('.replay-'))).toBe(false);
  });
  it('rejects a non-repeatable strategy before publishing any artifact', async () => {
    let invocation = 0;
    const factory: StrategyFactory = () => ({
        ...createNoTradeControl(),
        initialState: () => ({ events: 0, invocation: ++invocation }),
      }),
      f = replayFixture(),
      root = await temp();
    await expect(
      writeReplayArtifact(f.input, f.request, root, 'synthetic:test', factory),
    ).rejects.toThrow('integrity');
    expect(await readdir(root)).toEqual([]);
  });
  it('reports research limits and rejects unrecognized CLI options before reading input', () => {
    const report = replayReport(run());
    expect(report).toContain('No execution, cost model');
    expect(report).toContain('audit checkpoints');
    expect(report).toContain('synthetic');
    for (const args of [
      ['fixture', '--execute', 'true'],
      ['run', '--input', 'missing'],
      ['verify', '--artifact', 'missing', '--private-key', 'forbidden'],
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
