import { it, expect } from 'vitest';
import { mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { canonicalHash } from '@crypto/core';
import { freeNewsSources } from '../packages/news/src/live-source-catalog.js';
import { LiveNewsSourceSchema } from '../packages/contracts/src/live-news.js';
import {
  parseFreeNews,
  exchangeHeadlineSymbols,
} from '../packages/connectors/src/free-news-sources.js';
import {
  governmentPublicationAt,
  governmentReleaseItem,
  historyVersion,
  collectFreeNewsHistory,
} from '../packages/research/src/free-news-history.js';
import {
  structureNewsV4,
  v4MacroActual,
  legacyV3Events,
} from '../packages/research/src/news-events-v4.js';
import { newsV4Plan, legacyNewsPrices } from '../packages/research/src/news-long-history.js';
import type { NewsLongPrices } from '../packages/research/src/news-long-history.js';
import type { V4Event } from '../packages/contracts/src/news-research-v4.js';
import { v4Candidates, fitNewsV4, buildV4Model } from '../packages/backtest/src/news-history-v4.js';
import { replayNewsHistory } from '../packages/backtest/src/news-history-replay.js';
import { MarketHistorySchema } from '../packages/contracts/src/market-tests.js';
import { BtcHourSchema } from '../packages/contracts/src/btc-test.js';
import { marketHistoryFixture } from './helpers/market-history.js';

const H = 3600000,
  plan = newsV4Plan(Date.UTC(2026, 10, 7, 9));
const source = (id: string) => freeNewsSources(0).find((s) => s.id === id)!;
const json = (v: unknown) => Buffer.from(JSON.stringify(v));
function syntheticVersion(id: string, title: string, at: number, excerpt = '') {
  const s = { ...source(id), name: 'Synthetic ' + id };
  const v = historyVersion(
    s,
    {
      providerItemId: 'synthetic-' + at,
      url: s.articleOrigins[0] + '/synthetic/' + at,
      title: 'Synthetic: ' + title,
      excerpt,
      language: 'en',
      publishedAt: at,
      publisherUpdatedAt: null,
      timestampStatus: 'VALID',
    },
    { receivedAt: Date.now(), bodyHash: canonicalHash({ synthetic: true, title, at }) },
  );
  return { s, v };
}
it('registers fixed public adapters without credentials or enabling LLM use for notification metadata', () => {
  expect(freeNewsSources()).toHaveLength(9);
  expect(freeNewsSources().every((s) => s.collectionApproved && s.enabled)).toBe(true);
  expect(source('bybit-public-announcements').aiAllowed).toBe(false);
  expect(source('fed-statements-history').independenceGroup).toBe('federal-reserve');
  expect(source('sec-crypto-history').independenceGroup).toBe('sec');
  expect(() =>
    LiveNewsSourceSchema.parse({
      ...source('bybit-public-announcements'),
      feedUrl: 'https://127.0.0.1/private',
    }),
  ).toThrow();
});
it('uses Bybit publishTime only, not event/author timestamps, and rejects article origin injection', () => {
  const s = source('bybit-public-announcements'),
    at = plan.trainEnd;
  const row = {
    title: 'Synthetic SOL listing',
    url: 'https://announcements.bybit.com/en/synthetic',
    dateTimestamp: at,
    startDateTimestamp: at,
  };
  const parsed = parseFreeNews(
    json({
      retCode: 0,
      result: {
        total: 3,
        list: [
          row,
          { ...row, publishTime: at },
          { ...row, publishTime: at, url: 'https://evil.example.test/' },
        ],
      },
    }),
    s,
  );
  expect(parsed.items.map((v) => v.publishedAt)).toEqual([null, at]);
  expect(parsed.rejected).toBe(1);
});
it('maps exact exchange pair symbols for every token without modifying publisher quotes', () => {
  const title =
    'Synthetic New Listing: BTCUSDT, ETHUSDT, SOLUSDT, TRXUSDT, BNBUSDT, XRPUSDT, DOGEUSDT, ADAUSDT, LINKUSDT, AVAXUSDT';
  expect(exchangeHeadlineSymbols(title)).toHaveLength(10);
  expect(exchangeHeadlineSymbols('Synthetic NOTBTCUSDT and 1000XRPUSDT')).toEqual([]);
  const row = syntheticVersion('bybit-public-announcements', title, plan.trainEnd);
  const e = structureNewsV4(
    { capturedAt: Date.now(), sources: [row.s], total: 1, versions: [row.v] },
    plan,
  )[0]!;
  expect(e.assets).toHaveLength(10);
  expect(e.evidenceQuotes).toContain(row.v.title);
  expect(e.title).toBe(row.v.title);
});
it('preserves separate incident updates and never backdates a later edit or final resolution', () => {
  const at = plan.trainEnd,
    s = source('solana-public-incidents');
  const updates = [
    {
      id: 'a',
      status: 'identified',
      created_at: new Date(at).toISOString(),
      updated_at: new Date(at + H).toISOString(),
    },
    {
      id: 'b',
      status: 'resolved',
      created_at: new Date(at + 2 * H).toISOString(),
      updated_at: new Date(at + 2 * H).toISOString(),
    },
  ];
  const payload = {
    incidents: [
      {
        id: 'synthetic',
        name: 'Synthetic network outage',
        shortlink: 'https://status.solana.com/synthetic',
        incident_updates: updates,
      },
    ],
  };
  const rows = parseFreeNews(json(payload), s).items;
  expect(rows).toHaveLength(2);
  expect(rows[0]!.publishedAt).toBe(at + H);
  expect(rows[1]!.title).toContain('resolved');
  updates[0]!.updated_at = new Date(Date.now() + 86400000).toISOString();
  expect(parseFreeNews(json(payload), s).items[0]!.publishedAt).toBeNull();
});
it('requires validated amendment transactions and separates voting from activation', () => {
  const s = source('xrpl-ledger-amendments'),
    result = {
      validated: true,
      hash: 'A'.repeat(64),
      TransactionType: 'EnableAmendment',
      Amendment: 'B'.repeat(64),
      date: 800000000,
    };
  expect(parseFreeNews(json({ result }), s).items[0]!.title).toContain('activated');
  expect(parseFreeNews(json({ result: { ...result, Flags: 65536 } }), s).items[0]!.title).toContain(
    'voting',
  );
  expect(() => parseFreeNews(json({ result: { ...result, validated: false } }), s)).toThrow();
  expect(() => parseFreeNews(json({ result: { ...result, Flags: 123 } }), s)).toThrow();
});
it('does not promote GDELT seen time into publication time', () => {
  const r = parseFreeNews(
    json({
      articles: [
        {
          url: 'https://www.coindesk.com/synthetic',
          title: 'Synthetic Bitcoin update',
          seendate: '20260101T120000Z',
        },
      ],
    }),
    source('gdelt-public-discovery'),
  );
  expect(r.items[0]!.publishedAt).toBeNull();
});
it('preserves UTF-8 BOM bytes, labels synthetic transport fixtures, reuses frozen captures and rejects a changed corpus', async () => {
  const root = await mkdtemp(join(tmpdir(), 'news-v4-archive-'));
  if (
    dirname(resolve(root)) !== resolve(tmpdir()) ||
    !root.split(/[\\/]/).at(-1)!.startsWith('news-v4-archive-')
  )
    throw new Error('Unsafe fixture directory');
  const snapshot = {
    capturedAt: Date.now(),
    total: 0,
    versions: [],
    sources: freeNewsSources(0).map((s) => ({
      ...s,
      name: 'Synthetic ' + s.name,
      enabled: s.id === 'fed-statements-history',
    })),
  };
  let requests = 0;
  try {
    const corpus = await collectFreeNewsHistory(
      root,
      plan,
      snapshot,
      async () => {},
      (url) => {
        requests++;
        const body = url.includes('fomccalendars')
          ? '\uFEFF<a href="/newsevents/pressreleases/monetary20240131a.htm">HTML</a>'
          : '\uFEFFSynthetic For release at 2:00 p.m. EST. decided to maintain the target range at 5-1/4 to 5-1/2 percent';
        return Promise.resolve({ bytes: Buffer.from(body), status: 200 });
      },
      'SYNTHETIC',
    );
    expect(requests).toBe(2);
    expect(corpus.origin).toBe('SYNTHETIC');
    expect(corpus.snapshot.versions).toHaveLength(1);
    expect(corpus.snapshot.versions[0]!.publishedAt).toBe(Date.UTC(2024, 0, 31, 19));
    expect(
      await collectFreeNewsHistory(
        root,
        plan,
        snapshot,
        async () => {},
        () => Promise.reject(new Error('Synthetic unexpected request')),
        'SYNTHETIC',
      ),
    ).toEqual(corpus);
    const name = (await readdir(join(root, 'free-history'))).find((n) => n.startsWith('corpus-'))!,
      path = join(root, 'free-history', name);
    const frozen = JSON.parse(await readFile(path, 'utf8')) as {
      hash: string;
      corpus: typeof corpus;
    };
    frozen.corpus.snapshot.versions[0]!.title = 'Synthetic tampered archive';
    await writeFile(path, JSON.stringify(frozen));
    await expect(
      collectFreeNewsHistory(
        root,
        plan,
        snapshot,
        async () => {},
        () => Promise.reject(new Error('Synthetic unexpected request')),
        'SYNTHETIC',
      ),
    ).rejects.toThrow('integrity');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it('extracts release-header times including BLS identifiers and DST, and refuses date-only timestamps', () => {
  const url = 'https://www.bls.gov/news.release/archives/empsit_12082023.htm';
  const text =
    'Synthetic fixture. Transmission of material in this news release is embargoed until USDL-23-2530 8:30 a.m. (ET) Friday, December 8, 2023. Total nonfarm payroll employment increased by 199,000 in November.';
  expect(governmentPublicationAt(url, text)).toBe(Date.UTC(2023, 11, 8, 13, 30));
  expect(
    governmentPublicationAt(
      'https://www.bls.gov/news.release/archives/cpi_07112024.htm',
      'Synthetic embargoed until 8:30 a.m. (ET)',
    ),
  ).toBe(Date.UTC(2024, 6, 11, 12, 30));
  expect(governmentPublicationAt(url, 'Synthetic December 8, 2023')).toBeNull();
  const item = governmentReleaseItem(
    url,
    'Synthetic payroll release',
    text,
    source('bls-employment-history'),
  );
  expect(v4MacroActual({ ...item, sourceId: 'bls-employment-history' }).actual).toBe('199000');
  expect(
    v4MacroActual({
      sourceId: 'fed-statements-history',
      title: 'Synthetic statement',
      excerpt: 'decided to maintain the target range at 5-1/4 to 5-1/2 percent',
    }).actual,
  ).toBe('5.5');
});
it('uses only three earlier original releases for a clearly labelled non-consensus feature', () => {
  const rows = [0.1, 0.3, 0.2, 0.4].map((n, i) =>
    syntheticVersion(
      'bls-cpi-history',
      `CPI for all items increases ${n}%`,
      plan.from + (i + 1) * 30 * 24 * H,
    ),
  );
  const snapshot = {
    capturedAt: Date.now(),
    sources: [rows[0]!.s],
    total: rows.length,
    versions: rows.map((x) => x.v),
  };
  const events = structureNewsV4(snapshot, plan),
    last = events[3]!;
  expect(events.slice(0, 3).every((e) => e.gate === 'HOLD_MISSING_EXPECTATIONS')).toBe(true);
  expect(last.baseline?.value).toBe('0.2');
  expect(last.featureSign).toBe(1);
  expect(last.macro?.consensus).toBeNull();
  expect(last.baseline?.latestPriorPublicationAt).toBeLessThan(last.publishedAt!);
  const future = syntheticVersion(
    'bls-cpi-history',
    'CPI for all items increases 9%',
    plan.to - 10 * H,
  );
  expect(
    structureNewsV4(
      { ...snapshot, total: 5, versions: [...snapshot.versions, future.v] },
      plan,
    ).slice(0, 4),
  ).toEqual(events);
});
it('preserves metadata/permission boundaries and excludes rumors and voting', () => {
  const rows = [
    syntheticVersion('xrpl-ledger-amendments', 'XRP Ledger amendment ABC activated', plan.trainEnd),
    syntheticVersion(
      'xrpl-ledger-amendments',
      'XRP Ledger amendment ABC gained voting majority',
      plan.trainEnd + 24 * H,
    ),
    syntheticVersion(
      'bybit-public-announcements',
      'Rumor: BTC new listing',
      plan.trainEnd + 48 * H,
    ),
  ];
  const snap = {
    capturedAt: Date.now(),
    sources: [rows[0]!.s, rows[2]!.s],
    total: 3,
    versions: rows.map((x) => x.v),
  };
  const v4 = structureNewsV4(snap, plan),
    v3 = legacyV3Events(snap, plan);
  expect(v4[0]!.gate).toBe('ELIGIBLE_FOR_DESCRIPTIVE_ESTIMATION');
  expect(v3[0]!.gate).toBe('HOLD_PERMISSION');
  expect(v4[1]!.gate).toBe('HOLD_PLANNED_OR_TESTNET');
  expect(v4[2]!.gate).toBe('HOLD_UNCERTAIN_OR_RESOLVED');
  expect(
    structureNewsV4(
      {
        ...snap,
        sources: snap.sources.map((s) => ({
          ...s,
          collectionApproved: false,
          aiAllowed: false,
          enabled: false,
        })),
      },
      plan,
    ).every((e) => e.gate !== 'ELIGIBLE_FOR_DESCRIPTIVE_ESTIMATION'),
  ).toBe(true);
});
function pulseStudy(reverse = false) {
  const fixture = marketHistoryFixture(),
    prices: NewsLongPrices = {
      version: 'chunked-news-price-view.v4',
      origin: 'SYNTHETIC',
      instrument: fixture.instrument,
      from: plan.from,
      to: plan.to,
      bars: Array.from({ length: (plan.to - plan.from) / H }, (_, i) =>
        BtcHourSchema.parse({
          at: plan.from + i * H,
          open: '100',
          close: '100',
          high: '101',
          low: '99',
          volume: '1000000',
        }),
      ),
    };
  const base = syntheticVersion(
    'xrpl-ledger-amendments',
    'XRP Ledger amendment ABC activated',
    plan.from + H,
  );
  const template = structureNewsV4(
    { capturedAt: Date.now(), sources: [base.s], total: 1, versions: [base.v] },
    plan,
  )[0]!;
  const events: V4Event[] = [];
  for (let day = 10; day < (plan.to - plan.from) / (24 * H) - 4; day += 10) {
    const sign = day % 20 === 0 ? -1 : 1,
      move = sign * (reverse ? -1 : 1),
      index = day * 24 + 1;
    for (let j = index; j < index + 4; j++)
      prices.bars[j] = BtcHourSchema.parse({
        ...prices.bars[j]!,
        high: move > 0 ? '104' : '101',
        low: move > 0 ? '99' : '96',
        close: move > 0 ? '103' : '97',
      });
    events.push({
      ...template,
      id: canonicalHash({ synthetic: day, reverse }),
      assets: ['BTC'],
      publishedAt: plan.from + day * 24 * H,
      group: 'SYNTHETIC_SIGNED_EVENT',
      featureSign: sign,
    });
  }
  return { prices, events };
}
it.each([false, true])(
  'learns both directions with fees and financing instead of treating a positive feature as an automatic LONG (reverse=%s)',
  (reverse) => {
    const { prices, events } = pulseStudy(reverse),
      model = buildV4Model(events, prices, plan),
      test = model.evaluations[2]!;
    expect(test.trades.length).toBeGreaterThan(5);
    expect(new Set(test.trades.map((t) => t.side)).size).toBe(2);
    const map = new Map(events.map((e) => [e.id, e]));
    expect(
      test.trades.every(
        (t) => (t.side === 'LONG') === map.get(t.eventId)!.featureSign * (reverse ? -1 : 1) > 0,
      ),
    ).toBe(true);
    expect(Number(test.fees)).toBeGreaterThan(0);
    expect(Number(test.financing)).toBeGreaterThan(0);
    expect(model.qualifiedForForwardTest).toBe(false);
    expect(model.walkForward).toHaveLength(3);
  },
  30000,
);
it('purges future labels and refuses relaxed evidence settings', () => {
  const { prices, events } = pulseStudy(),
    config = v4Candidates()[0]!;
  expect(v4Candidates()).toHaveLength(6);
  const old = fitNewsV4(events, prices, plan, config),
    changed = {
      ...prices,
      bars: prices.bars.map((b) =>
        b.at >= plan.trainEnd - 72 * H
          ? BtcHourSchema.parse({ ...b, open: '1000', high: '1200', low: '900', close: '1100' })
          : b,
      ),
    };
  expect(fitNewsV4(events, changed, plan, config)).toEqual(old);
  expect(() => fitNewsV4(events, prices, plan, { ...config, minSamples: 3 })).toThrow(
    'evidence policy',
  );
});
it('does not count overlapping opposite feature signs as independent training observations', () => {
  const { prices, events } = pulseStudy(),
    first = events[0]!;
  const paired = [
    first,
    {
      ...first,
      id: canonicalHash('synthetic overlapping opposite sign'),
      publishedAt: first.publishedAt! + H,
      featureSign: -1 as const,
    },
  ];
  const fit = fitNewsV4(paired, prices, plan, { ...v4Candidates()[0]!, horizonHours: 72 });
  expect(fit.evidence[0]!.count).toBe(1);
  expect(fit.evidence[0]!.side).toBe('HOLD');
});
it('keeps the longer price projection separate from stored six-month datasets and preserves legacy fill math', () => {
  const h = marketHistoryFixture(),
    view: NewsLongPrices = {
      version: 'chunked-news-price-view.v4',
      origin: 'SYNTHETIC',
      instrument: h.instrument,
      from: h.from,
      to: h.to,
      bars: h.bars,
    };
  expect(MarketHistorySchema.safeParse(view).success).toBe(false);
  const p = {
      ...plan,
      from: h.from,
      trainEnd: h.from + 200 * H,
      validationEnd: h.from + 400 * H,
      to: h.to,
    },
    event = {
      id: canonicalHash('synthetic'),
      versionId: 'synthetic',
      sourceId: 'synthetic',
      publisher: 'Synthetic',
      independenceGroup: 'synthetic',
      url: 'https://news.example.test/synthetic',
      title: 'Synthetic BTC event',
      assets: ['BTC' as const],
      publishedAt: h.from + 410 * H,
      availableAt: Date.now(),
      group: 'SYNTHETIC',
      fixedSide: 'SHORT' as const,
      scope: 'DIRECT' as const,
      timing: 'DESCRIPTIVE_PUBLICATION_PROXY' as const,
    };
  const config = {
    id: 'synthetic',
    horizonHours: 4,
    minSamples: 0,
    edgeBuffer: 0,
    uncertaintyZ: 0,
  };
  expect(replayNewsHistory(legacyNewsPrices(view), [event], p, config, null, 'TEST')).toEqual(
    replayNewsHistory(h, [event], p, config, null, 'TEST'),
  );
});
