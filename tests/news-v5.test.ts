import { it, expect, vi } from 'vitest';
import { canonicalHash } from '@crypto/core';
import { BtcHourSchema } from '../packages/contracts/src/btc-test.js';
import type { V4Report } from '../packages/contracts/src/news-research-v4.js';
import {
  buildV5Model,
  selectNewsV5,
  v5ReplayEvents,
  v5Candidates,
  attributeNewsV2,
} from '../packages/backtest/src/news-history-v5.js';
import { loadFrozenNewsMarket } from '../packages/research/src/news-frozen-markets-v5.js';
import { syntheticV5Study } from './helpers/news-v5.js';

it('learns both directions from news categories and pays fees/short financing without qualifying synthetic profit for live trading', () => {
  const { events, prices, plan } = syntheticV5Study(),
    model = buildV5Model(events, prices, plan),
    test = model.evaluations[2]!;
  expect(v5Candidates()).toHaveLength(3);
  expect(test.trades.length).toBeGreaterThan(5);
  expect(new Set(test.trades.map((t) => t.side)).size).toBe(2);
  expect(Number(test.fees)).toBeGreaterThan(0);
  expect(Number(test.financing)).toBeGreaterThan(0);
  expect(model.groupChecks.some((c) => c.accepted)).toBe(true);
  expect(model.qualifiedForForwardTest).toBe(false);
}, 30000);
it('never uses final-period prices or event categories to select a candidate or direction', () => {
  const { events, prices, plan } = syntheticV5Study(),
    original = selectNewsV5(events, prices, plan);
  const changed = {
    ...prices,
    bars: prices.bars.map((b) =>
      b.at >= plan.validationEnd
        ? BtcHourSchema.parse({ ...b, open: '1000', high: '1300', low: '800', close: '1100' })
        : b,
    ),
  };
  expect(
    selectNewsV5(
      events.filter((e) => e.publishedAt < plan.validationEnd),
      changed,
      plan,
    ),
  ).toEqual(original);
}, 30000);
it('abstains on insufficient samples, flat price reactions and a failing validation period', () => {
  const { events, prices, plan } = syntheticV5Study();
  expect(selectNewsV5(events.slice(-3), prices, plan).rules).toHaveLength(0);
  const flat = {
    ...prices,
    bars: prices.bars.map((b) =>
      BtcHourSchema.parse({ ...b, open: '100', high: '100.1', low: '99.9', close: '100' }),
    ),
  };
  expect(selectNewsV5(events, flat, plan).rules).toHaveLength(0);
  const valLoss = {
    ...prices,
    bars: prices.bars.map((b) =>
      b.at >= plan.trainEnd
        ? BtcHourSchema.parse({ ...b, high: '100.1', low: '99.9', close: '100' })
        : b,
    ),
  };
  expect(selectNewsV5(events, valLoss, plan).rules).toHaveLength(0);
}, 30000);
it('keeps permission, rumor, unknown-date and planned-event gates while permitting a declared unconditional macro-release hypothesis', () => {
  const { events } = syntheticV5Study();
  const gates = [
    'HOLD_PERMISSION',
    'HOLD_UNCERTAIN_OR_RESOLVED',
    'HOLD_UNDATED',
    'HOLD_PLANNED_OR_TESTNET',
    'HOLD_MISSING_EXPECTATIONS',
    'ELIGIBLE_FOR_DESCRIPTIVE_ESTIMATION',
  ];
  const legacyEvents = events.slice(0, 6),
    facts = legacyEvents.map((e, i) => ({
      ...e,
      sourceId: 'bls-cpi-history',
      kind: 'MACRO',
      attribution: 'OFFICIALLY_STATED',
      gate: gates[i],
      macro: { metric: 'CPI_MOM', actual: null },
    }));
  const output = v5ReplayEvents({ legacyEvents, events: facts } as unknown as V4Report);
  expect(output.map((e) => e.versionId)).toEqual(legacyEvents.slice(4).map((e) => e.versionId));
  expect(output.every((e) => e.group === 'INFLATION_RELEASE')).toBe(true);
});
it('reports exact V2 contribution accounting and concentration without claiming causal proof', () => {
  const { events, prices, plan } = syntheticV5Study(),
    model = buildV5Model(events, prices, plan);
  const a = attributeNewsV2({ ...model, version: 'LEARNED_V2' }, events);
  expect(a.groups.reduce((n, b) => n + Number(b.netPnl), 0)).toBeCloseTo(
    Number(model.evaluations[2]!.netPnl),
    6,
  );
  expect(Number(a.withoutLargestWin) + Number(a.largestWin)).toBeCloseTo(
    Number(model.evaluations[2]!.netPnl),
    6,
  );
}, 30000);
it('fails closed on missing frozen chunks with no replacement download', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  await expect(
    loadFrozenNewsMarket('data/nonexistent-v5-test-cache', {
      version: 'chunked-news-market.v4',
      asset: 'BTC',
      from: 0,
      to: 3600000,
      chunks: [{ id: canonicalHash('synthetic absent'), from: 0, to: 3600000 }],
      bars: 1,
      priceHash: canonicalHash('synthetic'),
    }),
  ).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});

it('deduplicates issuer releases before grouping and retains unchanged numeric releases without pretending they are surprises', () => {
  const { events } = syntheticV5Study(),
    base = events[0]!;
  const fact = {
    ...base,
    sourceId: 'bls-cpi-history',
    kind: 'MACRO',
    attribution: 'OFFICIALLY_STATED',
    gate: 'HOLD_UNCERTAIN_OR_RESOLVED',
    featureSign: 0,
    macro: { metric: 'CPI_MOM', actual: '0.2' },
  };
  const output = v5ReplayEvents({
    events: [fact, { ...fact, id: canonicalHash('synthetic repeated RSS'), sourceId: 'bls-cpi' }],
    legacyEvents: [base, { ...base, group: 'CPI_MOM:UNKNOWN' }],
  } as unknown as V4Report);
  expect(output).toHaveLength(1);
  expect(output[0]!.group).toBe('INFLATION_RELEASE');
});
