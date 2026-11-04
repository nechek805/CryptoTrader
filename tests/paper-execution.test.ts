import { describe, expect, it } from 'vitest';
import { PaperEventSchema } from '@crypto/contracts';
import { canonicalHash, fromEpoch } from '@crypto/core';
import { decodePublicPaperTrade } from '@crypto/connectors';
import {
  PaperBroker,
  paperFixture,
  paperFixtureConfig,
  syntheticPaperProposal,
  syntheticPaperQuote,
  verifyPaperReport,
} from '@crypto/paper';

const at = (s: number) => fromEpoch(1767225600n + BigInt(s), 'seconds');
function trade(seconds: number, price: string, quantity = '100', provider = `trade:${seconds}`) {
  const { config } = paperFixtureConfig();
  return PaperEventSchema.parse({
    kind: 'TRADE',
    id: `synthetic:trade-receipt:${seconds}`,
    at: at(seconds),
    observedAt: at(seconds),
    providerAt: at(seconds),
    providerEventAt: at(seconds),
    sourceId: config.source.id,
    providerEventId: provider,
    symbol: 'BTC/USDT',
    price,
    quantity,
    aggressor: 'SELL',
    rawHash: canonicalHash({ origin: 'SYNTHETIC', seconds, price, quantity }),
    metadataHash: config.instruments[0]!.metadataHash,
  });
}
function limit() {
  const { config } = paperFixtureConfig(),
    b = new PaperBroker(config);
  b.consume(syntheticPaperQuote(60));
  b.consume({ kind: 'TICK', id: 'tick61', at: at(61) });
  b.consume(syntheticPaperProposal(b, 'NEWS_ONLY', 61, 'LIMIT'));
  return b;
}
describe('Module 12 Iteration 2 realistic virtual execution', () => {
  it('requires trade-through plus queue evidence rather than touching the limit', () => {
    const b = limit();
    b.consume(syntheticPaperQuote(62));
    b.consume(trade(63, '100'));
    expect(b.report().fills).toHaveLength(0);
    b.consume(trade(64, '99.99', '2')); // participation 0.25: consumes only half of assumed queue.
    expect(b.report().fills).toHaveLength(0);
    b.consume(trade(65, '99.99', '10'));
    const r = b.report();
    expect(r.orders[0]!.lifecycle).toBe('FILLED');
    expect(r.fills[0]!.fill.price).toBe('100');
    expect(r.fills[0]!.fill.liquidity).toBe('MAKER');
    expect(r.fills[0]!.fidelity).toBe('TRADE_THROUGH_ASSUMED_QUEUE');
  });
  it('does not turn a delayed pre-order trade into a fill', () => {
    const b = limit(),
      e = trade(62, '99.99');
    b.consume({ ...e, providerAt: at(60), providerEventAt: at(60), observedAt: at(60) });
    expect(b.report().fills).toHaveLength(0);
  });
  it('does not consume the same provider trade twice after reconnect', () => {
    const b = limit(),
      e = trade(62, '99.99', '4');
    b.consume(e);
    b.consume({ ...e, id: 'synthetic:duplicate-receipt', at: at(63), observedAt: at(63) });
    expect(b.report().fills).toHaveLength(0); // the original volume only cleared the assumed queue.
  });
  it('charges deterministic fees and reconciles mark-to-market equity', () => {
    const f = paperFixture(),
      b = new PaperBroker(f.config);
    for (const e of f.events) b.consume(e);
    const r = b.report(),
      fills = r.fills.filter((f) => f.fill.portfolio === 'NEWS_ONLY');
    expect(fills.reduce((s, f) => s + Number(f.fill.fee), 0)).toBeCloseTo(
      1.733 * 100.05 * 0.001,
      8,
    );
    const last = r.equity.filter((e) => e.portfolio === 'NEWS_ONLY').at(-1)!;
    expect(Number(last.equity)).toBeCloseTo(10000 + Number(last.unrealizedNetPnl), 8);
  });
  it('a flash crash triggers an exit only on a later quote at an adverse price', () => {
    const f = paperFixture(),
      b = new PaperBroker(f.config);
    for (const e of f.events) b.consume(e);
    b.consume(syntheticPaperQuote(70, '70', '70.01'));
    expect(b.report().fills.filter((f) => f.fill.side === 'SELL')).toHaveLength(0);
    b.consume(syntheticPaperQuote(71, '65', '65.01'));
    const r = b.report(),
      exits = r.fills.filter((f) => f.fill.side === 'SELL');
    expect(exits).toHaveLength(3);
    expect(exits.every((e) => Number(e.fill.price) < 95 && e.trigger === 'STOP')).toBe(true);
    expect(r.balances.filter((b) => b.asset === 'BTC').every((b) => b.free === '0')).toBe(true);
    expect(r.equity.filter((e) => e.portfolio === 'NEWS_ONLY').at(-1)!.unrealizedNetPnl).toBe('0');
    expect(verifyPaperReport(r)).toEqual(r);
  });
  it('market interruption produces unknown equity rather than invented prices', () => {
    const f = paperFixture(),
      b = new PaperBroker(f.config);
    for (const e of f.events) b.consume(e);
    b.consume({
      kind: 'SAFETY',
      id: 'synthetic:outage',
      at: at(64),
      code: 'MARKET_OUTAGE',
      sourceId: f.config.source.id,
      rawHash: null,
    });
    expect(b.report().equity.at(-1)!.equity).toBeNull();
    b.consume(trade(65, '99.99'));
    expect(b.report().fills).toHaveLength(6);
  });
  it('preserves exact public integer IDs, milliseconds and aggressor semantics', () => {
    const { config } = paperFixtureConfig(),
      raw =
        '{"e":"trade","E":1767225662001,"s":"BTCUSDT","t":9007199254740993,"p":"99.99","q":"4","T":1767225662000,"m":true,"M":true}',
      e = decodePublicPaperTrade(
        raw,
        'BTCUSDT',
        'public:source',
        at(63),
        config.instruments[0]!.metadataHash,
      );
    if (e.kind !== 'TRADE') throw new Error('Trade expected');
    expect(e.providerEventId).toBe('trade:9007199254740993');
    expect(e.providerAt).toBe('2026-01-01T00:01:02.000000000Z');
    expect(e.providerEventAt).toBe('2026-01-01T00:01:02.001000000Z');
    expect(e.aggressor).toBe('SELL');
    expect(() =>
      decodePublicPaperTrade(
        raw,
        'ETHUSDT',
        'public:source',
        at(63),
        config.instruments[0]!.metadataHash,
      ),
    ).toThrow(/symbol/);
  });
});
