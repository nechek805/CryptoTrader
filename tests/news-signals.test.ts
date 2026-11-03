import { mkdtemp, readFile, writeFile, rm, cp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { NewsSignalConfigSchema, NewsSignalManifestSchema } from '@crypto/contracts';
import type { NewsSignalManifest, NewsSignalReport } from '@crypto/contracts';
import { canonicalHash, canonicalJson, fromEpoch } from '@crypto/core';
import { buildNewsEventSnapshot } from '@crypto/news';
import { NewsSignalProvider, deriveNewsFreshness } from '@crypto/strategies';
import {
  newsSignalFixture,
  replayNewsSignals,
  writeNewsSignals,
  verifyNewsSignals,
} from '@crypto/backtest';

const at = (s: number) => fromEpoch(1767225600n + BigInt(s), 'seconds');
let f: NewsSignalManifest, report: NewsSignalReport, root: string;
let bundle: Awaited<ReturnType<typeof writeNewsSignals>>;
const scenario = (id = 'CONFIRMED') => f.cases.find((c) => c.id === `synthetic:${id}`)!;
function provider(id = 'CONFIRMED', config: unknown = f.config) {
  return new NewsSignalProvider(config, scenario(id).snapshot, 'synthetic:test');
}
function guard(id = 'CONFIRMED', seconds = 123, symbol = 'BTC/USDT') {
  const c = scenario(id);
  return deriveNewsFreshness({
    schemaVersion: 'news-freshness-request.v1',
    source: c.sources.find((s) => s.series.instrumentId === symbol),
    bars: c.bars,
    decisionAt: at(seconds),
    maximumAgeSeconds: 60,
  });
}
function query(
  p: InstanceType<typeof NewsSignalProvider>,
  seconds = 123,
  id = 'CONFIRMED',
  symbol = 'BTC/USDT',
) {
  return {
    schemaVersion: 'news-signal-query.v1',
    decisionAt: at(seconds),
    symbol,
    eventId: p.snapshotAt(at(seconds)).view.events[0]?.identity.id ?? null,
    freshness: guard(id, seconds, symbol),
  };
}
function evaluate(id = 'CONFIRMED', seconds = 123, config: unknown = f.config) {
  const p = provider(id, config);
  return p.evaluate(query(p, seconds, id), p.initialState());
}
const row = (id: string, seconds: number, symbol = 'BTC/USDT') =>
  report.decisions.find(
    (r) =>
      r.caseId === `synthetic:${id}` &&
      r.decision.candidate.decisionAt === at(seconds) &&
      r.decision.candidate.symbol === symbol,
  )!.decision;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'crypto-news-signals-'));
  f = await newsSignalFixture();
  report = await replayNewsSignals(f, 'synthetic:test');
  const small = {
    ...f,
    config: { ...f.config, symbols: [f.config.symbols[0]!] },
    cases: [{ ...scenario(), decisionTimes: [122, 123, 153, 183].map(at) }],
  };
  bundle = await writeNewsSignals(small, join(root, 'a'), 'synthetic:test');
}, 60000);
afterAll(async () => {
  if (
    dirname(resolve(root)) !== resolve(tmpdir()) ||
    !basename(root).startsWith('crypto-news-signals-')
  )
    throw new Error('Unsafe fixture cleanup');
  await rm(root, { recursive: true, force: true });
});

