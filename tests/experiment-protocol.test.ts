import { describe, expect, it } from 'vitest';
import { canonicalHash } from '@crypto/core';
import {
  experimentProtocolFixture,
  freezeExperiment,
  verifyExperimentManifest,
  parseExperimentYaml,
  experimentYaml,
  assertExperimentLaunch,
  trialArtifact,
  trialFixtureAt,
  processTrialReceipt,
  experimentPaperConfig,
} from '@crypto/evaluation';
import { PaperBroker, paperFixture, replayPaper, verifyPaperReport } from '@crypto/paper';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runRegisteredExperiment, loadTrialStore, submitTrialEvent } from '@crypto/evaluation';

describe('Module 15 Iteration 1 frozen protocol', () => {
  it('launches and restarts only bound synthetic test ports while preserving a public-study protocol', async () => {
    // Eligibility metadata is fictional test input; no real provider, clock or network is used.
    const p = structuredClone(experimentProtocolFixture());
    p.origin = 'PUBLIC_READ_ONLY';
    p.paper.origin = 'PUBLIC_READ_ONLY';
    for (const m of p.models) {
      const { hash: _, ...body } = m.artifact;
      void _;
      m.artifact = trialArtifact({
        ...body,
        origin: 'RESEARCH',
        content: { origin: 'RESEARCH', rule: 'SYNTHETIC_TEST_PORT_NO_SIGNAL' },
      });
    }
    for (const s of p.providers) {
      const { hash: _, ...body } = s.evidence;
      void _;
      s.rights = 'APPROVED_RESEARCH_USE';
      s.evidence = trialArtifact({
        ...body,
        origin: 'RESEARCH',
        content: {
          adapterHash: s.adapterHash,
          licenseReviewHash: s.reviewHash,
          reviewPurpose: 'SYNTHETIC_TEST_ONLY_NO_REAL_PROVIDER',
        },
      });
    }
    const manifest = freezeExperiment(p),
      root = await mkdtemp(join(tmpdir(), 'trial-session-'));
    let now = trialFixtureAt(0);
    const ports = {
      now: () => now,
      sourceBindings: p.providers.map((s) => ({
        sourceId: s.id,
        adapterVersion: s.adapterVersion,
        adapterHash: s.adapterHash,
      })),
      source: async function* () {
        await Promise.resolve();
        yield* [];
      },
    };
    try {
      const initial = await runRegisteredExperiment(root, manifest, p.codeVersion, ports);
      expect(initial.paper.status).toBe('PAUSED');
      const head = initial.paper.logHead;
      now = trialFixtureAt(5);
      await expect(
        runRegisteredExperiment(root, manifest, 'changed-code', ports, true),
      ).rejects.toThrow();
      expect((await loadTrialStore(root)).paper.logHead).toBe(head);
      await submitTrialEvent(
        root,
        {
          kind: 'HEARTBEAT',
          id: 'synthetic:queued-source-time',
          at: trialFixtureAt(2),
          sourceId: p.paper.newsSources[0]!.id,
          licenseReviewHash: p.paper.newsSources[0]!.licenseReviewHash,
          healthy: true,
        },
        now,
      );
      const resumed = await runRegisteredExperiment(root, manifest, p.codeVersion, ports, true);
      expect(resumed.paper.status).toBe('PAUSED');
      expect(resumed.paper.fills).toHaveLength(0);
      expect(resumed.annotations.filter((a) => a.kind === 'RESTART')).toHaveLength(1);
      expect(resumed.paper.log[0]!.hash).toBe(initial.paper.log[0]!.hash);
      const heartbeat = resumed.paper.log.find((l) => l.event.kind === 'HEARTBEAT')!.event;
      expect(heartbeat.kind === 'HEARTBEAT' && heartbeat.observedAt).toBe(trialFixtureAt(2));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('retains original source clocks when inbox processing follows receipt', () => {
    const m = freezeExperiment(experimentProtocolFixture()),
      news = m.protocol.paper.newsSources[0]!,
      b = new PaperBroker(experimentPaperConfig(m));
    const e = processTrialReceipt(
      {
        kind: 'HEARTBEAT',
        id: 'synthetic:late-heartbeat',
        at: trialFixtureAt(3600),
        observedAt: trialFixtureAt(0),
        sourceId: news.id,
        licenseReviewHash: news.licenseReviewHash,
        healthy: true,
      },
      trialFixtureAt(3610),
      m,
    );
    b.consume(e);
    expect(b.sourceHealth().news[0]!.fresh).toBe(false);
    expect(b.sourceHealth().news[0]!.lastObservedAt).toBe(trialFixtureAt(0));
    expect(() =>
      processTrialReceipt({ ...e, at: trialFixtureAt(4000) }, trialFixtureAt(3610), m),
    ).toThrow();
  });
  it('reuses only semantically rebuilt immutable reports, never a caller-frozen forgery', () => {
    const f = paperFixture(),
      r = verifyPaperReport(replayPaper(f.config, f.events));
    expect(verifyPaperReport(r)).toBe(r);
    expect(Object.isFrozen(r.log[0])).toBe(true);
    expect(() => verifyPaperReport(Object.freeze({ ...r, status: 'KILLED' }))).toThrow();
  });
  it('round-trips strict YAML, four model bindings and a hashed native ExperimentManifest', () => {
    const p = experimentProtocolFixture(),
      m = freezeExperiment(p);
    expect(verifyExperimentManifest(m)).toEqual(m);
    expect(freezeExperiment(parseExperimentYaml(experimentYaml(p)))).toEqual(m);
    expect(m.manifest.models).toHaveLength(4);
    expect(m.manifest.symbols).toEqual(['BTC/USDT', 'ETH/USDT', 'SOL/USDT']);
    expect(m.manifest.execution).toBe('SIMULATED');
    expect(Object.isFrozen(m)).toBe(true);
  });
  it.each([
    'mutableHash',
    'unversionedModel',
    'futureModel',
    'missingAdapter',
    'unlicensed',
    'futureReview',
    'wrongCalendar',
    'excessRisk',
    'futureOpportunity',
    'syntheticPublic',
  ])('refuses %s before launch', (which) => {
    const p = structuredClone(experimentProtocolFixture());
    if (which === 'mutableHash') {
      const m = structuredClone(freezeExperiment(p));
      m.hash = canonicalHash('changed');
      expect(() => verifyExperimentManifest(m)).toThrow();
      return;
    }
    if (which === 'unversionedModel')
      p.models[0]!.artifact.hash = canonicalHash('unknown artifact');
    if (which === 'futureModel') {
      const { hash: _, ...artifact } = p.models[0]!.artifact;
      void _;
      p.models[0]!.artifact = trialArtifact({
        ...artifact,
        knownAt: trialFixtureAt(1),
      });
    }
    if (which === 'missingAdapter')
      p.providers[0]!.adapterHash = canonicalHash('unreviewed-adapter');
    if (which === 'unlicensed') p.providers[1]!.approved = false;
    if (which === 'futureReview') p.providers[1]!.reviewedAt = trialFixtureAt(1);
    if (which === 'wrongCalendar') p.paper.endAt = trialFixtureAt(29 * 86400);
    if (which === 'excessRisk')
      p.riskPolicy.risk.riskFraction = '0.1' as typeof p.riskPolicy.risk.riskFraction;
    if (which === 'futureOpportunity')
      p.evaluation.opportunityGrid[0]!.at = trialFixtureAt(31 * 86400);
    if (which === 'syntheticPublic') {
      p.origin = 'PUBLIC_READ_ONLY';
      p.paper.origin = 'PUBLIC_READ_ONLY';
    }
    expect(() => freezeExperiment(p)).toThrow();
  });
  it('changes experiment identity for any parameter/code change and refuses synthetic or stale launches', () => {
    const p = experimentProtocolFixture(),
      a = freezeExperiment(p),
      b = freezeExperiment({
        ...p,
        codeVersion: 'synthetic:new-code',
        paper: { ...p.paper, codeVersion: 'synthetic:new-code' },
      }),
      c = freezeExperiment({ ...p, paper: { ...p.paper, slippageBps: '6' } });
    expect(a.manifest.id).not.toBe(b.manifest.id);
    expect(a.manifest.id).not.toBe(c.manifest.id);
    expect(() => assertExperimentLaunch(a, p.codeVersion, p.paper.startAt)).toThrow();
  });
  it('rejects duplicate keys, aliases, document streams, tags and bounded YAML attacks', () => {
    for (const text of [
      'schemaVersion: a\nschemaVersion: b',
      'a: &x [a]\nb: *x',
      '---\na: 1\n---\na: 2',
      '!!js/function return process.env',
      'x: ' + 'a'.repeat(1024 * 1024),
    ])
      expect(() => parseExperimentYaml(text)).toThrow();
  });
});
