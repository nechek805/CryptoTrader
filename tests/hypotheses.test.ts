import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HypothesisCardContentSchema,
  HypothesisDatasetSchema,
  HypothesisHandoffSchema,
} from '@crypto/contracts';
import type { HypothesisCardContent } from '@crypto/contracts';
import { canonicalHash, decimal, fromEpoch, utc } from '@crypto/core';
import { utcNanoseconds } from '@crypto/contracts';
import {
  hypothesisFixture,
  buildHypothesisRegistry,
  appendHypothesisCard,
  validateHypothesisCards,
  validateHypothesisRegistry,
  writeHypothesisRegistry,
  verifyHypothesisRegistry,
  hypothesisRegistryReport,
  hypothesisNewsStrategyInputs,
  validateHypothesisHandoff,
} from '@crypto/research';

const corpus = hypothesisFixture(),
  directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0)) {
    if (
      dirname(resolve(path)) !== resolve(tmpdir()) ||
      !basename(path).startsWith('crypto-hypotheses-')
    )
      throw new Error('Unsafe cleanup');
    await rm(path, { recursive: true, force: true });
  }
});
async function setup(compact = false) {
  const f = structuredClone(await corpus);
  f.request.bootstrapSamples = 200;
  if (compact) {
    f.input.cards = f.input.cards.slice(0, 1);
    f.input.dataset.newsSnapshots = f.input.dataset.newsSnapshots.slice(0, 1);
    f.input.dataset.observations = f.input.dataset.observations.filter(
      (o) => o.id.startsWith('synthetic:exchange-') || o.id === 'synthetic:exchange:archive',
    );
    f.input.dataset.marketBars = f.input.dataset.marketBars.filter((b) =>
      b.id.includes(':exchange-'),
    );
  }
  return f;
}
const build = (f: Awaited<ReturnType<typeof setup>>) =>
  buildHypothesisRegistry(f.input, f.request, 'synthetic:test');