describe('conservative news rules and point-in-time admission', () => {
  it('replays eight explicitly synthetic scenarios with execution disabled', () => {
    expect(f.cases).toHaveLength(8);
    expect(report.execution).toBe('DISABLED');
    expect(report.decisions).toHaveLength(144);
    expect(report.snapshotHashes).toHaveLength(72);
    expect(report.counts).toEqual({ long: 2, short: 3, hold: 139 });
  });
  it('ten syndicated copies retain one origin, grade and material opinion', () => {
    const a = row('PARTIAL_COPIES', 63),
      b = row('PARTIAL_COPIES', 123);
    expect(a.opinion.independentOrigins).toBe(1);
    expect(b.opinion.independentOrigins).toBe(1);
    expect(b.opinion.supportGrade).toBe(a.opinion.supportGrade);
    expect(b.opinion.materialHash).toBe(a.opinion.materialHash);
    expect(b.candidate.side).toBe('HOLD');
    expect(b.opinion.sourceIds).toHaveLength(11);
  });
  it('late independent confirmation only permits a later candidate', () => {
    expect(row('CONFIRMED', 122).candidate.side).toBe('HOLD');
    expect(row('CONFIRMED', 122).opinion.independentOrigins).toBe(1);
    expect(row('CONFIRMED', 123).candidate.side).toBe('SHORT');
    expect(row('CONFIRMED', 123).opinion.independentOrigins).toBe(2);
    expect(row('CONFIRMED', 122).opinion.evidenceIds).not.toContain(
      row('CONFIRMED', 123).opinion.representativeRootIds.find(
        (id) => !row('CONFIRMED', 122).opinion.representativeRootIds.includes(id),
      ),
    );
  });
  it('retains fake official-looking reports and a denial as HOLD evidence', () => {
    const rows = report.decisions.filter((r) => r.caseId === 'synthetic:FAKE');
    expect(rows.every((r) => r.decision.candidate.side === 'HOLD')).toBe(true);
    expect(row('FAKE', 153).opinion.sourceIds).toHaveLength(12);
  });
  it('rescission changes only later decisions and retains withdrawal provenance', () => {
    expect(row('RESCINDED', 123).candidate.side).toBe('SHORT');
    expect(row('RESCINDED', 183).candidate.side).toBe('HOLD');
    expect(row('RESCINDED', 183).opinion.sourceIds).toHaveLength(2);
    expect(row('RESCINDED', 183).opinion.reasons.length).toBeGreaterThan(0);
  });
  it('emits conditional positive listing candidates', () => {
    expect(row('LISTING', 123).candidate.side).toBe('LONG');
    expect(row('LISTING', 153).candidate.side).toBe('LONG');
  });
  it('never upgrades unknown reliable availability', () => {
    const e = scenario('UNKNOWN_TIME').snapshot.view.events[0]!;
    expect(e.availableAt).toBeNull();
    expect(e.replayEligible).toBe(false);
    expect(
      report.decisions
        .filter((r) => r.caseId === 'synthetic:UNKNOWN_TIME')
        .every((r) => r.decision.candidate.side === 'HOLD'),
    ).toBe(true);
  });
  it('requires a direct curated asset mapping', () => {
    expect(row('CONFIRMED', 123, 'ETH/USDT').abstentionReasons).toContain(
      'NO_DIRECT_ASSET_MAPPING',
    );
    expect(row('CONFIRMED', 123, 'ETH/USDT').candidate.side).toBe('HOLD');
  });
  it('scheduled matching quantities abstain without a comparable mismatch', () => {
    expect(row('SCHEDULED', 123).opinion.surprise).toBe('SCHEDULED_MATCH');
    expect(row('SCHEDULED', 123).abstentionReasons).toContain('NO_COMPARABLE_EXPECTATION_MISMATCH');
  });
  it('stale prices veto a news opinion without changing its support or direction', () => {
    const d = row('STALE', 123);
    expect(d.opinion.conditionalSide).toBe('SHORT');
    expect(d.freshness.status).toBe('STALE');
    expect(d.candidate.side).toBe('HOLD');
    expect(d.abstentionReasons).toContain('OPERATIONAL_FRESHNESS_VETO');
  });
  it('a freshness veto does not consume a future opportunity', () => {
    const p = provider('STALE'),
      q = query(p, 123, 'STALE');
    const a = p.evaluate(q, p.initialState());
    expect(a.state.slots).toHaveLength(0);
    const b = p.evaluate({ ...q, freshness: guard('CONFIRMED') }, a.state);
    expect(b.decision.candidate.side).toBe('SHORT');
    expect(b.decision.opinion).toEqual(a.decision.opinion);
  });
  it('market price changes never reach directional rules or the freshness proof', () => {
    const c = scenario(),
      changed = c.bars.map((b) => ({ ...b, open: '200', high: '200', low: '200', close: '200' }));
    const receipt = deriveNewsFreshness({
      schemaVersion: 'news-freshness-request.v1',
      source: c.sources[0],
      bars: changed,
      decisionAt: at(123),
      maximumAgeSeconds: 60,
    });
    expect(receipt).toEqual(guard());
    expect(Object.keys(receipt)).not.toContain('close');
  });
  it('higher independent-origin requirements abstain', () => {
    expect(
      evaluate('CONFIRMED', 123, { ...f.config, minimumIndependentOrigins: 3 }).decision.candidate
        .side,
    ).toBe('HOLD');
  });
  it('reported severity below the declared threshold abstains', () => {
    const config = {
      ...f.config,
      rules: f.config.rules.map((r) => ({
        ...r,
        minimumReportedAmount: { value: '3000000', unit: 'USD' },
      })),
    };
    expect(evaluate('CONFIRMED', 123, config).decision.opinion.severity).toBe('BELOW_THRESHOLD');
    expect(evaluate('CONFIRMED', 123, config).decision.candidate.side).toBe('HOLD');
  });
  it('incomparable amount units remain unknown', () => {
    const config = {
      ...f.config,
      rules: f.config.rules.map((r) => ({
        ...r,
        minimumReportedAmount: { value: '1', unit: 'EUR' },
      })),
    };
    expect(evaluate('CONFIRMED', 123, config).decision.opinion.severity).toBe('UNKNOWN');
  });
  it('excessive publication-to-first-known lag abstains', () => {
    const d = evaluate('CONFIRMED', 123, { ...f.config, maximumReceiptLagSeconds: 2 }).decision;
    expect(d.opinion.maximumObservedPublicationDelaySeconds).toBe(3);
    expect(d.abstentionReasons).toContain('FIRST_KNOWN_PUBLICATION_LAG_EXCEEDED');
  });
  it('candidate horizons shrink from first-known time rather than resetting on updates', () => {
    const a = row('CONFIRMED', 123).candidate,
      b = row('CONFIRMED', 153).candidate;
    expect(a.validUntil).toBe(at(963));
    expect(b.validUntil).toBe(a.validUntil);
    expect(a.horizon.value).toBe(840);
    expect(b.horizon.value).toBe(810);
  });
  it('expired event horizons abstain even with fresh bars', () => {
    const config = {
      ...f.config,
      rules: f.config.rules.map((r) => ({ ...r, horizonSeconds: 120 })),
    };
    expect(evaluate('CONFIRMED', 183, config).decision.abstentionReasons).toContain(
      'EVENT_HORIZON_EXPIRED',
    );
  });
  it('unchanged evidence cannot repeatedly re-arm a directional candidate', () => {
    const p = provider(),
      q = query(p),
      a = p.evaluate(q, p.initialState()),
      b = p.evaluate(q, a.state);
    expect(b.decision.candidate.side).toBe('HOLD');
    expect(b.decision.abstentionReasons).toContain('NO_NEW_INDEPENDENT_EVIDENCE');
    expect(p.evaluate(query(p, 153), b.state).decision.candidate.side).toBe('SHORT');
  });
  it('every decision links its exact prefix snapshot and preserves missing probabilities', () => {
    for (const r of report.decisions) {
      const d = r.decision;
      expect(d.candidate.rationaleIds).toContain(r.snapshotHash);
      expect(d.opinion.snapshotHash).toBe(r.snapshotHash);
      expect(report.snapshotHashes).toContain(r.snapshotHash);
      expect(d.candidate.score.status).toBe('MISSING');
      expect(d.candidate.calibration.status).toBe('MISSING');
      expect(d.candidate).not.toHaveProperty('stopLoss');
      if (d.opinion.maxInputKnownAt)
        expect(d.opinion.maxInputKnownAt <= d.candidate.decisionAt).toBe(true);
    }
  });
  it('future corpus additions preserve the entire earlier candidate identity', () => {
    const source = scenario().snapshot;
    const early = buildNewsEventSnapshot(
      source.graphConfig,
      source.input.graphRecords,
      source.input.metadataRecords,
      source.config,
      { decisionAt: at(122), generatedAt: at(122) },
      source.codeVersion,
    );
    const a = provider(),
      b = new NewsSignalProvider(f.config, early, 'synthetic:test');
    expect(a.evaluate(query(a, 122), a.initialState())).toEqual(
      b.evaluate(query(b, 122), b.initialState()),
    );
  });
  it('refuses future queries beyond the frozen source', () => {
    expect(() => provider().snapshotAt(at(1001))).toThrow(/cutoff/);
  });
  it('refuses backwards state clocks and foreign provider states', () => {
    const p = provider(),
      a = p.evaluate(query(p), p.initialState());
    expect(() => p.evaluate(query(p, 122), a.state)).toThrow(/clock/);
    expect(() =>
      p.evaluate(query(p), { ...p.initialState(), providerHash: canonicalHash('foreign') }),
    ).toThrow(/scope/);
  });
  it.each(['symbol', 'decisionAt', 'proofHash'] as const)('refuses altered freshness %s', (key) => {
    const p = provider(),
      q = query(p);
    const bad = {
      ...q.freshness,
      [key]:
        key === 'symbol' ? 'ETH/USDT' : key === 'decisionAt' ? at(124) : canonicalHash('altered'),
    };
    expect(() => p.evaluate({ ...q, freshness: bad }, p.initialState())).toThrow();
  });
  it('refuses future freshness timestamps even with a recomputed proof', () => {
    const p = provider(),
      q = query(p),
      { proofHash: _hash, ...body } = q.freshness;
    void _hash;
    const bad = { ...body, closeAt: at(124), availableAt: at(124) };
    expect(() =>
      p.evaluate({ ...q, freshness: { ...bad, proofHash: canonicalHash(bad) } }, p.initialState()),
    ).toThrow(/future/);
  });
  it('refuses semantically forged event views', () => {
    const bad = structuredClone(scenario().snapshot);
    bad.view.events[0]!.availableAt = null;
    expect(() => new NewsSignalProvider(f.config, bad, 'synthetic:test')).toThrow();
  });
  it('freezes returned decisions and state without mutating the input', () => {
    const p = provider(),
      state = p.initialState(),
      before = canonicalJson(state),
      result = p.evaluate(query(p), state);
    expect(canonicalJson(state)).toBe(before);
    expect(Object.isFrozen(result.state.slots)).toBe(true);
    expect(Object.isFrozen(result.decision.candidate)).toBe(true);
  });
  it('strict rules reject invented stops, probabilities and duplicate bindings', () => {
    expect(NewsSignalConfigSchema.safeParse({ ...f.config, stopLoss: '1' }).success).toBe(false);
    expect(
      NewsSignalConfigSchema.safeParse({
        ...f.config,
        rules: [{ ...f.config.rules[0], probability: 0.9 }],
      }).success,
    ).toBe(false);
    expect(
      NewsSignalConfigSchema.safeParse({
        ...f.config,
        symbols: [f.config.symbols[0], f.config.symbols[0]],
      }).success,
    ).toBe(false);
  });
  it('ambiguous market evidence is rejected rather than selected arbitrarily', () => {
    const c = scenario();
    expect(() =>
      deriveNewsFreshness({
        schemaVersion: 'news-freshness-request.v1',
        source: c.sources[0],
        bars: [...c.bars, c.bars[0]],
        decisionAt: at(123),
        maximumAgeSeconds: 60,
      }),
    ).toThrow(/Ambiguous/);
  });
});

