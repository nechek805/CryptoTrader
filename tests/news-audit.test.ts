import { mkdtemp, readFile, writeFile, cp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { NewsAuditInputSchema, NewsEvaluationPlanSchema, MarketBarSchema } from '@crypto/contracts';
import type { NewsAuditInput, NewsEvaluationRow } from '@crypto/contracts';
import { canonicalHash, canonicalJson, utc, fromEpoch } from '@crypto/core';
import { buildNewsEventSnapshot, newsExtractionPrompt } from '@crypto/news';
import {
  trainNewsEdge,
  explainNewsDecision,
  explainNewsSignal,
  NewsSignalProvider,
  deriveNewsFreshness,
} from '@crypto/strategies';
import {
  newsAuditFixture,
  runNewsAudit,
  writeNewsAudit,
  verifyNewsAudit,
  newsAuditMarkdown,
  newsEvaluationUnits,
  replayNewsSignals,
} from '@crypto/backtest';
let f: NewsAuditInput,
  small: NewsAuditInput,
  full: Awaited<ReturnType<typeof runNewsAudit>>,
  root: string;
let bundle: Awaited<ReturnType<typeof writeNewsAudit>>;
const at = (s: number) => fromEpoch(1767225600n + BigInt(s), 'seconds');
function copy() {
  const v = structuredClone(small);
  v.model = small.model;
  return v;
}
const frame = (kind: string, second: number) =>
  full.report.frames.find(
    (r) =>
      r.caseId === `synthetic:${kind}` &&
      r.decision.candidate.decisionAt === at(second) &&
      r.decision.candidate.symbol === 'BTC/USDT',
  )!;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'crypto-news-audit-'));
  f = await newsAuditFixture('synthetic:test');
  full = await runNewsAudit(f, 'synthetic:test');
  const first = f.model.input.plan.hypotheses[0]!;
  const model = trainNewsEdge(
    {
      ...f.model.input,
      plan: {
        ...f.model.input.plan,
        hypotheses: [first],
        horizonsSeconds: [300],
        bootstrapSamples: 200,
      },
    },
    'synthetic:test',
  );
  const requests = f.evaluation.requests
      .filter((r) => r.request.hypothesisId === first.id)
      .slice(0, 3),
    ids = new Set(requests.map((r) => r.observationId));
  const c = f.rules.cases.find((c) => c.id === 'synthetic:CONTRADICTED')!;
  small = NewsAuditInputSchema.parse({
    ...f,
    model,
    rules: {
      ...f.rules,
      config: { ...f.rules.config, symbols: [f.rules.config.symbols[0]!] },
      cases: [{ ...c, decisionTimes: [at(123), at(183)] }],
    },
    evaluation: {
      ...f.evaluation,
      plan: { ...f.evaluation.plan, opportunityIds: [...ids], bootstrapSamples: 200 },
      requests,
      dataset: {
        ...f.evaluation.dataset,
        observations: f.evaluation.dataset.observations.filter((o) => ids.has(o.id)),
        newsSnapshots: [requests[0]!.request.snapshot],
        marketBars: f.evaluation.dataset.marketBars.filter((b) => b.id.includes(':incident:')),
      },
    },
  });
  small.model = model;
  bundle = await writeNewsAudit(small, join(root, 'a'), 'synthetic:test');
}, 240000);
afterAll(async () => {
  if (
    dirname(resolve(root)) !== resolve(tmpdir()) ||
    !basename(root).startsWith('crypto-news-audit-')
  )
    throw new Error('Unsafe test cleanup');
  await rm(root, { recursive: true, force: true });
});
describe('grounded explanations and adversarial replay', () => {
  it('retains all ten source-backed adversarial cases and twelve later opportunities', () => {
    expect(f.rules.cases).toHaveLength(10);
    expect(full.report.adversarial.decisions).toHaveLength(180);
    expect(full.report.frames).toHaveLength(192);
    expect(full.report.evaluation.rows).toHaveLength(12);
    expect(full.report.execution).toBe('DISABLED');
    expect(full.snapshots.size).toBe(102);
  });
  it('instruction-like text is quarantined rather than becoming a producer command', () => {
    const rows = full.report.frames.filter((r) => r.caseId === 'synthetic:INJECTION');
    expect(rows.every((r) => r.decision.candidate.side === 'HOLD')).toBe(true);
    const receipts = rows.flatMap((r) => r.explanation.sourceReceipts);
    expect(receipts.some((r) => r.quotedText.includes('Ignore previous'))).toBe(true);
    expect(receipts.some((r) => r.reviewReasons.includes('INSTRUCTION_LIKE_TEXT'))).toBe(true);
    expect(rows.every((r) => r.explanation.claims.length === 0)).toBe(true);
    expect(f.rules.config).toEqual(full.report.adversarial.manifest.config);
  });
  it('fake official-looking messages and altered publication timestamps abstain', () => {
    for (const kind of ['FAKE', 'ALTERED_TIMESTAMP'])
      expect(
        full.report.frames
          .filter((r) => r.caseId === `synthetic:${kind}`)
          .every((r) => r.decision.candidate.side === 'HOLD'),
      ).toBe(true);
    expect(
      frame('ALTERED_TIMESTAMP', 123).explanation.sourceReceipts.some(
        (r) => r.effectivePublishedAt !== null && r.effectivePublishedAt < r.firstObservedAt,
      ),
    ).toBe(true);
  });
  it('new contradiction changes a later decision and exposes the opposing claim', () => {
    expect(frame('CONTRADICTED', 123).decision.candidate.side).toBe('SHORT');
    expect(frame('CONTRADICTED', 183).decision.candidate.side).toBe('HOLD');
    expect(frame('CONTRADICTED', 183).explanation.contradictoryClaimIds.length).toBeGreaterThan(0);
    expect(frame('CONTRADICTED', 123).explanation.contradictoryClaimIds).toHaveLength(0);
  });
  it('retraction is prospective and retains rescinded source evidence', () => {
    expect(frame('RESCINDED', 123).decision.candidate.side).toBe('SHORT');
    expect(frame('RESCINDED', 183).decision.candidate.side).toBe('HOLD');
    expect(frame('RESCINDED', 183).explanation.retractedClaimIds).toHaveLength(2);
    expect(frame('RESCINDED', 183).explanation.sourceReceipts).toHaveLength(2);
  });
  it('future denial cannot rewrite any earlier candidate or explanation', async () => {
    const c = f.rules.cases.find((c) => c.id === 'synthetic:CONTRADICTED')!,
      s = c.snapshot;
    const prefix = buildNewsEventSnapshot(
      s.graphConfig,
      s.input.graphRecords,
      s.input.metadataRecords,
      s.config,
      { decisionAt: at(153), generatedAt: at(153) },
      s.codeVersion,
    );
    const r = await replayNewsSignals(
      {
        ...f.rules,
        cases: [
          { ...c, snapshot: prefix, decisionTimes: c.decisionTimes.filter((t) => t <= at(153)) },
        ],
      },
      'synthetic:test',
    );
    expect(r.decisions.map((r) => r.decision)).toEqual(
      full.report.frames
        .filter((r) => r.caseId === c.id && r.decision.candidate.decisionAt <= at(153))
        .map((r) => r.decision),
    );
  }, 30000);
  it('every explanation binds its exact source prefix, receipts and immutable candidate', () => {
    for (const r of full.report.frames) {
      expect(r.explanation.decisionId).toBe(r.decision.candidate.id);
      expect(r.explanation.snapshotHash).toBe(r.decision.opinion.snapshotHash);
      expect(full.snapshots.has(r.explanation.snapshotHash)).toBe(true);
      expect(
        r.explanation.sourceReceipts.every((s) => s.extractionKnownAt <= r.explanation.decisionAt),
      ).toBe(true);
      expect(r.explanation.sourceTextPolicy).toBe('UNTRUSTED_QUOTED_DATA_NEVER_INSTRUCTIONS');
    }
  });
  it('explains independent sources, event age, uncertainty, costs and prior comparisons', () => {
    const r = full.report.frames.find((r) => r.prediction !== null)!;
    expect(r.explanation.independentSourceIds).toHaveLength(2);
    expect(r.explanation.eventAgeSeconds).toBe(60);
    expect(r.explanation.priorSimilarEvents.prediction?.trainingUnits).toBe(6);
    expect(r.explanation.priorSimilarEvents.prediction?.validationUnits).toBe(3);
    expect(r.explanation.costs).toMatchObject({
      roundTripCostBps: 10,
      uncertaintyBufferBps: 25,
      stops: null,
      fillPrice: null,
    });
    expect(r.explanation.priorSimilarEvents.prediction?.eventTruthProbability).toBeNull();
    expect(Object.isFrozen(r.explanation)).toBe(true);
  });
  it('does not attach future statistical estimates to the earlier untrained rules', () => {
    expect(frame('CONFIRMED', 123).explanation.priorSimilarEvents).toEqual({
      status: 'UNTRAINED_RULE',
      prediction: null,
    });
    expect(frame('CONFIRMED', 123).explanation.costs.stops).toBeNull();
  });
  it('the public explanation wrapper regenerates a canonical decision', () => {
    const c = f.rules.cases.find((c) => c.id === 'synthetic:CONFIRMED')!,
      p = new NewsSignalProvider(f.rules.config, c.snapshot, 'synthetic:explain'),
      source = c.sources[0]!;
    const query = {
      schemaVersion: 'news-signal-query.v1',
      decisionAt: at(123),
      eventId: p.snapshotAt(at(123)).view.events[0]!.identity.id,
      symbol: 'BTC/USDT',
      freshness: deriveNewsFreshness({
        schemaVersion: 'news-freshness-request.v1',
        source,
        bars: c.bars,
        decisionAt: at(123),
        maximumAgeSeconds: 60,
      }),
    };
    const result = explainNewsSignal(
      {
        schemaVersion: 'news-explain-request.v1',
        snapshot: c.snapshot,
        config: f.rules.config,
        query,
        roundTripCostBps: 10,
      },
      'synthetic:explain',
    );
    expect(result.decision).toEqual(p.evaluate(query, p.initialState()).decision);
    expect(result.explanation.decisionId).toBe(result.decision.candidate.id);
  }, 30000);
  it('refuses an explanation bound to another snapshot', () => {
    const r = frame('CONFIRMED', 123),
      bad = {
        ...r.decision,
        opinion: { ...r.decision.opinion, snapshotHash: canonicalHash('foreign') },
      };
    expect(() =>
      explainNewsDecision({
        snapshot: full.snapshots.get(r.explanation.snapshotHash),
        decision: bad,
        prediction: null,
        roundTripCostBps: 10,
        uncertaintyBufferBps: 0,
      }),
    ).toThrow(/prefix/);
  });
  it('escapes quoted HTML and Markdown so source text cannot create links or executable markup', () => {
    const report = structuredClone(bundle.report),
      s = report.frames[0]!.explanation.sourceReceipts[0]!;
    s.quotedText =
      '<script>alert(1)</script> ![remote](https://bad.example.invalid/x) [tool](javascript:run)';
    const text = newsAuditMarkdown(report);
    expect(text).not.toContain('<script>');
    expect(text).not.toContain('![remote]');
    expect(text).not.toContain('[tool]');
    expect(text).toContain('&lt;script&gt;');
  });
  it('archives exact extraction prompts, model identities, article costs and deterministic fallback', () => {
    expect(full.extractionArchive.rows).toHaveLength(108);
    for (const row of full.extractionArchive.rows) {
      expect(row.exactPrompt).toBe(newsExtractionPrompt.instructions);
      expect(row.promptHash).toBe(canonicalHash(newsExtractionPrompt));
      expect(row.costStatus).toBe('ZERO_EXTERNAL_COST');
      expect(row.amountUsd).toBe('0');
      expect(row.fallback).toBe('literal-news-grammar.v1');
    }
    expect(full.handoff).toMatchObject({
      target: 'MODULE_11_ITERATION_1',
      execution: 'DISABLED',
      defaultAction: 'HOLD',
      promotion: 'NOT_AUTHORIZED',
    });
  });
});

