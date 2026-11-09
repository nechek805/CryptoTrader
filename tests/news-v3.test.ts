import { it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { canonicalHash } from '@crypto/core';
import { structureNewsV3, v3ReplayEvents } from '../packages/research/src/news-events-v3.js';
import { v3Candidates, fitNewsV3, buildV3Model } from '../packages/backtest/src/news-history-v3.js';
import {
  decodeNewsMinuteBars,
  selectNewsMinuteWindows,
  collectNewsMinuteDiagnostics,
} from '../packages/research/src/news-minute-windows.js';
import { newsResearchPlan, NEWS_HOUR } from '../packages/research/src/news-history-study.js';
import { initialLiveNewsSources } from '../packages/news/src/live-source-catalog.js';
import { LiveNewsVersionSchema } from '../packages/contracts/src/live-news.js';
import type { MacroExpectation, V3Event } from '../packages/contracts/src/news-research-v3.js';
import { marketHistoryFixture } from './helpers/market-history.js';
import { BtcHourSchema } from '../packages/contracts/src/btc-test.js';
import { marketByteHash } from '../packages/research/src/market-test-history.js';

const H = NEWS_HOUR,
  MINUTE = 60000;
function snapshot(title: string, sourceId = 'ethereum-updates', extra = {}) {
  const source = {
      ...initialLiveNewsSources().find((s) => s.id === sourceId)!,
      name: 'Synthetic source',
    },
    plan = newsResearchPlan(Date.UTC(2025, 6, 1));
  const v = LiveNewsVersionSchema.parse({
    id: canonicalHash(title).slice(7),
    articleId: canonicalHash('synthetic article ' + title).slice(7),
    sourceId,
    sourceRevision: 1,
    revision: 1,
    publisher: source.name,
    independenceGroup: source.independenceGroup,
    title,
    url: 'https://news.example.test/synthetic',
    providerItemId: 'synthetic',
    excerpt: '',
    language: 'en',
    publishedAt: plan.from + 100 * H,
    publisherUpdatedAt: null,
    firstSeenAt: Date.now(),
    fetchedAt: Date.now(),
    availableAt: Date.now(),
    contentHash: 'synthetic',
    feedHash: 'synthetic',
    duplicateGroup: 'synthetic',
    timestampStatus: 'VALID',
    captureKind: 'INITIAL_SNAPSHOT',
    aiAllowed: true,
    ...extra,
  });
  return {
    plan,
    source,
    data: { capturedAt: Date.now(), total: 1, sources: [source], versions: [v] },
  };
}
it.each([
  ['Synthetic: Join us for an EF Protocol Reddit AMA', 'ROUTINE', 'HOLD_ROUTINE'],
  ['Synthetic: Glamsterdam on Hoodi Postponed', 'POSTPONED', 'HOLD_DELAY_OR_CANCELLATION'],
  ['Synthetic: Ethereum mainnet upgrade cancelled', 'CANCELLED', 'HOLD_DELAY_OR_CANCELLATION'],
  ['Synthetic: Ethereum testnet is now live', 'TESTNET', 'HOLD_PLANNED_OR_TESTNET'],
  ['Synthetic: Ethereum upgrade proposal open for voting', 'PROPOSED', 'HOLD_PLANNED_OR_TESTNET'],
  [
    'Synthetic: Ethereum was not hacked, no evidence of an exploit',
    'NEGATED',
    'HOLD_UNCERTAIN_OR_RESOLVED',
  ],
  [
    'Synthetic: Ethereum mainnet upgrade successfully activated',
    'ACTIVATED',
    'ELIGIBLE_FOR_DESCRIPTIVE_ESTIMATION',
  ],
])('extracts %s with an explicit status and evidence gate', (title, stage, gate) => {
  const s = snapshot(title),
    e = structureNewsV3(s.data, s.plan)[0]!;
  expect(e.stage).toBe(stage);
  expect(e.gate).toBe(gate);
  expect(e.assets).toContain('ETH');
  expect(e.evidenceQuotes).toContain(title);
  expect(e.availableAt).toBeGreaterThan(e.publishedAt!);
});
it('requires a point-in-time forecast and matching metric/unit for macro surprise', () => {
  const s = snapshot('CPI for all items increases 0.6% in September; synthetic fixture', 'bls-cpi'),
    v = s.data.versions[0]!;
  expect(structureNewsV3(s.data, s.plan)[0]!.gate).toBe('HOLD_MISSING_EXPECTATIONS');
  const forecast: MacroExpectation = {
    metric: 'CPI_MOM',
    unit: 'PERCENT',
    releaseAt: v.publishedAt!,
    observedAt: v.publishedAt! - 60000,
    publishedAt: v.publishedAt! - 120000,
    value: '0.4' as MacroExpectation['value'],
    sourceId: 'synthetic',
    url: 'https://news.example.test/forecast',
    contentHash: canonicalHash('synthetic forecast'),
  };
  const e = structureNewsV3(s.data, s.plan, [forecast])[0]!;
  expect(e.macro?.surprise).toBe('0.2');
  expect(e.group).toBe('CPI_MOM:ABOVE');
  expect(e.gate).toBe('ELIGIBLE_FOR_DESCRIPTIVE_ESTIMATION');
  expect(
    structureNewsV3(s.data, s.plan, [{ ...forecast, observedAt: v.publishedAt! + 1 }])[0]!.gate,
  ).toBe('HOLD_MISSING_EXPECTATIONS');
  expect(structureNewsV3(s.data, s.plan, [{ ...forecast, unit: 'PERSONS' }])[0]!.gate).toBe(
    'HOLD_MISSING_EXPECTATIONS',
  );
});
it('rejects undated, unpermitted and duplicate origin updates without converting collection time into publication', () => {
  const s = snapshot('Synthetic: Ethereum mainnet upgrade successfully activated');
  expect(
    structureNewsV3(
      {
        ...s.data,
        versions: [{ ...s.data.versions[0], publishedAt: null, timestampStatus: 'MISSING' }],
      },
      s.plan,
    )[0]!.gate,
  ).toBe('HOLD_UNDATED');
  expect(
    structureNewsV3({ ...s.data, sources: [{ ...s.source, aiAllowed: false }] }, s.plan)[0]!.gate,
  ).toBe('HOLD_PERMISSION');
  const duplicate = { ...s.data.versions[0]!, id: 'f'.repeat(64), articleId: 'e'.repeat(64) };
  const events = structureNewsV3(
    { ...s.data, total: 2, versions: [...s.data.versions, duplicate] },
    s.plan,
  );
  expect(v3ReplayEvents(events)).toHaveLength(1);
  expect(events.filter((e) => e.gate === 'HOLD_DUPLICATE')).toHaveLength(1);
});
function pulseStudy(side: 'LONG' | 'SHORT' = 'LONG') {
  const plan = newsResearchPlan(Date.UTC(2025, 6, 1)),
    h = marketHistoryFixture('BTC', 1, (plan.to - plan.from) / H);
  h.bars = h.bars.map((b) =>
    BtcHourSchema.parse({ ...b, open: '100', high: '101', low: '99', close: '100' }),
  );
  const events: V3Event[] = [];
  for (let day = 2; day < 180; day += 4) {
    const index = day * 24 + 2;
    for (let j = index; j < index + 4; j++)
      h.bars[j] = BtcHourSchema.parse({
        ...h.bars[j]!,
        high: side === 'LONG' ? '104' : '101',
        low: side === 'LONG' ? '99' : '96',
        close: side === 'LONG' ? '103' : '97',
      });
    const s = snapshot('Synthetic: Ethereum mainnet upgrade successfully activated'),
      base = structureNewsV3(s.data, s.plan)[0]!;
    events.push({
      ...base,
      id: canonicalHash({ synthetic: day, side }),
      assets: ['BTC'],
      publishedAt: plan.from + (index - 1) * H,
      group: side === 'LONG' ? 'PROTOCOL:ACTIVATED' : 'SECURITY:CONFIRMED',
    });
  }
  return { plan, h, events };
}
it.each(['LONG', 'SHORT'] as const)(
  'can simulate supported %s opinions with fees and financing while staying unqualified',
  (side) => {
    const { plan, h, events } = pulseStudy(side),
      model = buildV3Model(events, h, plan),
      test = model.evaluations[2]!;
    expect(model.config.id).not.toContain('CASH');
    expect(test.trades.length).toBeGreaterThan(5);
    expect(test.trades.every((t) => t.side === side)).toBe(true);
    expect(Number(test.fees)).toBeGreaterThan(0);
    if (side === 'SHORT') expect(Number(test.financing)).toBeGreaterThan(0);
    expect(model.qualifiedForForwardTest).toBe(false);
    expect(model.walkForward).toHaveLength(3);
  },
  20000,
);
it('purges training labels, enforces the evidence policy and does not select using test-period prices', () => {
  const { plan, h, events } = pulseStudy(),
    config = v3Candidates()[0]!;
  expect(v3Candidates()).toHaveLength(6);
  expect(() => fitNewsV3(events, h, plan, { ...config, minSamples: 3 })).toThrow(
    'frozen evidence policy',
  );
  const original = fitNewsV3(events, h, plan, config);
  const modified = {
    ...h,
    bars: h.bars.map((b) =>
      b.at >= plan.trainEnd - 72 * H
        ? BtcHourSchema.parse({ ...b, open: '1000', high: '1200', low: '900', close: '1100' })
        : b,
    ),
  };
  expect(fitNewsV3(events, modified, plan, config)).toEqual(original);
});
function rawMinutes(from: number, n: number) {
  return JSON.stringify(
    Array.from({ length: n }, (_, i) => [
      from + i * MINUTE,
      '100',
      '102',
      '99',
      '101',
      '10',
      from + (i + 1) * MINUTE - 1,
      '100',
      1,
      '1',
      '1',
      '0',
    ]),
  );
}
it('validates minute timestamps/gaps instead of silently treating minutes as hours', () => {
  const from = Date.UTC(2025, 0, 1);
  expect(decodeNewsMinuteBars(rawMinutes(from, 2), from, from + 2 * MINUTE)).toHaveLength(2);
  expect(() => decodeNewsMinuteBars(rawMinutes(from, 2), from, from + 3 * MINUTE)).toThrow(
    'Incomplete',
  );
  const rows = JSON.parse(rawMinutes(from, 2)) as (string | number)[][];
  rows[1]![6] = from + H - 1;
  expect(() => decodeNewsMinuteBars(JSON.stringify(rows), from, from + 2 * MINUTE)).toThrow(
    'unit or close',
  );
});
it('chooses minute diagnostics without future price data and keeps unavailable data missing', async () => {
  const { plan, events } = pulseStudy();
  expect(selectNewsMinuteWindows(events, plan).length).toBeLessThanOrEqual(24);
  const root = await mkdtemp(join(tmpdir(), 'news-v3-minutes-'));
  if (
    dirname(resolve(root)) !== resolve(tmpdir()) ||
    !root.split(/[\\/]/).at(-1)!.startsWith('news-v3-minutes-')
  )
    throw new Error('Unsafe fixture directory');
  try {
    const selected = events.slice(0, 1);
    const result = await collectNewsMinuteDiagnostics(
      root,
      selected,
      plan,
      async () => {},
      (path) => {
        const u = new URL(path, 'https://data-api.binance.vision'),
          from = Number(u.searchParams.get('startTime')),
          to = Number(u.searchParams.get('endTime')) + 1;
        const body = rawMinutes(from, (to - from) / MINUTE);
        return Promise.resolve({
          url: u.href,
          body,
          hash: marketByteHash(body),
          receivedAt: new Date().toISOString(),
        });
      },
    );
    expect(result[0]!.status).toBe('COMPLETE');
    expect(result[0]!.return60m).toBeCloseTo(0.01);
    const missing = await collectNewsMinuteDiagnostics(
      root,
      events.slice(1, 2),
      plan,
      async () => {},
      () => Promise.reject(new Error('Synthetic outage')),
    );
    expect(missing[0]!.status).toBe('UNAVAILABLE');
    expect(missing[0]!.return5m).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