describe('immutable news signal replay artifacts', () => {
  it('semantically verifies the journal, reports and every snapshot', async () => {
    const v = await verifyNewsSignals(bundle.directory);
    expect(v.hash).toBe(bundle.hash);
    expect(Object.isFrozen(v.report)).toBe(true);
  });
  it('independent roots produce byte-identical bundles and support immutable reuse', async () => {
    const b = await writeNewsSignals(bundle.report.manifest, join(root, 'b'), 'synthetic:test');
    const reused = await writeNewsSignals(
      bundle.report.manifest,
      join(root, 'a'),
      'synthetic:test',
    );
    expect(reused.directory).toBe(bundle.directory);
    for (const file of ['bundle.json', ...Object.keys(bundle.metadata.files)])
      expect(await readFile(join(b.directory, file))).toEqual(
        await readFile(join(bundle.directory, file)),
      );
    expect((await readdir(join(root, 'a'))).some((n) => n.startsWith('.news-signal-stage-'))).toBe(
      false,
    );
  });
  it.each(['report.md', 'decisions.jsonl', 'snapshot'])(
    'rejects forged %s even after checksum repair',
    async (kind) => {
      const directory = join(
        root,
        `tamper-${kind.replaceAll('.', '-')}`,
        basename(bundle.directory),
      );
      await cp(bundle.directory, directory, { recursive: true });
      const metadata = structuredClone(bundle.metadata);
      const file =
        kind === 'snapshot'
          ? Object.keys(metadata.files).find((n) => n.startsWith('snapshots/'))!
          : kind;
      const text = `${await readFile(join(directory, file), 'utf8')} `;
      await writeFile(join(directory, file), text);
      metadata.files[file] = `sha256:${createHash('sha256').update(text).digest('hex')}`;
      await writeFile(join(directory, 'bundle.json'), canonicalJson(metadata));
      await expect(verifyNewsSignals(directory)).rejects.toThrow(/semantic/);
    },
  );
  it('rejects duplicate or descending decision clocks before publishing', async () => {
    for (const decisionTimes of [
      [at(123), at(123)],
      [at(123), at(122)],
    ]) {
      await expect(
        writeNewsSignals(
          { ...f, cases: [{ ...scenario(), decisionTimes }] },
          join(root, 'invalid'),
          'synthetic:test',
        ),
      ).rejects.toThrow(/clock/);
    }
    expect(await readdir(root)).not.toContain('invalid');
  });
  it('requires explicit synthetic provenance and rejects an oversized manifest', async () => {
    const bad = structuredClone(bundle.report.manifest);
    bad.cases[0]!.bars[0]!.qualityFlags = [];
    await expect(replayNewsSignals(bad, 'synthetic:test')).rejects.toThrow(/synthetic/);
    expect(
      NewsSignalManifestSchema.safeParse({
        ...f,
        cases: Array.from({ length: 11 }, () => scenario()),
      }).success,
    ).toBe(false);
  });
  it('missing symbol/source binding yields HOLD rather than implicit data', async () => {
    const r = await replayNewsSignals(
      {
        ...f,
        cases: [{ ...scenario(), sources: [scenario().sources[1]!], decisionTimes: [at(123)] }],
      },
      'synthetic:test',
    );
    expect(r.decisions[0]!.decision.freshness.status).toBe('MISSING');
    expect(r.decisions[0]!.decision.candidate.side).toBe('HOLD');
  });
  it.each([['fixture', '--live', 'true'], ['run'], ['fixture', '--out', 'a', '--out', 'b']])(
    'CLI refuses unsupported or incomplete options %j',
    (...args) => {
      const r = spawnSync(
        process.execPath,
        ['--import', 'tsx', 'apps/cli/src/news-signal.ts', ...args],
        { encoding: 'utf8' },
      );
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('News signal replay failed');
    },
  );
});
