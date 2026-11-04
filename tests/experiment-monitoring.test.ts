import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { TrialRun, TrialAssessment } from '@crypto/contracts';
import { TrialRunSchema } from '@crypto/contracts';

import { canonicalHash } from '@crypto/core';
import { PaperBroker, replayPaper, writePaperEventBatch } from '@crypto/paper';
import {
  experimentExercise,
  assessExperiment,
  verifyTrialRun,
  guardForwardReceipt,
  guardExperimentEvent,
  experimentPaperConfig,
  initializeTrialStore,
  loadTrialStore,
  appendTrialAnnotation,
  writeTrialBundle,
  verifyTrialBundle,
  trialFixtureAt,
} from '@crypto/evaluation';
let run: TrialRun, assessment: TrialAssessment;
beforeAll(() => {
  run = TrialRunSchema.parse(experimentExercise());
  assessment = assessExperiment(run);
}, 120000);
describe('Module 15 Iterations 2–3 operational exercise and honest assessment', () => {
  it('records 30 virtual days, all four arms, HOLDs, incidents, daily reconciliation and weekly QA', () => {
    expect(run.paper.ledgerReconciled).toBe(true);
    expect(run.paper.now).toBe(trialFixtureAt(30 * 86400));
    expect(run.paper.decisions).toHaveLength(16);
    expect(run.paper.fills).toHaveLength(30);
    expect(run.paper.alerts.map((a) => a.code)).toEqual(
      expect.arrayContaining([
        'NEWS_OUTAGE',
        'MARKET_OUTAGE',
        'CONTROL_PAUSE',
        'CONTROL_RESUME',
        'DAILY_RECONCILIATION_OK',
      ]),
    );
    expect(run.annotations.map((a) => a.kind)).toEqual(
      expect.arrayContaining([
        'RESTART',
        'DUPLICATE_SOURCE',
        'NEWS_CORRECTION',
        'CORROBORATION_DELAY',
      ]),
    );
    expect(assessment.daily).toHaveLength(30);
    expect(assessment.weeklyQa).toHaveLength(5);
    expect(assessment.continuity.continuousAnalysis).toBeNull();
    expect(assessment.continuity.interruptedAnalysis).not.toBeNull();
    expect(assessment.corroborationDelay.missedSignals).toBe(2);
    expect(assessment.corroborationDelay.status).toBe('MEASURED');
    expect(assessment.evaluation.metrics.find((m) => m.portfolio === 'BASELINE')!.netPnl).toBe('0');
  });
  it('cannot promote synthetic results, sparse evidence or a restart into robust forward alpha', () => {
    expect(assessment.actualElapsed30Days).toBe(false);
    expect(assessment.recommendation).not.toBe('CONTINUE_FORWARD_TEST');
    expect(assessment.alphaClaim).toBe('NOT_ESTABLISHED');
    expect(assessment.realMoneyAuthorized).toBe(false);
    expect(assessment.passiveBasket).toHaveLength(3);
    expect(
      assessment.evaluation.pairedComparisons.every(
        (p) => p.status !== 'CONDITIONAL_APPROXIMATION' || p.lower === null || p.lower <= 0,
      ),
    ).toBe(true);
  });
  it('rejects future/backdated receipts, unregistered models and altered annotations', () => {
    const e = run.paper.log.find((l) => l.event.kind === 'PROPOSE')!.event;
    expect(() => guardForwardReceipt(e, trialFixtureAt(0), run.manifest)).toThrow();
    expect(() => guardForwardReceipt(e, trialFixtureAt(1000), run.manifest)).toThrow();
    if (e.kind !== 'PROPOSE') throw new Error('Fixture proposal');
    const changed = structuredClone(e);
    changed.decision.request.risk.candidate.reproducibility.modelVersion = 'unknown';
    expect(() => guardExperimentEvent(run.manifest, changed)).toThrow();
    const bad = structuredClone(run);
    bad.annotations.find((a) => a.kind === 'NEWS_CORRECTION')!.evidence = { replaced: true };
    expect(() => verifyTrialRun(bad)).toThrow();
  }, 60000);
  it('reproduces restart state exactly and verifies durable annotation/ledger snapshots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'trial-restore-'));
    try {
      const partial = {
        ...run,
        paper: replayPaper(
          run.paper.config,
          run.paper.log.slice(0, 4).map((l) => l.event),
        ),
        annotations: [run.annotations[0]!],
      };
      await initializeTrialStore(root, run.manifest);
      await writePaperEventBatch(
        join(root, 'paper'),
        partial.paper.log.map((l) => l.event),
      );
      await appendTrialAnnotation(root, partial.annotations[0]);
      expect(canonicalHash((await loadTrialStore(root)).paper)).toBe(canonicalHash(partial.paper));
      const b = new PaperBroker(experimentPaperConfig(run.manifest));
      for (const l of partial.paper.log) b.consume(l.event);
      expect(b.report()).toEqual(partial.paper);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('freezes reproducible findings and rejects report tampering; partial runs remain inconclusive', async () => {
    const root = await mkdtemp(join(tmpdir(), 'trial-artifact-'));
    try {
      const partial = {
        ...run,
        paper: replayPaper(
          run.paper.config,
          run.paper.log.slice(0, 4).map((l) => l.event),
        ),
        annotations: [run.annotations[0]!],
      };
      const bundle = await writeTrialBundle(partial, root);
      expect((await verifyTrialBundle(bundle.directory)).assessment.hash).toBe(
        bundle.assessment.hash,
      );
      expect(bundle.assessment.continuity.continuousAnalysis).not.toBeNull();
      await writeFile(join(bundle.directory, 'findings.md'), 'tampered');
      await expect(verifyTrialBundle(bundle.directory)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60000);
});
