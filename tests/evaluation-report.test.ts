import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { canonicalHash } from '@crypto/core';
import {
  misleadingProfitableFixture,
  evaluatePaperExperiment,
  verifyEvaluationReport,
  evaluationMarkdown,
  writeEvaluationBundle,
  verifyEvaluationBundle,
  listEvaluationRuns,
  auditPaperMarket,
} from '@crypto/evaluation';
describe('Module 13 Iteration 3 attribution and decision memo', () => {
  it('retains a deliberately misleading profitable run without promoting alpha', () => {
    const f = misleadingProfitableFixture(),
      r = evaluatePaperExperiment(f.paper, f.plan);
    expect(Number(r.metrics.find((m) => m.portfolio === 'NEWS_ONLY')!.netPnl)).toBeGreaterThan(0);
    expect(r.memo.recommendation).toBe('REVISE');
    expect(r.memo.alphaClaim).toBe('NOT_ESTABLISHED');
    expect(r.diagnostics.perArm.find((a) => a.portfolio === 'NEWS_ONLY')!.warnings).toContain(
      'TAIL_EVENT_DOMINANCE',
    );
    expect(r.pairedComparisons.every((p) => p.lower === null)).toBe(true);
    expect(
      r.attribution.strata.some((s) => s.dimension === 'NEWS_CATEGORY' && s.value === 'UNKNOWN'),
    ).toBe(true);
    expect(evaluationMarkdown(r)).toContain('N/A');
    expect(evaluationMarkdown(r)).toContain('[Exact frozen input](input.json)');
    expect(verifyEvaluationReport(r, f.paper)).toEqual(r);
  }, 120000);
  it('refuses post-hoc thresholds/cohort timing and semantic report tampering', () => {
    const f = misleadingProfitableFixture(),
      r = structuredClone(evaluatePaperExperiment(f.paper, f.plan));
    r.memo.recommendation = 'CONTINUE';
    const { hash: _, ...body } = r;
    void _;
    r.hash = canonicalHash(body);
    expect(() => verifyEvaluationReport(r, f.paper)).toThrow(/integrity/);
    f.plan.frozenAt = f.plan.generatedAt;
    expect(() => evaluatePaperExperiment(f.paper, f.plan)).toThrow(/freeze/);
  }, 120000);
  it('keeps known evidence and calibration separate from factual truth/publication time', () => {
    const f = misleadingProfitableFixture(),
      r = evaluatePaperExperiment(f.paper, f.plan);
    expect(r.attribution.calibration.every((c) => c.brierScore === null)).toBe(true);
    expect(
      r.attribution.timing.every((t) => t.basis === 'LATEST_REQUIRED_EVIDENCE_NOT_PUBLICATION'),
    ).toBe(true);
    expect(r.evidence.some((e) => e.id === 'synthetic:claim')).toBe(true);
    expect(r.warnings).toContain('MISSING_OR_LATE_NEWS_COVERAGE');
    expect(auditPaperMarket(f.paper, 60).benchmarks.buyAndHoldNetReturn).toBeNull();
  }, 120000);
  it('publishes reproducible immutable bundles and keeps losing/inconclusive runs searchable', async () => {
    const f = misleadingProfitableFixture(),
      root = await mkdtemp(join(tmpdir(), 'crypto-evaluation-'));
    try {
      const a = await writeEvaluationBundle(f.paper, f.plan, join(root, 'a')),
        b = await writeEvaluationBundle(f.paper, f.plan, join(root, 'b'));
      expect(await readFile(join(a.directory, 'report.json'), 'utf8')).toBe(
        await readFile(join(b.directory, 'report.json'), 'utf8'),
      );
      expect((await verifyEvaluationBundle(a.directory)).report).toEqual(a.report);
      expect((await listEvaluationRuns(join(root, 'a')))[0]!.recommendation).toBe('REVISE');
      await writeFile(join(a.directory, 'report.md'), 'forged favorable memo');
      await expect(verifyEvaluationBundle(a.directory)).rejects.toThrow(/integrity/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120000);
});
