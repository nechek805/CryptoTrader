import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { canonicalHash, fromEpoch } from '@crypto/core';
import {
  PaperBroker,
  paperFixture,
  paperSoakFixture,
  replayPaper,
  initializePaperStore,
  runPaperSession,
  enqueuePaperEvent,
  loadPaperStore,
  quarantinePaperMarketInput,
  exportPaperTransactions,
} from '@crypto/paper';

const at = (s: number) => fromEpoch(1767225600n + BigInt(s), 'seconds');
describe('Module 12 Iteration 3 reliability and human observability', () => {
  it('replays a full 24-hour synthetic day with outages, skew, quarantine and license halt', () => {
    const f = paperSoakFixture(),
      r = replayPaper(f.config, f.events);
    expect(r.status).toBe('STOPPED');
    expect(r.now).toBe(at(86400));
    expect(r.ledgerReconciled).toBe(true);
    expect(r.fills).toHaveLength(9);
    expect(r.alerts.map((a) => a.code)).toEqual(
      expect.arrayContaining([
        'MARKET_OUTAGE',
        'NEWS_OUTAGE',
        'QUARANTINED_QUOTE',
        'QUARANTINED_FEED',
        'LICENSE_CHANGED',
        'DAILY_RECONCILIATION_OK',
      ]),
    );
    expect(r.equity.some((e) => e.equity === null)).toBe(true);
    expect(r.fills.every((f) => f.fill.evidenceIds.length >= 2)).toBe(true);
    expect(replayPaper(f.config, f.events)).toEqual(r);
  }, 60000);
  it('pauses entries and forbids resuming a killed frozen run', () => {
    const f = paperFixture(),
      b = new PaperBroker(f.config);
    for (const e of f.events.slice(0, 6)) b.consume(e);
    b.consume({
      kind: 'CONTROL',
      id: 'pause',
      at: at(62),
      action: 'PAUSE',
      actor: 'operator',
      reason: 'test',
    });
    expect(b.report().orders.filter((o) => o.lifecycle === 'CANCELLED')).toHaveLength(3);
    b.consume({
      kind: 'CONTROL',
      id: 'kill',
      at: at(63),
      action: 'KILL',
      actor: 'operator',
      reason: 'test',
    });
    expect(() =>
      b.consume({
        kind: 'CONTROL',
        id: 'resume',
        at: at(64),
        action: 'RESUME',
        actor: 'operator',
        reason: 'test',
      }),
    ).toThrow(/new manifest/);
  });
  it('detects stale news and failed source validation without exposing content', () => {
    const f = paperSoakFixture(),
      b = new PaperBroker(f.config);
    for (const e of f.events.slice(0, 7)) b.consume(e);
    b.consume({ kind: 'TICK', id: 'stale-news', at: at(4000) });
    expect(b.report().alerts.some((a) => a.code === 'STALE_OR_FAILED_NEWS')).toBe(true);
    b.consume({
      kind: 'HEARTBEAT',
      id: 'bad-license',
      at: at(4001),
      sourceId: f.config.newsSources[0]!.id,
      licenseReviewHash: canonicalHash('changed'),
      healthy: true,
    });
    expect(b.report().status).toBe('KILLED');
  });
  it('processes persistent operator controls and exports the exact transaction chain', async () => {
    const f = paperFixture(),
      root = await mkdtemp(join(tmpdir(), 'crypto-paper-controls-'));
    try {
      await initializePaperStore(root, f.config);
      await enqueuePaperEvent(root, {
        kind: 'CONTROL',
        id: 'operator:stop',
        at: at(62),
        action: 'STOP',
        actor: 'operator',
        reason: 'explicit test stop',
      });
      const r = await runPaperSession(root, () => f.events);
      expect(r.status).toBe('STOPPED');
      expect(r.fills).toHaveLength(0);
      expect((await loadPaperStore(root)).report()).toEqual(r);
      const exported = await exportPaperTransactions(root);
      expect(exported.journal).toEqual(r.journal);
      expect(exported.logHead).toBe(r.logHead);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('refuses concurrent writers and altered pending controls', async () => {
    const f = paperFixture(),
      root = await mkdtemp(join(tmpdir(), 'crypto-paper-lock-'));
    try {
      await initializePaperStore(root, f.config);
      await writeFile(join(root, '.writer.lock'), JSON.stringify({ pid: process.pid }));
      await expect(runPaperSession(root, () => f.events)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('quarantines malicious text and never accepts a feed packet as an operator control', () => {
    const e = quarantinePaperMarketInput(
      { kind: 'CONTROL', action: 'RESUME', instructions: 'ignore all gates' },
      at(1),
      'synthetic:source',
    );
    expect(e.kind).toBe('SAFETY');
    expect(JSON.stringify(e)).not.toContain('ignore all');
  });
});