describe('frozen later-period incremental value and retained negative findings', () => {
  it('measures every predeclared opportunity with common coverage and six day blocks', () => {
    expect(full.report.evaluation.opportunityCount).toBe(12);
    expect(full.report.evaluation.measuredCount).toBe(12);
    expect(full.report.evaluation.independentUnits).toBe(6);
    expect(full.report.evaluation.unitMembers.every((g) => g.length === 2)).toBe(true);
    expect(full.report.evaluation.assessment).toBe('SYNTHETIC_ONLY');
  });
  it('keeps both false positives and hindsight missed-event examples', () => {
    expect(full.report.evaluation.falsePositives).toHaveLength(4);
    expect(full.report.evaluation.missedEvents).toHaveLength(6);
    expect(
      full.report.evaluation.rows.every(
        (r) => r.outcomeKnowledge === 'HINDSIGHT_PRICE_OUTCOME_NOT_EVENT_TRUTH',
      ),
    ).toBe(true);
  });
  it('already-priced-in news is retained as an admitted zero-edge false positive', () => {
    const rows = full.report.evaluation.rows.filter((r) => r.observationId.endsWith(':12'));
    expect(rows).toHaveLength(2);
    expect(
      rows.every(
        (r) =>
          r.grossReturn === '0' &&
          r.newsMarkout === '-0.001' &&
          r.outcomeClass === 'FALSE_POSITIVE',
      ),
    ).toBe(true);
  });
  it('cash, always-long and news use the same costs and opportunities', () => {
    for (const row of full.report.evaluation.rows) {
      expect(row.cashMarkout).toBe('0');
      expect(Number(row.longMarkout)).toBeCloseTo(Number(row.grossReturn) - 0.001);
      if (row.side === 'HOLD') expect(row.newsMarkout).toBe('0');
    }
    expect(Number(full.report.evaluation.comparisons[0]!.meanDelta)).toBeLessThan(0);
    expect(Number(full.report.evaluation.comparisons[1]!.meanDelta)).toBeGreaterThan(0);
    expect(
      full.report.evaluation.comparisons.every(
        (c) => Number(c.interval!.lower) < 0 && Number(c.interval!.upper) > 0,
      ),
    ).toBe(true);
  });
  it('TEST outcomes cannot change model estimates or producer decisions', async () => {
    const v = copy();
    v.evaluation.dataset.marketBars = v.evaluation.dataset.marketBars.map((b) =>
      b.closeAt >= v.evaluation.plan.from && b.id.includes(':event:') && b.id.endsWith(':5')
        ? MarketBarSchema.parse({
            ...b,
            open: '100',
            high: '200',
            low: '100',
            close: '200',
            provenance: {
              ...b.provenance,
              parentIds: [canonicalHash({ test: 'synthetic-outcome-shock', id: b.id })],
            },
          })
        : b,
    );
    const r = await runNewsAudit(v, 'synthetic:test'),
      before = bundle.report.frames.filter((r) => r.prediction !== null);
    expect(r.report.modelHash).toBe(bundle.report.modelHash);
    expect(r.report.frames.filter((r) => r.prediction !== null)).toEqual(before);
    expect(r.report.evaluation.rows).not.toEqual(bundle.report.evaluation.rows);
  }, 60000);
  it('missing TEST prices remain unmeasured for all paired comparisons', async () => {
    const v = copy(),
      id = v.evaluation.requests[0]!.observationId.split(':').at(-1)!;
    v.evaluation.dataset.marketBars = v.evaluation.dataset.marketBars.filter(
      (b) => !(b.id.includes(`:incident:${id}:event:BTC:`) && b.id.endsWith(':5')),
    );
    const r = (await runNewsAudit(v, 'synthetic:test')).report.evaluation;
    expect(r.measuredCount).toBe(2);
    expect(r.rows.find((r) => r.status === 'MISSING_PRICES')).toMatchObject({
      newsMarkout: null,
      longMarkout: null,
      cashMarkout: null,
      outcomeClass: 'UNMEASURED',
    });
    expect(r.comparisons.every((c) => c.interval === null)).toBe(true);
  }, 60000);
  it('refuses to drop a declared opportunity from the request set', async () => {
    const v = copy();
    v.evaluation.requests.pop();
    await expect(runNewsAudit(v, 'synthetic:test')).rejects.toThrow(/opportunity/);
  }, 60000);
  it('refuses duplicate event opportunities under new observation IDs', async () => {
    const v = copy(),
      first = v.evaluation.requests[0]!,
      duplicate = { ...first, observationId: 'synthetic:duplicate' };
    v.evaluation.requests.push(duplicate);
    v.evaluation.plan.opportunityIds.push(duplicate.observationId);
    const observation = v.evaluation.dataset.observations[0]!;
    v.evaluation.dataset.observations.push({ ...observation, id: duplicate.observationId });
    await expect(runNewsAudit(v, 'synthetic:test')).rejects.toThrow(/Duplicate TEST/);
  }, 60000);
  it('rejects a retrospective test freeze or cost assumption below the model floor', async () => {
    const v = copy();
    v.evaluation.plan.declaredAt = utc('2026-01-25T00:00:00Z');
    await expect(runNewsAudit(v, 'synthetic:test')).rejects.toThrow(/vintage/);
    v.evaluation.plan.declaredAt = small.evaluation.plan.declaredAt;
    v.evaluation.plan.roundTripCostBps = 0;
    await expect(runNewsAudit(v, 'synthetic:test')).rejects.toThrow(/cost floor/);
  }, 60000);
  it('rejects a changed fixed horizon, query binding or request cost', async () => {
    for (const mode of ['horizon', 'cost', 'event']) {
      const v = copy();
      if (mode === 'horizon') v.evaluation.plan.horizonSeconds = 60;
      else if (mode === 'cost') v.evaluation.requests[0]!.request.roundTripCostBps = 11;
      else v.evaluation.requests[0]!.request.query.eventId = 'synthetic:foreign';
      await expect(runNewsAudit(v, 'synthetic:test')).rejects.toThrow(/binding/);
    }
  }, 60000);
  it('rejects caller-supplied admission state that could reset cohort history', async () => {
    const v = copy(),
      r = v.evaluation.requests[0]!.request;
    const p = new NewsSignalProvider(v.model.input.plan.admission, r.snapshot, 'synthetic:foreign');
    r.state = p.initialState();
    await expect(runNewsAudit(v, 'synthetic:test')).rejects.toThrow(/binding/);
  }, 60000);
  it('source bytes and event observations must match the frozen declared request', async () => {
    const v = copy();
    v.evaluation.requests[0]!.request.snapshot = v.rules.cases[0]!.snapshot;
    await expect(runNewsAudit(v, 'synthetic:test')).rejects.toThrow(/binding/);
  }, 60000);
  it('groups shared lineage, shared prices and same-day outcomes into one unit', () => {
    const r = full.report.evaluation.rows[0]!;
    for (const key of ['lineageIds', 'barIds'] as const) {
      const rows = [
        r,
        {
          ...r,
          observationId: 'synthetic:other',
          decisionAt: utc('2026-02-20T09:00:00Z'),
          endAt: utc('2026-02-20T09:05:00Z'),
          lineageIds: ['synthetic:other'],
          barIds: ['synthetic:other'],
          [key]: r[key],
        },
      ];
      expect(newsEvaluationUnits(rows)).toHaveLength(1);
    }
    const sameDay: NewsEvaluationRow = {
      ...r,
      observationId: 'synthetic:same-day',
      decisionAt: utc('2026-01-28T20:00:00Z'),
      endAt: utc('2026-01-28T20:05:00Z'),
      lineageIds: [],
      barIds: [],
    };
    expect(newsEvaluationUnits([{ ...r, lineageIds: [], barIds: [] }, sameDay])).toHaveLength(1);
  });
  it('strict plans reject duplicate IDs, unsupported baselines and negative costs', () => {
    expect(
      NewsEvaluationPlanSchema.safeParse({
        ...small.evaluation.plan,
        opportunityIds: ['same', 'same'],
      }).success,
    ).toBe(false);
    expect(
      NewsEvaluationPlanSchema.safeParse({
        ...small.evaluation.plan,
        baseline: 'CHOOSE_BEST_AFTER_TEST',
      }).success,
    ).toBe(false);
    expect(
      NewsEvaluationPlanSchema.safeParse({ ...small.evaluation.plan, roundTripCostBps: -1 })
        .success,
    ).toBe(false);
  });
});