function replaceCard(
  f: Awaited<ReturnType<typeof setup>>,
  index: number,
  edit: (c: HypothesisCardContent) => void,
) {
  const old = f.input.cards[index]!,
    content = structuredClone(old.content);
  edit(content);
  f.input.cards[index] = appendHypothesisCard(
    [],
    { expectedPreviousHash: null, author: old.author, reason: old.reason, content },
    old.recordedAt,
  );
}
function revise(
  f: Awaited<ReturnType<typeof setup>>,
  edit: (c: HypothesisCardContent) => void,
  at = '2026-01-21T00:00:00Z',
) {
  const old = f.input.cards.findLast((c) => c.content.id === f.input.cards[0]!.content.id)!,
    content = structuredClone(old.content);
  edit(content);
  const card = appendHypothesisCard(
    f.input.cards,
    {
      expectedPreviousHash: old.hash,
      author: 'synthetic:reviewer',
      reason: 'Synthetic revision test.',
      content,
    },
    at,
  );
  f.input.cards.push(card);
  return card;
}
describe('hypothesis registry and time validity', () => {
  it('reports all three synthetic groups with sample counts, uncertainty and a negative finding', async () => {
    const a = build(await setup());
    expect(a.synthetic).toBe(true);
    expect(a.evaluations.map((e) => e.finalStatus)).toEqual([
      'SYNTHETIC_ONLY',
      'NEGATIVE_FINDING',
      'INCONCLUSIVE',
    ]);
    const [exchange, rates, listings] = a.evaluations;
    expect(exchange!.selection).toMatchObject({
      sampleCount: 2,
      completeCount: 2,
      independentUnits: 2,
      confidenceInterval: null,
      uncertaintyReason: 'INSUFFICIENT_INDEPENDENT_UNITS',
    });
    expect(exchange!.validation).toMatchObject({
      sampleCount: 4,
      completeCount: 3,
      quarantinedCount: 1,
      independentUnits: 3,
    });
    expect(exchange!.validation.confidenceInterval).toMatchObject({
      lower: '-0.04',
      upper: '-0.01',
      familySize: 6,
      multiplicity: 'BONFERRONI_TARGET_95_FAMILY',
    });
    expect(rates!.validation.mean).toBe('0');
    expect(rates!.validation.confidenceInterval).toMatchObject({ lower: '0', upper: '0' });
    expect(rates!.contradictoryExamples.length).toBeGreaterThanOrEqual(3);
    expect(listings!.validation.confidenceInterval).toMatchObject({
      lower: '-0.03',
      upper: '0.02',
    });
    expect(a.evaluations.every((e) => e.independence === 'SEPARATE_PERIODS_AND_LINEAGE')).toBe(
      true,
    );
  });
  it('rejects undeclared period reuse and labels disclosed overlap exploratory', async () => {
    const f = await setup(true),
      content = structuredClone(f.input.cards[0]!.content);
    content.samplePeriod.selection = content.samplePeriod.validation;
    expect(HypothesisCardContentSchema.safeParse(content).success).toBe(false);
    expect(
      HypothesisCardContentSchema.safeParse({
        ...f.input.cards[0]!.content,
        thesis: 'Exchange incidents cause ETH prices to fall.',
      }).success,
    ).toBe(false);
    replaceCard(f, 0, (c) => {
      c.samplePeriod.selection = c.samplePeriod.validation;
      c.reuseDisclosure = 'Synthetic reuse disclosed; no independent final validation.';
    });
    const e = build(f).evaluations[0]!;
    expect(e.finalStatus).toBe('EXPLORATORY_REUSE');
    expect(e.reuseReasons).toContain('PERIOD_OVERLAP');
    expect(e.reuseReasons).toContain('LINEAGE_ACROSS_PERIODS');
  });
  it('detects shared event lineage even when declared periods are disjoint', async () => {
    const f = await setup(true),
      early = f.input.dataset.observations.find((o) => o.kind === 'POINT_IN_TIME')!,
      later = f.input.dataset.observations.find((o) => o.id === 'synthetic:exchange-2')!;
    f.input.dataset.observations.push({
      ...early,
      id: 'synthetic:reused-event',
      decisionAt: later.decisionAt,
    });
    expect(() => build(f)).toThrow('requires disclosure');
    replaceCard(f, 0, (c) => {
      c.reuseDisclosure = 'Same event deliberately revisited; exploratory only.';
    });
    const e = build(f).evaluations[0]!;
    expect(e.reuseReasons).toEqual(['LINEAGE_ACROSS_PERIODS']);
    expect(e.finalStatus).toBe('EXPLORATORY_REUSE');
  });
  it('does not call a hypothesis amended after validation starts independently validated', async () => {
    const f = await setup(true);
    revise(f, (c) => {
      c.thesis = 'Changed after viewing a validation period.';
    });
    expect(() => build(f)).toThrow('requires disclosure');
    f.input.cards.pop();
    revise(f, (c) => {
      c.thesis = 'Retrospective version.';
      c.reuseDisclosure = 'Validation had started before this revision.';
    });
    const e = build(f).evaluations[0]!;
    expect(e.finalStatus).toBe('EXPLORATORY_REUSE');
    expect(e.reuseReasons).toContain('FREEZE_AFTER_VALIDATION_START');
  });
  it('quarantines descriptive archives without fabricating prices or counting them in confidence intervals', async () => {
    const f = await setup(),
      a = build(f);
    for (const e of a.evaluations) {
      const historical = e.samples.find((s) => s.firstSeenQuality === 'UNKNOWN')!;
      expect(historical).toMatchObject({
        status: 'DESCRIPTIVE_ONLY',
        grossReturn: null,
        netReturn: null,
      });
      expect(e.validation.independentUnits).toBe(3);
      expect(e.validation.unitMembers.flat()).not.toContain(historical.observationId);
    }
    const archive = f.input.dataset.observations.find((o) => o.kind === 'HISTORICAL_DESCRIPTIVE')!;
    expect(
      HypothesisDatasetSchema.safeParse({
        ...f.input.dataset,
        observations: [{ ...archive, researchUse: 'ELIGIBLE' }],
      }).success,
    ).toBe(false);
  });
  it('does not treat missing outcomes as zero or report an interval with too few units', async () => {
    const f = await setup(true);
    f.input.dataset.marketBars = f.input.dataset.marketBars.filter(
      (b) => b.id !== 'synthetic:hypothesis-bar:exchange-2:5',
    );
    const e = build(f).evaluations[0]!;
    expect(e.validation.completeCount).toBe(2);
    expect(e.validation.confidenceInterval).toBeNull();
    expect(e.finalStatus).toBe('INSUFFICIENT_DATA');
    expect(e.samples.find((s) => s.observationId === 'synthetic:exchange-2')).toMatchObject({
      status: 'MISSING_PRICES',
      grossReturn: null,
    });
  });
  it('excludes a price available one nanosecond after its decision', async () => {
    const f = await setup(true),
      bar = f.input.dataset.marketBars.find(
        (b) => b.id === 'synthetic:hypothesis-bar:exchange-2:5',
      )!;
    bar.availableAt = fromEpoch(utcNanoseconds(bar.closeAt) + 1n, 'nanoseconds');
    expect(
      build(f).evaluations[0]!.samples.find((s) => s.observationId === 'synthetic:exchange-2')!
        .grossReturn,
    ).toBeNull();
  });
  it('keeps outcomes inside their declared sample period', async () => {
    const f = await setup(true);
    replaceCard(f, 0, (c) => {
      c.samplePeriod.validation.to = utc('2026-01-22T09:03:00Z');
    });
    expect(
      build(f).evaluations[0]!.samples.find((s) => s.observationId === 'synthetic:exchange-4'),
    ).toMatchObject({ status: 'OUTCOME_OUTSIDE_PERIOD', grossReturn: null });
  });
  it('does not reveal future observations or fill future outcome windows at an earlier analysis cutoff', async () => {
    const f = await setup(true);
    f.request.analysisAsOf = utc('2026-01-20T09:02:00Z');
    const e = build(f).evaluations[0]!;
    expect(e.validation.sampleCount).toBe(1);
    expect(e.validation.completeCount).toBe(0);
    expect(e.samples.find((s) => s.phase === 'VALIDATION')).toMatchObject({
      status: 'FUTURE_OUTCOME',
      grossReturn: null,
    });
    expect(e.samples.some((s) => s.observationId === 'synthetic:exchange-3')).toBe(false);
  });
  it('does not multiply independent sample size with repeated observations of one event', async () => {
    const f = await setup(true),
      o = f.input.dataset.observations.find((o) => o.id === 'synthetic:exchange-2')!;
    f.input.dataset.observations.push({ ...o, id: 'synthetic:repeat' });
    const s = build(f).evaluations[0]!.validation;
    expect(s.completeCount).toBe(4);
    expect(s.independentUnits).toBe(3);
    expect(s.unitMembers.some((g) => g.includes('synthetic:repeat') && g.includes(o.id))).toBe(
      true,
    );
  });
  it('uses the predeclared primary metric and records assumed cost separately', async () => {
    const f = await setup();
    replaceCard(f, 1, (c) => {
      c.tests.primaryMetric = 'NET_RETURN';
    });
    const r = build(f).evaluations.find((e) => e.cardId.endsWith(':rates'))!;
    expect(r.validation.mean).toBe('-0.001');
    expect(r.validation.confidenceInterval).toMatchObject({ lower: '-0.001', upper: '-0.001' });
    expect(r.finalStatus).toBe('NEGATIVE_FINDING');
  });
  it('respects predeclared first-seen quality rules', async () => {
    const f = await setup(true);
    replaceCard(f, 0, (c) => {
      c.eligibility.firstSeenQualities = ['ARCHIVED_CAPTURE'];
    });
    const e = build(f).evaluations[0]!;
    expect(e.validation.completeCount).toBe(0);
    expect(e.validation.confidenceInterval).toBeNull();
    expect(
      e.samples
        .filter((s) => s.firstSeenQuality === 'OBSERVED')
        .every((s) => s.status === 'QUALITY_EXCLUDED'),
    ).toBe(true);
  });
  it('requires causal justification and never upgrades an observational fit into causal evidence', async () => {
    const f = await setup(true),
      content = { ...f.input.cards[0]!.content, claimType: 'CAUSAL' };
    expect(HypothesisCardContentSchema.safeParse(content).success).toBe(false);
    replaceCard(f, 0, (c) => {
      c.claimType = 'CAUSAL';
      c.causalJustification = {
        design: 'Unverified synthetic natural-experiment proposal.',
        identificationAssumptions: ['Unconfounded timing remains unverified.'],
        evidenceReferences: ['fixture://not-identification-proof'],
        reviewer: 'synthetic:reviewer',
      };
    });
    const a = build(f);
    expect(a.evaluations[0]!.finalStatus).toBe('CAUSAL_REVIEW_REQUIRED');
    expect(
      hypothesisNewsStrategyInputs(a, {
        decisionAt: '2026-01-25T00:00:00Z',
        purpose: 'NEWS_STRATEGY_RESEARCH',
      }).events,
    ).toEqual([]);
  });
  it('records append-only card versions and rejects stale writes, forks, reorderings and tampering', async () => {
    const f = await setup(true),
      old = f.input.cards[0]!,
      next = revise(f, (c) => {
        c.reuseDisclosure = 'Synthetic retrospective amendment.';
      });
    expect(next.revision).toBe(2);
    expect(next.previousHash).toBe(old.hash);
    expect(validateHypothesisCards(f.input.cards)).toHaveLength(2);
    expect(() =>
      appendHypothesisCard(
        f.input.cards,
        {
          expectedPreviousHash: old.hash,
          author: 'synthetic:a',
          reason: 'Stale.',
          content: old.content,
        },
        '2026-01-22T00:00:00Z',
      ),
    ).toThrow('Stale');
    expect(() => validateHypothesisCards([...f.input.cards, next])).toThrow('integrity');
    expect(() => validateHypothesisCards([...f.input.cards].reverse())).toThrow('integrity');
    const changed = structuredClone(old);
    changed.content.thesis = 'Changed without a new revision.';
    expect(() => validateHypothesisCards([changed])).toThrow('integrity');
  });
  it('requires generation after card recording and rejects unknown event/snapshot pointers', async () => {
    const f = await setup(true);
    revise(
      f,
      (c) => {
        c.reuseDisclosure = 'Synthetic late revision.';
      },
      '2026-02-01T00:00:00Z',
    );
    expect(() => build(f)).toThrow('generation');
    f.input.cards.pop();
    const o = f.input.dataset.observations.find((o) => o.kind === 'POINT_IN_TIME')!;
    if (o.kind === 'POINT_IN_TIME') o.snapshotHash = canonicalHash('unknown');
    expect(() => build(f)).toThrow('Missing snapshot');
  });
  it('rejects tampered source snapshots and duplicate evidence identities', async () => {
    const f = await setup(true),
      changed = structuredClone(f);
    changed.input.dataset.newsSnapshots[0]!.inputHash = canonicalHash('tampered');
    expect(() => build(changed)).toThrow('integrity');
    f.input.dataset.observations.push(f.input.dataset.observations[0]!);
    expect(() => build(f)).toThrow('Duplicate');
  });
  it('replays the registry deterministically and freezes detached copies', async () => {
    const f = await setup(true),
      a = build(f),
      b = build(f);
    expect(canonicalHash(a)).toBe(canonicalHash(b));
    expect(Object.isFrozen(a.input.cards[0]!.content)).toBe(true);
    expect(Object.isFrozen(a.evaluations[0]!.validation)).toBe(true);
    Object.assign(f.input.dataset.marketBars[0]!, { close: '999' });
    expect(a.input.dataset.marketBars[0]!.close).toBe('100');
  });
  it('keeps retired/draft hypotheses from becoming active strategy inputs', async () => {
    const f = await setup(true);
    replaceCard(f, 0, (c) => {
      c.status = 'DRAFT';
    });
    let a = build(f);
    expect(a.evaluations[0]!.finalStatus).toBe('DRAFT');
    expect(
      hypothesisNewsStrategyInputs(a, {
        decisionAt: '2026-01-25T00:00:00Z',
        purpose: 'NEWS_STRATEGY_RESEARCH',
      }).events,
    ).toEqual([]);
    replaceCard(f, 0, (c) => {
      c.status = 'RETIRED';
    });
    a = build(f);
    expect(a.evaluations[0]!.finalStatus).toBe('RETIRED');
  });
  it('exports only known registered cards/events and quarantines archives from tradable backtest inputs', async () => {
    const a = build(await setup()),
      h = hypothesisNewsStrategyInputs(a, {
        decisionAt: '2026-01-25T00:00:00Z',
        purpose: 'TRADABLE_BACKTEST_INPUT',
      });
    expect(h.defaultAction).toBe('HOLD');
    expect(h.events).toHaveLength(9);
    expect(h.quarantined).toHaveLength(3);
    expect(h.cards).toHaveLength(3);
    expect(
      h.events.every((e) =>
        e.cardHashes.every((hash) =>
          h.cards.some((c) => c.hash === hash && c.recordedAt <= e.observationDecisionAt),
        ),
      ),
    ).toBe(true);
    const json = JSON.stringify(h);
    for (const field of ['grossReturn', 'confidenceInterval', 'finalStatus', 'SHORT'])
      expect(json).not.toContain(field);
    expect(validateHypothesisHandoff(a, h)).toEqual(h);
  }, 30000);
  it('does not apply a future card revision to earlier events', async () => {
    const f = await setup(true),
      old = f.input.cards[0]!,
      next = revise(f, (c) => {
        c.thesis = 'Updated synthetic thesis.';
        c.reuseDisclosure = 'Updated after validation started.';
      }),
      a = build(f),
      h = hypothesisNewsStrategyInputs(a, {
        decisionAt: '2026-01-25T00:00:00Z',
        purpose: 'NEWS_STRATEGY_RESEARCH',
      });
    expect(h.events.find((e) => e.observationId === 'synthetic:exchange-2')!.cardHashes).toEqual([
      old.hash,
    ]);
    expect(h.events.find((e) => e.observationId === 'synthetic:exchange-3')!.cardHashes).toEqual([
      next.hash,
    ]);
  });
  it('does not expose an archive before capture or events before a card was registered', async () => {
    const a = build(await setup(true));
    expect(
      hypothesisNewsStrategyInputs(a, {
        decisionAt: '2026-01-02T23:00:00Z',
        purpose: 'NEWS_STRATEGY_RESEARCH',
      }).events,
    ).toEqual([]);
    const early = hypothesisNewsStrategyInputs(a, {
      decisionAt: '2026-01-24T00:00:00Z',
      purpose: 'NEWS_STRATEGY_RESEARCH',
    });
    expect(early.quarantined).toEqual([]);
  });
  it('does not leak later price outcomes into historical News Strategy features', async () => {
    const f = await setup(true),
      a = build(f),
      h = hypothesisNewsStrategyInputs(a, {
        decisionAt: '2026-01-20T10:00:00Z',
        purpose: 'NEWS_STRATEGY_RESEARCH',
      });
    const bar = f.input.dataset.marketBars.find(
      (b) => b.id === 'synthetic:hypothesis-bar:exchange-4:5',
    )!;
    Object.assign(bar, { close: '130', high: '130' });
    const modified = build(f),
      next = hypothesisNewsStrategyInputs(modified, {
        decisionAt: h.decisionAt,
        purpose: h.purpose,
      });
    expect(next.registryHash).not.toBe(h.registryHash);
    expect(next.events).toEqual(h.events);
    expect(next.cards).toEqual(h.cards);
    expect(next.quarantined).toEqual(h.quarantined);
  }, 30000);
  it('rejects forged handoff versions, future availability, extra outcomes and future cutoffs', async () => {
    const a = build(await setup(true)),
      h = hypothesisNewsStrategyInputs(a, {
        decisionAt: '2026-01-25T00:00:00Z',
        purpose: 'TRADABLE_BACKTEST_INPUT',
      }),
      changed = structuredClone(h);
    changed.events[0]!.event.availableAt = utc('2026-01-31T00:00:00Z');
    expect(HypothesisHandoffSchema.safeParse(changed).success).toBe(false);
    expect(HypothesisHandoffSchema.safeParse({ ...h, grossReturn: '0.1' }).success).toBe(false);
    changed.events[0]!.event.availableAt = h.events[0]!.event.availableAt;
    changed.events[0]!.eventContextHash = canonicalHash('forged');
    expect(() => validateHypothesisHandoff(a, changed)).toThrow('integrity');
    expect(() =>
      hypothesisNewsStrategyInputs(a, { decisionAt: '2026-02-01T00:00:00Z', purpose: h.purpose }),
    ).toThrow('cutoff');
  }, 30000);
  it('publishes immutable content-addressed registries and detects output tampering', async () => {
    const f = await setup(true),
      root = await mkdtemp(join(tmpdir(), 'crypto-hypotheses-'));
    directories.push(root);
    const a = await writeHypothesisRegistry(f.input, f.request, root, 'synthetic:test'),
      b = await writeHypothesisRegistry(f.input, f.request, root, 'synthetic:test');
    expect(a.hash).toBe(b.hash);
    expect(await readdir(root)).toEqual([basename(a.path)]);
    const changed = structuredClone(a.artifact);
    changed.evaluations[0]!.validation.confidenceInterval!.lower = decimal('-0.9');
    expect(() => validateHypothesisRegistry(changed)).toThrow('integrity');
    const wrong = join(root, 'wrong.json');
    await writeFile(wrong, await readFile(a.path));
    await expect(verifyHypothesisRegistry(wrong)).rejects.toThrow('name');
    await writeFile(a.path, JSON.stringify(changed));
    await expect(
      writeHypothesisRegistry(f.input, f.request, root, 'synthetic:test'),
    ).rejects.toThrow();
  }, 30000);
  it('prints notebook-style reports with negative findings, uncertainty, first-seen quality and contradictions', async () => {
    const a = build(await setup()),
      report = hypothesisRegistryReport(a);
    for (const value of [
      'NEGATIVE_FINDING',
      'Confidence interval',
      'Contradictory examples',
      'DESCRIPTIVE_ONLY',
      'EXCHANGE_OUTAGE',
      'RATE_ANNOUNCEMENT',
      'LISTING',
      'not causal',
      'zero population uncertainty',
    ])
      expect(report).toContain(value);
  });
});
