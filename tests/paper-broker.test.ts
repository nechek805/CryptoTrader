import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { PaperEventSchema } from '@crypto/contracts';
import { canonicalHash, fromEpoch } from '@crypto/core';
import {
  PaperBroker,
  paperFixture,
  paperFixtureConfig,
  replayPaper,
  syntheticPaperProposal,
  syntheticPaperQuote,
  initializePaperStore,
  writePaperEventBatch,
  appendPaperEvent,
  loadPaperStore,
  savePaperSnapshot,
  restorePaperSnapshot,
  verifyPaperReport,
} from '@crypto/paper';

const at = (s: number) => fromEpoch(1767225600n + BigInt(s), 'seconds');
describe('Module 12 Iteration 1 virtual broker and four ledgers', () => {
  it('uses isolated capital and simulated canonical fills with a reconciled journal', () => {
    const f = paperFixture(),
      r = replayPaper(f.config, f.events);
    expect(r.ledgerReconciled).toBe(true);
    expect(r.liveExecution).toBe('DISABLED');
    expect(r.fills).toHaveLength(6);
    expect(r.orders.find((o) => o.order.portfolio === 'BASELINE')!.lifecycle).toBe('RISK_REJECTED');
    for (const arm of ['NEWS_ONLY', 'MARKET_ONLY', 'FUSION']) {
      expect(r.orders.find((o) => o.order.portfolio === arm)!.lifecycle).toBe('FILLED');
      expect(r.balances.find((b) => b.portfolio === arm && b.asset === 'BTC')!.free).toBe('1.733');
    }
    expect(r.balances.find((b) => b.portfolio === 'BASELINE' && b.asset === 'USDT')!.free).toBe(
      '10000',
    );
    expect(verifyPaperReport(r)).toEqual(r);
  });
  it('does not immediately fill a proposal and exposes partial lifecycle', () => {
    const f = paperFixture(),
      broker = new PaperBroker(f.config);
    for (const e of f.events.slice(0, 6)) broker.consume(e);
    expect(broker.report().fills).toHaveLength(0);
    broker.consume(f.events[6]);
    expect(broker.report().orders.filter((o) => o.lifecycle === 'PARTIAL')).toHaveLength(3);
  });
  it('restarts after partial fill without duplicate money, candidates or orders', async () => {
    const f = paperFixture(),
      root = await mkdtemp(join(tmpdir(), 'crypto-paper-'));
    try {
      await initializePaperStore(root, f.config);
      const partial = await writePaperEventBatch(root, f.events.slice(0, 7));
      expect(partial.fills).toHaveLength(3);
      const snap = await savePaperSnapshot(root);
      const resumed = await writePaperEventBatch(root, f.events.slice(7));
      expect(resumed).toEqual(replayPaper(f.config, f.events));
      expect(await restorePaperSnapshot(root, snap)).toEqual(resumed);
      const e = f.events.find(
        (e) => e.kind === 'PROPOSE' && e.decision.request.risk.candidate.portfolio === 'NEWS_ONLY',
      )!;
      const retry = { ...e, id: 'synthetic:retry', at: at(64) };
      const after = await appendPaperEvent(root, retry);
      expect(after.fills).toEqual(resumed.fills);
      expect(after.journal).toEqual(resumed.journal);
      expect(after.orders).toEqual(resumed.orders);
      expect((await loadPaperStore(root)).report()).toEqual(after);
      await writeFile(join(root, 'events', '.paper-stage-torn'), '{not complete');
      expect((await loadPaperStore(root)).report()).toEqual(after);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('expires an unfilled limit and releases its reservation', () => {
    const { config } = paperFixtureConfig(),
      broker = new PaperBroker(config);
    broker.consume(syntheticPaperQuote(60));
    broker.consume({ kind: 'TICK', id: 'tick61', at: at(61) });
    broker.consume(syntheticPaperProposal(broker, 'NEWS_ONLY', 61, 'LIMIT'));
    broker.consume(syntheticPaperQuote(62));
    expect(broker.report().fills).toHaveLength(0);
    broker.consume({ kind: 'TICK', id: 'tick400', at: at(400) });
    const r = broker.report();
    expect(r.orders[0]!.lifecycle).toBe('EXPIRED');
    expect(r.balances.find((b) => b.portfolio === 'NEWS_ONLY' && b.asset === 'USDT')!.free).toBe(
      '10000',
    );
  });
  it('does not fill at an old quote received after submission', () => {
    const f = paperFixture(),
      broker = new PaperBroker(f.config);
    for (const e of f.events.slice(0, 6)) broker.consume(e);
    const old = syntheticPaperQuote(60);
    broker.consume({ ...old, id: 'synthetic:late', at: at(62) });
    expect(broker.report().fills).toHaveLength(0);
  });
  it('rejects changed signal versions under the same idempotency key', () => {
    const f = paperFixture(),
      broker = new PaperBroker(f.config);
    for (const e of f.events.slice(0, 6)) broker.consume(e);
    const e = f.events[3]!;
    if (e.kind !== 'PROPOSE') throw new Error('Fixture proposal expected');
    expect(() =>
      broker.consume({ ...e, id: 'changed', orderType: 'LIMIT', limitPrice: '100' }),
    ).toThrow(/idempotency/);
  });
  it('cannot consume another portfolio reservation', () => {
    const f = paperFixture(),
      r = replayPaper(f.config, f.events),
      b = new PaperBroker(f.config);
    for (const e of f.events) b.consume(e);
    expect(() =>
      b.consume({
        id: 'wrong-cancel',
        kind: 'CANCEL',
        at: at(64),
        portfolio: 'BASELINE',
        orderId: r.orders.find((o) => o.order.portfolio === 'NEWS_ONLY')!.order.id,
        actor: 'operator',
        reason: 'test',
      }),
    ).toThrow(/own-portfolio/);
  });
  it('rejects conflicting provider records and safely marks missing equity', () => {
    const f = paperFixture(),
      b = new PaperBroker(f.config);
    for (const e of f.events) b.consume(e);
    const q = syntheticPaperQuote(63);
    if (q.kind !== 'QUOTE') throw new Error('Quote expected');
    b.consume({ ...q, id: 'conflict', at: at(64), bid: '99.98' });
    const r = b.report();
    expect(r.alerts.at(-1)!.code).toBe('CONFLICTING_PROVIDER_ID');
    expect(r.equity.at(-1)!.equity).toBeNull();
  });
  it('detects corrupted committed event state and tampered reports', async () => {
    const f = paperFixture(),
      root = await mkdtemp(join(tmpdir(), 'crypto-paper-corrupt-'));
    try {
      await initializePaperStore(root, f.config);
      await writePaperEventBatch(root, f.events);
      const name = (await readdir(join(root, 'events'))).sort()[0]!,
        path = join(root, 'events', name),
        raw = JSON.parse(await readFile(path, 'utf8')) as { stateHash: string };
      raw.stateHash = canonicalHash('corrupt');
      await writeFile(path, JSON.stringify(raw));
      await expect(loadPaperStore(root)).rejects.toThrow(/integrity/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    const r = structuredClone(replayPaper(f.config, f.events));
    r.balances[0]!.free = '99999' as never;
    expect(() => verifyPaperReport(r)).toThrow(/integrity/);
  });
  it('rejects private/live fields and unapproved source configuration', () => {
    const f = paperFixtureConfig();
    expect(() => new PaperBroker({ ...f.config, privateKey: 'not-a-key' })).toThrow();
    f.config.source.approved = false;
    expect(() => new PaperBroker(f.config)).toThrow(/eligibility/);
    expect(PaperEventSchema.safeParse({ kind: 'WITHDRAW' }).success).toBe(false);
  });
});