describe('immutable explanation/evaluation bundles and handoff', () => {
  it('semantically verifies the explanation, price evaluation, archive and journal', async () => {
    expect((await verifyNewsAudit(bundle.directory)).hash).toBe(bundle.hash);
  }, 60000);
  it('independent roots reproduce every indexed byte and support immutable reuse', async () => {
    const other = await writeNewsAudit(small, join(root, 'b'), 'synthetic:test');
    const reused = await writeNewsAudit(small, join(root, 'a'), 'synthetic:test');
    expect(reused.directory).toBe(bundle.directory);
    for (const file of ['bundle.json', ...Object.keys(bundle.metadata.files)])
      expect(await readFile(join(other.directory, file))).toEqual(
        await readFile(join(bundle.directory, file)),
      );
    expect((await readdir(join(root, 'a'))).some((n) => n.startsWith('.news-audit-stage-'))).toBe(
      false,
    );
  }, 120000);
  it.each(['report.md', 'decisions.jsonl', 'extractions.json', 'handoff.json', 'snapshot'])(
    'rejects forged %s even with repaired file checksums',
    async (kind) => {
      const directory = join(
        root,
        `tamper-${kind.replaceAll('.', '-')}`,
        basename(bundle.directory),
      );
      await cp(bundle.directory, directory, { recursive: true });
      const metadata = structuredClone(bundle.metadata),
        file =
          kind === 'snapshot'
            ? Object.keys(metadata.files).find((f) => f.startsWith('snapshots/'))!
            : kind;
      const text = `${await readFile(join(directory, file), 'utf8')} `;
      await writeFile(join(directory, file), text);
      metadata.files[file] = `sha256:${createHash('sha256').update(text).digest('hex')}`;
      await writeFile(join(directory, 'bundle.json'), canonicalJson(metadata));
      await expect(verifyNewsAudit(directory)).rejects.toThrow(/semantic/);
    },
    60000,
  );
  it('fails before publication on invalid chronology', async () => {
    const v = copy();
    v.evaluation.plan.from = v.evaluation.plan.to;
    await expect(writeNewsAudit(v, join(root, 'invalid'), 'synthetic:test')).rejects.toThrow();
    expect(await readdir(root)).not.toContain('invalid');
  });
  it.each([['fixture', '--live', 'true'], ['run'], ['fixture', '--out', 'a', '--out', 'b']])(
    'CLI refuses unsupported or missing options %j',
    (...args) => {
      const r = spawnSync(
        process.execPath,
        ['--import', 'tsx', 'apps/cli/src/news-audit.ts', ...args],
        { encoding: 'utf8' },
      );
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('News audit failed');
    },
  );
});
