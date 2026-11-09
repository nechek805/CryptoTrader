import { it, expect } from 'vitest';
import { canonicalHash } from '@crypto/core';
import { marketHistoryFixture } from './helpers/market-history.js';
import {
  newsResearchPlan,
  NEWS_HOUR,
  newsHistoryClassify,
  prepareNewsHistory,
  eventEntryIndex,
  newsHistorySamples,
} from '../packages/research/src/news-history-study.js';
import {
  replayNewsHistory,
  fitNewsResearchRules,
  newsResearchCandidates,
  buildNewsHistoryReport,
} from '../packages/backtest/src/news-history-replay.js';
import { initialLiveNewsSources } from '../packages/news/src/live-source-catalog.js';
import { LiveNewsVersionSchema } from '../packages/contracts/src/live-news.js';
import type { ResearchEvent, ResearchConfig } from '../packages/contracts/src/news-research.js';
import { BtcHourSchema } from '../packages/contracts/src/btc-test.js';
import { D } from '../packages/backtest/src/spot-math.js';

const history = () => marketHistoryFixture('BTC', 1, 600);
function fixturePlan() {
  const h = history();
  return {
    ...newsResearchPlan(),
    from: h.from,
    trainEnd: h.from + 400 * NEWS_HOUR,
    validationEnd: h.from + 500 * NEWS_HOUR,
    to: h.to,
  };
}
const config: ResearchConfig = {
  id: 'synthetic-config',
  horizonHours: 4,
  minSamples: 3,
  edgeBuffer: 1,
  uncertaintyZ: 0,
};
function event(index = 10, side: 'LONG' | 'SHORT' | 'HOLD' = 'LONG'): ResearchEvent {
  const h = history();
  return {
    id: canonicalHash({ syntheticEvent: index, side }),
    versionId: 'synthetic',
    sourceId: 'synthetic',
    publisher: 'Synthetic fixture',
    independenceGroup: 'synthetic',
    url: 'https://news.example.test/synthetic',
    title: 'Synthetic BTC protocol event',
    assets: ['BTC'],
    group: 'PROTOCOL',
    publishedAt: h.from + index * NEWS_HOUR,
    availableAt: Date.now(),
    fixedSide: side,
    scope: 'DIRECT',
    timing: 'DESCRIPTIVE_PUBLICATION_PROXY',
  };
}
function syntheticSnapshot() {
  const source = {
    ...initialLiveNewsSources().find((s) => s.id === 'ethereum-updates')!,
    name: 'Synthetic protocol source',
  };
  const plan = fixturePlan(),
    publishedAt = plan.from + 20 * NEWS_HOUR;
  const v = LiveNewsVersionSchema.parse({
    id: 'a'.repeat(64),
    articleId: 'b'.repeat(64),
    sourceId: source.id,
    sourceRevision: 1,
    revision: 1,
    publisher: source.name,
    independenceGroup: source.independenceGroup,
    title: 'Synthetic Ethereum protocol upgrade',
    url: 'https://news.example.test/synthetic',
    providerItemId: 'synthetic',
    excerpt: 'Synthetic fixture metadata.',
    language: 'en',
    publishedAt,
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
  });
  return { capturedAt: Date.now(), total: 1, sources: [source], versions: [v] };
}
it('retains archive availability, refuses truncated exports and excludes undated/revoked records', () => {
  const input = syntheticSnapshot(),
    result = prepareNewsHistory(input, fixturePlan());
  expect(result.events).toHaveLength(1);
  expect(result.coverage.eligibleHistoricalVersions).toBe(0);
  expect(result.events[0]!.availableAt).toBeGreaterThan(result.events[0]!.publishedAt);
  expect(() => prepareNewsHistory({ ...input, total: 2 }, fixturePlan())).toThrow('truncated');
  expect(
    prepareNewsHistory(
      {
        ...input,
        versions: [{ ...input.versions[0], publishedAt: null, timestampStatus: 'MISSING' }],
      },
      fixturePlan(),
    ).events,
  ).toHaveLength(0);
  expect(
    prepareNewsHistory(
      { ...input, sources: [{ ...input.sources[0], aiAllowed: false }] },
      fixturePlan(),
    ).coverage.permissionExcluded,
  ).toBe(1);
});
it('collapses repeated issuer/category updates without adding independent samples', () => {
  const input = syntheticSnapshot();
  const second = { ...input.versions[0]!, id: 'c'.repeat(64), articleId: 'd'.repeat(64) };
  const result = prepareNewsHistory(
    { ...input, total: 2, versions: [...input.versions, second] },
    fixturePlan(),
  );
  expect(result.events).toHaveLength(1);
  expect(result.coverage.deduplicated).toBe(1);
});
it('does not treat an old publication date as an executable observation timestamp', () => {
  const input = syntheticSnapshot(),
    result = prepareNewsHistory(input, fixturePlan());
  expect(result.events[0]!.timing).toBe('DESCRIPTIVE_PUBLICATION_PROXY');
  expect(result.events[0]!.availableAt).toBe(input.versions[0]!.availableAt);
});
it('classifies source scope and keeps negated/resolved incidents in HOLD', () => {
  expect(newsHistoryClassify('synthetic', 'Synthetic Solana protocol upgrade').assets).toContain(
    'SOL',
  );
  expect(newsHistoryClassify('synthetic', 'Synthetic Chainlink protocol upgrade').assets).toContain(
    'LINK',
  );
  expect(newsHistoryClassify('bls-cpi', 'Synthetic inflation release').assets).toHaveLength(10);
  const uncertain = newsHistoryClassify(
    'synthetic',
    'Synthetic BTC was not hacked; no evidence of an exploit',
  );
  expect(uncertain.fixedSide).toBe('HOLD');
  const e = { ...event(), ...uncertain };
  expect(
    replayNewsHistory(
      history(),
      [e],
      fixturePlan(),
      config,
      [{ group: e.group, count: 10, side: 'SHORT', meanExcessReturn: -0.1, standardError: 0 }],
      'TRAIN',
    ).trades,
  ).toHaveLength(0);
});
it('uses the next available hourly open after the declared news latency', () => {
  const h = history(),
    e = { ...event(), publishedAt: h.from + 10 * NEWS_HOUR + 58 * 60000 };
  expect(eventEntryIndex(e, h, 300000)).toBe(12);
});
it('selects the adverse stop when both OHLC stop and target are touched and charges costs once', () => {
  const h = history();
  h.bars = h.bars.map((b) =>
    BtcHourSchema.parse({ ...b, open: '100', high: '101', low: '99', close: '100' }),
  );
  h.bars[11] = BtcHourSchema.parse({ ...h.bars[11]!, high: '110', low: '90' });
  const r = replayNewsHistory(h, [event()], fixturePlan(), config, null, 'TRAIN'),
    t = r.trades[0]!;
  expect(t.reason).toBe('STOP');
  expect(t.status).toBe('LOSS');
  expect(Number(t.fees)).toBeGreaterThan(0);
  expect(Number(t.slippageCost)).toBeGreaterThan(0);
  expect(new D(r.endingUsdt).eq(new D(10000).plus(t.netPnl))).toBe(true);
  const stressed = replayNewsHistory(h, [event()], fixturePlan(), config, null, 'TRAIN', {
    costMultiplier: 2,
  });
  expect(Number(stressed.netPnl)).toBeLessThan(Number(r.netPnl));
});
it('models short proceeds as collateralized exposure, includes financing and fills adverse gaps', () => {
  const h = history();
  h.bars = h.bars.map((b) =>
    BtcHourSchema.parse({ ...b, open: '100', high: '101', low: '99', close: '100' }),
  );
  h.bars[12] = BtcHourSchema.parse({
    ...h.bars[12]!,
    open: '110',
    high: '112',
    low: '109',
    close: '111',
  });
  const e = event(10, 'SHORT'),
    r = replayNewsHistory(
      h,
      [e, { ...e, id: canonicalHash('second synthetic event') }],
      fixturePlan(),
      config,
      null,
      'TRAIN',
    );
  const t = r.trades[0]!;
  expect(t.side).toBe('SHORT');
  expect(t.reason).toBe('STOP');
  expect(Number(t.exitPrice)).toBeGreaterThan(110);
  expect(Number(t.financing)).toBeGreaterThan(0);
  expect(new D(r.endingUsdt).eq(new D(10000).plus(t.netPnl))).toBe(true);
  expect(r.skipped.POSITION_ALREADY_OPEN).toBe(1);
  expect(Number(t.quantity) * Number(t.entryPrice)).toBeLessThanOrEqual(2000);
});
it('purges labels crossing the training cutoff and cannot fit from changed validation/test prices', () => {
  const h = history(),
    p = fixturePlan(),
    events = [50, 60, 70, 399].map((i) => event(i));
  const rows = newsHistorySamples(events, h, 4, p.from, p.trainEnd, p.latencyMs);
  expect(rows.some((r) => r.event.publishedAt >= p.trainEnd - NEWS_HOUR)).toBe(false);
  const before = fitNewsResearchRules(events, h, p, config);
  const changed = {
    ...h,
    bars: h.bars.map((b, i) =>
      i >= 400
        ? BtcHourSchema.parse({ ...b, open: '10000', high: '20000', low: '5000', close: '15000' })
        : b,
    ),
  };
  expect(fitNewsResearchRules(events, changed, p, config)).toEqual(before);
  expect(newsResearchCandidates()).toHaveLength(36);
  expect(new Set(newsResearchCandidates().map((c) => c.id)).size).toBe(36);
});
it('keeps insufficient evidence in cash and refuses synthetic market data in the real report builder', async () => {
  const h = history(),
    r = replayNewsHistory(h, [event()], fixturePlan(), config, [], 'TRAIN');
  expect(r.netPnl).toBe('0.00000000');
  expect(r.trades).toHaveLength(0);
  const input = syntheticSnapshot();
  await expect(
    buildNewsHistoryReport(input, fixturePlan(), [
      { asset: 'BTC', history: h, hash: canonicalHash(h), error: null },
    ]),
  ).rejects.toThrow('frozen window mismatch');
});
