import { mkdtemp, readFile, writeFile, rm, readdir, rename } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { beforeAll, afterEach, describe, it, expect } from 'vitest';
import {
  DatasetPanelRequestSchema,
  DatasetPanelRowSchema,
  utcNanoseconds,
} from '@crypto/contracts';
import { canonicalHash, decimal, fromEpoch, canonicalJson, deterministicId } from '@crypto/core';
import { byteHash } from '@crypto/connectors';
import { DuckDBInstance } from '@duckdb/node-api';
import {
  datasetPanelFixture,
  buildDatasetPanel,
  buildTechnicalFeatureArtifact,
  auditDatasetFeatures,
  validateDatasetPanelArtifact,
  writeDatasetPanel,
  verifyDatasetPanel,
  readDatasetPanel,
  datasetPanelReport,
} from '@crypto/research';

const at = (s: number) => fromEpoch(1767225600n + BigInt(s), 'seconds'),
  key = 'cross:SPOT:ETH',
  dirs: string[] = [];
let fixture: ReturnType<typeof datasetPanelFixture>, panel: ReturnType<typeof buildDatasetPanel>;
beforeAll(() => {
  fixture = datasetPanelFixture();
  panel = buildDatasetPanel(fixture.input, fixture.request, 'synthetic:test');
});
afterEach(async () => {
  for (const d of dirs.splice(0)) {
    if (dirname(resolve(d)) !== resolve(tmpdir()) || !basename(d).startsWith('crypto-panel-'))
      throw new Error('Unsafe cleanup');
    await rm(d, { recursive: true, force: true });
  }
});
async function temp() {
  const d = await mkdtemp(join(tmpdir(), 'crypto-panel-'));
  dirs.push(d);
  return d;
}
function small() {
  const f = structuredClone(fixture);
  f.input.crossArtifacts = [];
  f.input.technicalArtifacts = f.input.technicalArtifacts.filter(
    (a) => a.request.series.asset === 'ETH',
  );
  f.request.instrumentKeys = [key];
  f.request.columns = ['technical.sma'];
  return f;
}
type Fixture = ReturnType<typeof small>;
const run = (f: Fixture) => buildDatasetPanel(f.input, f.request, 'synthetic:test');
const row = (a: typeof panel, s: number, k = key) =>
  a.rows.find((r) => r.instrumentKey === k && r.featureAsOf === at(s))!;
function rebuild(f: Fixture, edit: (a: Fixture['input']['technicalArtifacts'][number]) => void) {
  f.input.technicalArtifacts = f.input.technicalArtifacts.map((old) => {
    const a = structuredClone(old);
    edit(a);
    return buildTechnicalFeatureArtifact(a.input, a.request, a.codeVersion);
  });
}

describe('reproducible research panels and leakage audits', () => {
  it('constructs nonempty chronological splits and exact hand-calculated forward targets', () => {
    expect(panel.audit.splits.map((s) => s.included)).toEqual([2, 2, 3]);
    const r = row(panel, 150);
    expect(r.status).toBe('INCLUDED');
    expect(r.features.find((f) => f.name === 'technical.sma')!.value).toBe('50.5');
    expect(r.labels[0]!.value).toBe('0.019607843137254901960784313725490196');
    expect(r.labels[1]!.value).toBe('0.039215686274509803921568627450980392');
    expect(r.maxInputAvailableAt).toBe(at(120));
    expect(r.labels[1]!.availableAt).toBe(at(260));
  });
  it('lists only point-in-time predictor watermarks, with label timing separate', () => {
    for (const r of panel.rows) {
      expect(r.maxInputAvailableAt! <= r.featureAsOf).toBe(true);
      expect(r.maxInputEventAt! <= r.featureAsOf).toBe(true);
      for (const f of r.features) {
        expect(f.maxInputAvailableAt === null || f.maxInputAvailableAt <= r.featureAsOf).toBe(true);
        expect(f.dependency).toBe('MARKET');
      }
    }
    for (const r of panel.rows.filter((r) => r.status === 'INCLUDED'))
      expect(r.labels.every((l) => l.endAt! > r.featureAsOf)).toBe(true);
  });
  it('detects an intentional future label feature despite forged old watermarks', () => {
    expect(panel.audit.leakage.map((i) => i.reason).sort()).toEqual([
      'FUTURE_INPUT',
      'LABEL_DEPENDENCY',
      'UNREGISTERED_SOURCE',
      'WATERMARK_UNDERSTATED',
    ]);
    expect(
      panel.rows.every((r) => r.features.every((f) => f.name !== 'proposed.future_close')),
    ).toBe(true);
    expect(panel.audit.includedCount).toBe(7);
  });
  it('audits unknown evidence and declared future clocks through the public schema', () => {
    const proposal = structuredClone(fixture.input.proposedFeatures[0]!);
    proposal.features[0]!.inputBarIds = ['unknown:bar'];
    proposal.features[0]!.maxInputAvailableAt = at(151);
    const issues = auditDatasetFeatures(proposal, []);
    expect(issues.map((i) => i.reason)).toContain('UNKNOWN_EVIDENCE');
    expect(issues.map((i) => i.reason)).toContain('FUTURE_INPUT');
    expect(() => auditDatasetFeatures({ ...proposal, execute: true }, [])).toThrow();
  });
  it('purges label support globally across different symbols and group revisions', () => {
    for (const k of [key, 'cross:SPOT:SOL']) {
      expect(row(panel, 180, k).status).toBe('PURGED');
      expect(row(panel, 360, k).status).toBe('PURGED');
    }
    for (const r of panel.rows.filter((r) => r.status === 'INCLUDED' && r.split !== 'TEST')) {
      const next =
        r.split === 'TRAIN'
          ? fixture.request.splits.validation.from
          : fixture.request.splits.test.from;
      expect(
        r.labels.every((l) => l.endAt! < next && l.decisionAt! < next && l.availableAt! < next),
      ).toBe(true);
    }
  });
  it('excludes boundary touch and labels whose fixed observation window matures at holdout', () => {
    const f = small();
    f.request.splits.train.to = at(260);
    f.request.splits.validation.from = at(260);
    expect(row(run(f), 150).status).toBe('PURGED');
    f.request.splits.train.to = at(261);
    f.request.splits.validation.from = at(261);
    expect(row(run(f), 150).status).toBe('INCLUDED');
  });
  it('applies half-open post-boundary embargo on validation and test', () => {
    const a = run(small());
    expect(row(a, 300).status).toBe('EMBARGOED');
    expect(row(a, 330).status).toBe('INCLUDED');
    expect(row(a, 480).status).toBe('EMBARGOED');
    expect(row(a, 510).status).toBe('INCLUDED');
  });
  it('preserves a one-nanosecond embargo boundary', () => {
    const f = small();
    f.request.splits.validation.from = fromEpoch(utcNanoseconds(at(300)) + 1n, 'nanoseconds');
    expect(row(run(f), 330).status).toBe('EMBARGOED');
    f.request.splits.validation.from = at(300);
    expect(row(run(f), 330).status).toBe('INCLUDED');
  });
  it('refuses conflicting raw evidence in the standalone leakage audit', () => {
    const b = fixture.input.technicalArtifacts[0]!.input.bars[0]!,
      changed = { ...b, volume: decimal('11') };
    expect(() => auditDatasetFeatures(fixture.input.proposedFeatures, [b, changed])).toThrow(
      'Conflicting audit evidence',
    );
  });
  it('requires technical evidence to name the explicitly bound source', () => {
    const f = small();
    rebuild(f, (a) => {
      for (const b of a.input.bars.filter((b) => b.instrumentId === 'ETH/USDT'))
        b.provenance.sourceIds = ['synthetic:other-source'];
    });
    expect(row(run(f), 150).reasons).toContain('HISTORICAL_INPUT_METADATA');
    expect(run(f).audit.includedCount).toBe(0);
  });
  it('rejects unknown and execution-related CLI flags before any artifact work', () => {
    for (const args of [
      ['dataset-fixture', '--execute', 'true'],
      ['dataset-view', '--directory', 'missing', '--split', 'TRAIN', '--private-key', 'forbidden'],
      ['dataset-build', '--input', 'missing'],
    ]) {
      const p = spawnSync(
        process.execPath,
        ['--import', 'tsx', 'apps/cli/src/features.ts', ...args],
        { cwd: process.cwd(), encoding: 'utf8', timeout: 15000 },
      );
      expect(p.status).toBe(1);
      expect(p.stdout).toBe('');
      expect(p.stderr).not.toContain('forbidden');
    }
  }, 30000);
  it('rejects overlapping splits, invalid horizons, duplicate/label columns and unknown flags', () => {
    const r = fixture.request;
    for (const bad of [
      { ...r, splits: { ...r.splits, train: { ...r.splits.train, to: at(301) } } },
      { ...r, horizonsBars: [0] },
      { ...r, horizonsBars: [1, 1] },
      { ...r, columns: ['label_1'] },
      { ...r, columns: ['technical.sma', 'technical.sma'] },
      { ...r, execute: true },
      { ...r, generatedAt: at(0) },
    ])
      expect(DatasetPanelRequestSchema.safeParse(bad).success).toBe(false);
    expect(() =>
      buildDatasetPanel(
        fixture.input,
        { ...r, columns: ['technical.label_return'] },
        'synthetic:test',
      ),
    ).toThrow('Unknown registered');
  });
  it('uses only known historical group revisions without backfilling late classifications', () => {
    expect(row(panel, 390).groupId).toBe('synthetic:group:initial');
    expect(row(panel, 420).groupId).toBe('synthetic:group:changed');
    const f = small();
    f.input.groups = f.input.groups.filter((g) => g.instrumentKey !== key || g.revision === 2);
    expect(row(run(f), 150).reasons).toContain('GROUP_METADATA_UNAVAILABLE');
  });
  it('rejects conflicting group identities, revision numbers and backwards receipt clocks', () => {
    const f = small(),
      g = f.input.groups.find((g) => g.instrumentKey === key)!;
    f.input.groups.push({ ...g });
    expect(() => run(f)).toThrow('Duplicate group');
    f.input.groups.pop();
    f.input.groups.push({ ...g, id: 'synthetic:other:group' });
    expect(() => run(f)).toThrow('Conflicting group');
    f.input.groups.pop();
    const revision = f.input.groups.find((g) => g.instrumentKey === key && g.revision === 2)!;
    revision.observedAt = at(0);
    revision.availableAt = at(0);
    revision.provenance.capturedAt = at(0);
    g.observedAt = at(60);
    g.availableAt = at(60);
    g.provenance.capturedAt = at(60);
    expect(() => run(f)).toThrow('clock reversal');
  });
  it('does not turn stored prelisting prices or late metadata into a historical cohort', () => {
    const early = row(panel, 150, 'cross:SPOT:NEW');
    expect(early.status).toBe('QUARANTINED');
    expect(early.reasons).toContain('HISTORICAL_METADATA_UNAVAILABLE');
    expect(row(panel, 240, 'cross:SPOT:NEW').reasons).toContain('HISTORICAL_INPUT_METADATA');
    expect(row(panel, 510, 'cross:SPOT:NEW').status).toBe('INCLUDED');
    expect(
      panel.audit.survivorship.coverage.find((c) => c.instrumentKey === 'cross:SPOT:NEW')!
        .metadataRejected,
    ).toBeGreaterThan(0);
  });
  it('reports an explicit absent cohort member with zero coverage', () => {
    const f = small();
    f.request.instrumentKeys.push('synthetic:missing');
    const a = run(f);
    expect(a.audit.survivorship.coverage.at(-1)).toMatchObject({
      instrumentKey: 'synthetic:missing',
      candidateRows: 0,
      includedRows: 0,
    });
    expect(a.audit.survivorship.scope).toBe('EXPLICIT_COHORT_NOT_COMPLETE_HISTORICAL_MARKET');
  });
  it('requires point-in-time liquid membership rather than assuming a static liquid cohort', () => {
    const f = small();
    f.request.membership = 'POINT_IN_TIME_LIQUID';
    expect(run(f).rows.every((r) => r.reasons.includes('UNIVERSE_UNAVAILABLE'))).toBe(true);
    const a = buildDatasetPanel(
      fixture.input,
      { ...fixture.request, membership: 'POINT_IN_TIME_LIQUID' },
      'synthetic:test',
    );
    expect(row(a, 150, 'cross:SPOT:NEW').status).toBe('QUARANTINED');
    expect(a.audit.includedCount).toBeLessThan(panel.audit.includedCount);
  });
  it('preserves missing feature values and reports statuses; DROP_ROW excludes them', () => {
    const missing = panel.audit.missingness.find((m) => m.column === 'cross.open_interest')!;
    expect(missing.missing).toBe(panel.rows.length);
    expect(
      row(panel, 150).features.find((f) => f.name === 'cross.open_interest')!.value,
    ).toBeNull();
    const a = buildDatasetPanel(
      fixture.input,
      { ...fixture.request, missingPolicy: 'DROP_ROW' },
      'synthetic:test',
    );
    expect(a.audit.includedCount).toBe(0);
    expect(row(a, 150).reasons).toContain('MISSING_FEATURE');
  });
  it('keeps missing future labels null rather than silently dropping survivorship evidence', () => {
    const r = row(panel, 540);
    expect(r.status).toBe('QUARANTINED');
    expect(r.labels[1]).toMatchObject({ status: 'FUTURE_OBSERVATION_WINDOW', value: null });
    const f = small();
    f.request.labelsAsOf = at(720);
    f.request.generatedAt = at(720);
    expect(row(run(f), 540).labels[1]).toMatchObject({ status: 'MISSING_FUTURE_BAR', value: null });
    expect(panel.audit.survivorship.coverage[0]!.missingLabels).toBeGreaterThan(0);
  });
  it('never finalizes labels beyond the declared label freeze', () => {
    const f = small();
    f.request.labelsAsOf = at(600);
    expect(row(run(f), 510).labels[1]!.status).toBe('FUTURE_OBSERVATION_WINDOW');
    expect(row(run(f), 510).status).toBe('QUARANTINED');
  });
  it('pins the entry price known at the feature time despite a later historical correction', () => {
    const f = small();
    rebuild(f, (a) => {
      const original = a.input.bars.find((b) => b.id === `${key}:bar:2`)!;
      a.input.bars.push({
        ...original,
        id: 'synthetic:corrected-entry',
        close: decimal('52'),
        high: decimal('53'),
        availableAt: at(200),
        provenance: { ...original.provenance, capturedAt: at(200) },
      });
    });
    const r = row(run(f), 150);
    expect(r.labels[0]!.value).toBe(row(panel, 150).labels[0]!.value);
    expect(r.labels[0]!.inputBarIds).not.toContain('synthetic:corrected-entry');
  });
  it('ignores future-price revisions received after their own fixed label deadline', () => {
    const f = small();
    rebuild(f, (a) => {
      const b = a.input.bars.find((b) => b.id === `${key}:bar:3`)!;
      a.input.bars.push({
        ...b,
        id: 'synthetic:late-target-revision',
        close: decimal('53'),
        high: decimal('54'),
        availableAt: at(250),
        provenance: { ...b.provenance, capturedAt: at(250) },
      });
    });
    expect(row(run(f), 150).labels[0]!.value).toBe(row(panel, 150).labels[0]!.value);
  });
  it('does not wait until the global freeze to use a late intermediate label candle', () => {
    const f = small();
    rebuild(f, (a) => {
      const b = a.input.bars.find((b) => b.id === `${key}:bar:4`)!;
      b.availableAt = at(270);
      b.provenance.capturedAt = at(270);
    });
    expect(row(run(f), 150).labels[1]!.status).toBe('MISSING_FUTURE_BAR');
  });
  it('validates label mapping and delisting paths rather than fabricating exit returns', () => {
    const f = small();
    f.input.market.instruments.find((m) => m.instrumentKey === key)!.delistedAt = at(480);
    expect(row(run(f), 450).labels[1]!.status).toBe('LISTING_OR_MAPPING');
    expect(row(run(f), 510).reasons).toContain('HISTORICAL_METADATA_UNAVAILABLE');
  });
  it('deduplicates exact source artifacts and merges equal cells from different manifests', () => {
    const f = small();
    f.input.technicalArtifacts.push(f.input.technicalArtifacts[0]!);
    const a = run(f);
    expect(a.rows.length).toBe(15);
    expect(a.audit.duplicates[0]!.kind).toBe('EXACT_SOURCE_DUPLICATE');
    f.input.technicalArtifacts.pop();
    const old = f.input.technicalArtifacts[0]!;
    f.input.technicalArtifacts.push(
      buildTechnicalFeatureArtifact(
        old.input,
        { ...old.request, generatedAt: at(650) },
        old.codeVersion,
      ),
    );
    const merged = run(f);
    expect(row(merged, 150).status).toBe('INCLUDED');
    expect(row(merged, 150).features[0]!.sourceHashes.length).toBe(2);
  });
  it('quarantines conflicting feature configurations even if their timestamps do not overlap', () => {
    const f = small(),
      old = f.input.technicalArtifacts[0]!;
    f.input.technicalArtifacts.push(
      buildTechnicalFeatureArtifact(
        old.input,
        { ...old.request, featureAsOf: [at(570)], config: { ...old.request.config, smaPeriod: 3 } },
        old.codeVersion,
      ),
    );
    const a = run(f);
    expect(a.audit.includedCount).toBe(0);
    expect(a.audit.duplicates.some((d) => d.id === 'definition:technical.sma')).toBe(true);
  });
  it('rejects altered source computations and conflicting raw bar identities', () => {
    const f = small();
    f.input.technicalArtifacts[0]!.rows[1]!.features.find((f) => f.featureId === 'sma')!.value =
      decimal('999');
    expect(() => run(f)).toThrow('integrity');
    const g = small(),
      old = g.input.technicalArtifacts[0]!,
      input = structuredClone(old.input);
    input.bars[0]!.volume = decimal('11');
    g.input.technicalArtifacts.push(
      buildTechnicalFeatureArtifact(input, old.request, old.codeVersion),
    );
    expect(() => run(g)).toThrow('Conflicting raw');
  });
  it('rejects included future predictors and verifies semantic rebuilds independently of hashes', () => {
    const a = structuredClone(panel),
      r = row(a, 150);
    r.maxInputAvailableAt = at(151);
    expect(DatasetPanelRowSchema.safeParse(r).success).toBe(false);
    r.maxInputAvailableAt = at(120);
    r.features[0]!.value = decimal('999');
    expect(() => validateDatasetPanelArtifact(a)).toThrow('integrity');
  });
  it('replays deterministically with immutable results and distinct config/software identities', () => {
    const f = small(),
      a = run(f);
    expect(canonicalHash(a)).toBe(canonicalHash(run(f)));
    expect(Object.isFrozen(a.rows[0]!.features)).toBe(true);
    expect(buildDatasetPanel(f.input, f.request, 'synthetic:other').configHash).toBe(a.configHash);
    f.request.embargoSeconds++;
    expect(run(f).configHash).not.toBe(a.configHash);
    expect(utcNanoseconds(row(panel, 150).featureAsOf)).toBe(utcNanoseconds(at(150)));
  });
  it('writes byte-stable Parquet, verifies immutable reuse and serves an explicit typed label interface', async () => {
    const f = small(),
      root = await temp(),
      other = await temp(),
      a = await writeDatasetPanel(f.input, f.request, root, 'synthetic:test'),
      b = await writeDatasetPanel(f.input, f.request, other, 'synthetic:test'),
      again = await writeDatasetPanel(f.input, f.request, root, 'synthetic:test');
    expect(a.manifest).toEqual(b.manifest);
    expect(again.manifest.id).toBe(a.manifest.id);
    expect(await readFile(join(a.directory, 'panel.parquet'))).toEqual(
      await readFile(join(b.directory, 'panel.parquet')),
    );
    expect(await readdir(root)).toEqual([a.manifest.id]);
    const client = await readDatasetPanel(a.directory),
      points = client.features('TRAIN');
    expect(points.length).toBeGreaterThan(0);
    expect(Object.keys(points[0]!)).toEqual([
      'id',
      'instrumentKey',
      'groupId',
      'featureAsOf',
      'maxInputAvailableAt',
      'values',
    ]);
    expect(points[0]!.values).toEqual(['50.5']);
    expect(client.supervised('TRAIN', 1)[0]!.target.value).toBe(row(panel, 150).labels[0]!.value);
    expect(() => client.features('INVALID')).toThrow();
    expect(() => client.supervised('TRAIN', 3)).toThrow('Unknown');
    expect(Object.isFrozen(points)).toBe(true);
    const report = datasetPanelReport(a.artifact, a.manifest);
    expect(report).toContain('AUDIT ONLY');
    expect(report).toContain('UNREGISTERED_SOURCE');
    expect(report).toContain('not a complete historical market');
  }, 30000);
  it('rejects modified export bytes and refuses to replace corrupt existing artifacts', async () => {
    const f = small(),
      root = await temp(),
      a = await writeDatasetPanel(f.input, f.request, root, 'synthetic:test');
    await writeFile(join(a.directory, 'artifact.json'), '{}');
    await expect(verifyDatasetPanel(a.directory)).rejects.toThrow('checksum');
    await expect(writeDatasetPanel(f.input, f.request, root, 'synthetic:test')).rejects.toThrow();
    expect(await readFile(join(a.directory, 'artifact.json'), 'utf8')).toBe('{}');
    expect(await readdir(root)).toEqual([a.manifest.id]);
  }, 30000);
  it('detects poisoned flat Parquet columns even after attacker recomputes all file hashes', async () => {
    const f = small(),
      root = await temp(),
      v = await writeDatasetPanel(f.input, f.request, root, 'synthetic:test'),
      path = join(v.directory, 'panel.parquet'),
      bad = join(root, 'bad.parquet'),
      d = await DuckDBInstance.create(':memory:');
    let c;
    try {
      c = await d.connect();
      await c.run('CREATE TABLE bad AS SELECT * FROM read_parquet($path)', { path });
      await c.run("UPDATE bad SET feature_0='999'");
      await c.run(`COPY bad TO '${bad.replaceAll("'", "''")}' (FORMAT PARQUET)`);
    } finally {
      c?.closeSync();
      d.closeSync();
    }
    await rename(bad, path);
    const { id, ...body } = v.manifest,
      changed = { ...body, parquetHash: byteHash(await readFile(path)) },
      manifest = { ...changed, id: deterministicId('dataset-panel', changed) },
      directory = join(root, manifest.id);
    expect(basename(v.directory)).toBe(id);
    await writeFile(join(v.directory, 'manifest.json'), canonicalJson(manifest));
    await rename(v.directory, directory);
    await expect(verifyDatasetPanel(directory)).rejects.toThrow('column mismatch');
  }, 30000);
});
