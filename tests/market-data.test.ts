import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { buildMarketQueryApp } from '@crypto/api';
import {
  CrossVenueQuerySchema,
  MarketDataQuerySchema,
  MarketDatasetSchema,
  MarketQualityArtifactSchema,
  MarketObservationSchema,
  UniverseRequestSchema,
} from '@crypto/contracts';
import type { MarketDataset } from '@crypto/contracts';
import { canonicalHash, decimal, fromEpoch, isDecimalMultipleOf } from '@crypto/core';
import { marketQualityFixture } from '@crypto/connectors';
import {
  buildMarketQualityArtifact,
  SnapshotMarketData,
  verifyMarketQualityArtifact,
  writeMarketQualityArtifact,
  marketObservationFromBar,
} from '@crypto/research';
import { fixtureQualityRequest } from '../apps/cli/src/market-quality.js';
import { createDomainFixtures } from './fixtures/domain.js';

const at = (ms: number) => fromEpoch(1767225600000n + BigInt(ms), 'milliseconds');
const fixtureRequest = fixtureQualityRequest();
const universe = fixtureRequest.universe;
const quality = fixtureRequest.quality[0]!;
const comparison = fixtureRequest.comparisons[0]!;
const query = (instrumentKey = 'alpha:SPOT:BTC', decisionAt = at(243000), to = at(240000)) =>
  MarketDataQuerySchema.parse({
    schemaVersion: 'market-data-query.v1',
    sourceId: 'synthetic:alpha',
    instrumentKey,
    decisionAt,
    from: at(0),
    to,
    intervalSeconds: 60,
    mode: 'ELIGIBLE',
  });
const history = (instrumentKey = 'alpha:SPOT:OLD', decisionAt = at(243000)) => ({
  schemaVersion: 'market-history-query.v1',
  sourceId: 'synthetic:alpha',
  instrumentKey,
  decisionAt,
});
const resolution = (
  providerSymbol: string,
  marketAt = at(180000),
  decisionAt = at(243000),
  marketType = 'SPOT',
) => ({
  schemaVersion: 'market-resolve-query.v1',
  sourceId: 'synthetic:alpha',
  providerSymbol,
  marketType,
  marketAt,
  decisionAt,
});
const change = (mutate: (dataset: MarketDataset) => void) => {
  const fixture = marketQualityFixture();
  mutate(fixture);
  return new SnapshotMarketData(fixture);
};
const sample = (dataset: MarketDataset, id = 'alpha:SPOT:BTC:sample:1:1') => {
  const row = dataset.observations.find((v) => v.id === id);
  if (!row) throw new Error('Missing fixture');
  return row;
};
const directories: string[] = [];
async function temporary() {
  const path = await mkdtemp(join(tmpdir(), 'crypto-quality-'));
  directories.push(path);
  return path;
}
afterEach(async () => {
  for (const path of directories.splice(0)) {
    if (
      dirname(resolve(path)) !== resolve(tmpdir()) ||
      !basename(path).startsWith('crypto-quality-')
    )
      throw new Error('Invalid cleanup target');
    await rm(path, { recursive: true, force: true });
  }
});

describe('point-in-time metadata and universes', () => {
  it('retains delisted history and membership before, but not at/after, delisting', () => {
    const data = new SnapshotMarketData(marketQualityFixture());
    const before = data.universe({ ...universe, decisionAt: at(121000), to: at(120000) });
    expect(before.selected[0]?.instrument.instrumentKey).toBe('alpha:SPOT:OLD');
    const after = data.universe(universe);
    expect(after.excluded).toContainEqual({ instrumentKey: 'alpha:SPOT:OLD', reason: 'DELISTED' });
    expect(data.history(history()).revisions).toHaveLength(2);
    expect(data.query(query('alpha:SPOT:OLD')).rows.map((v) => v.windowEnd)).toEqual([
      at(60000),
      at(120000),
      at(180000),
    ]);
    expect(data.resolve(resolution('OLDUSDT', at(180000))).instrument).toBe(null);
  });
  it('hides an unseen listing and excludes it until its first eligible observation', () => {
    const data = new SnapshotMarketData(marketQualityFixture());
    const before = data.universe({
      ...universe,
      decisionAt: at(179999),
      to: at(120000),
      maxWindowAgeMs: 60000,
    });
    expect(JSON.stringify(before)).not.toContain('alpha:SPOT:NEW');
    expect(data.history(history('alpha:SPOT:NEW', at(179999))).revisions).toHaveLength(0);
    expect(data.query(query('alpha:SPOT:NEW', at(180000), at(180000))).rows).toHaveLength(0);
    const first = data.universe({
      ...universe,
      from: at(120000),
      to: at(180000),
      decisionAt: at(180100),
      count: 5,
    });
    expect(first.selected[0]?.instrument.instrumentKey).toBe('alpha:SPOT:NEW');
  });
  it('uses completed historical volume/liquidity, retaining fewer than N when data fail gates', () => {
    const data = new SnapshotMarketData(marketQualityFixture()),
      result = data.universe(universe);
    expect(result.selected.map((v) => [v.instrument.instrumentKey, v.quoteVolume])).toEqual([
      ['alpha:SPOT:BTC', '4000'],
      ['alpha:SPOT:ETH', '2800'],
    ]);
    expect(result.excluded).toContainEqual({ instrumentKey: 'alpha:SPOT:SOL', reason: 'COVERAGE' });
    expect(result.excluded).toContainEqual({ instrumentKey: 'alpha:SPOT:NEW', reason: 'COVERAGE' });
    expect(data.universe({ ...universe, count: 1 }).excluded).toContainEqual({
      instrumentKey: 'alpha:SPOT:ETH',
      reason: 'RANK',
    });
    expect(result.selected[0]?.metadataIds).toEqual([
      'alpha:SPOT:BTC:metadata:1',
      'alpha:SPOT:BTC:metadata:2',
    ]);
  });
  it('does not use observations or corrections made available after a decision', () => {
    const data = change((dataset) => {
      const original = sample(dataset);
      dataset.observations.push({
        ...original,
        id: `${original.id}:correction`,
        revision: 2,
        quoteVolume: decimal('999999999'),
        observedAt: at(300000),
        availableAt: at(300000),
      });
    });
    expect(data.universe(universe).selected[0]?.quoteVolume).toBe('4000');
    const later = data.universe({
      ...universe,
      decisionAt: at(300000),
      maxWindowAgeMs: 60000,
      maxObservationAgeMs: 60000,
      maxAbsDriftMs: 300000,
    });
    expect(later.selected[0]?.quoteVolume).toBe('1000002999');
    expect(data.query(query()).rows[0]?.revision).toBe(1);
  });
  it('does not fall back to an eligible old value after a descriptive correction', () => {
    const data = change((dataset) => {
      const original = sample(dataset);
      dataset.observations.push({
        ...original,
        id: `${original.id}:correction`,
        revision: 2,
        observedAt: at(200000),
        availableAt: null,
        availabilityBasis: 'UNKNOWN',
        researchUse: 'DESCRIPTIVE_ONLY',
      });
    });
    expect(data.query(query()).rows).toHaveLength(3);
    const descriptive = data.query({ ...query(), mode: 'DESCRIPTIVE_ONLY' });
    expect(descriptive.rows).toHaveLength(4);
    expect(descriptive.rows[0]?.revision).toBe(2);
    expect(data.universe(universe).excluded).toContainEqual({
      instrumentKey: 'alpha:SPOT:BTC',
      reason: 'COVERAGE',
    });
  });
  it('cannot use historical archives with unknown availability for eligible selection', () => {
    const data = change((dataset) => {
      for (const row of dataset.observations) {
        row.availableAt = null;
        row.availabilityBasis = 'UNKNOWN';
        row.researchUse = 'DESCRIPTIVE_ONLY';
      }
    });
    expect(data.universe(universe).selected).toHaveLength(0);
    expect(data.query(query()).rows).toHaveLength(0);
    expect(data.query({ ...query(), mode: 'DESCRIPTIVE_ONLY' }).rows).toHaveLength(4);
  });
  it('preserves effective/knowledge time for precision changes and pair renames', () => {
    const data = new SnapshotMarketData(marketQualityFixture());
    expect(data.resolve(resolution('BTCUSDT', at(120000), at(120000))).instrument?.tickSize).toBe(
      '0.01',
    );
    expect(data.resolve(resolution('BTCUSDT', at(120000), at(125000))).instrument?.tickSize).toBe(
      '0.1',
    );
    expect(data.resolve(resolution('SOLUSDT', at(60000))).instrument?.instrumentKey).toBe(
      'alpha:SPOT:SOL',
    );
    expect(data.resolve(resolution('SOLUSDT')).instrument).toBe(null);
    expect(data.resolve(resolution('SOLXUSDT')).instrument?.baseAssetId).toBe('asset:SOL');
  });
  it('keeps spot and perpetual mappings distinct and unavailable derivative data explicit', () => {
    const data = new SnapshotMarketData(marketQualityFixture());
    expect(data.resolve(resolution('BTCUSDT')).instrument?.marketType).toBe('SPOT');
    expect(
      data.resolve(resolution('BTCUSDT', at(180000), at(243000), 'PERPETUAL')).instrument
        ?.marketType,
    ).toBe('PERPETUAL');
    const rows = data.query(query('alpha:PERPETUAL:BTC')).rows;
    expect(rows[0]?.derivatives.fundingRate.status).toBe('UNAVAILABLE');
    expect(rows[0]?.derivatives.fundingRate).not.toHaveProperty('value');
    expect(data.universe(universe).selected.every((v) => v.instrument.marketType === 'SPOT')).toBe(
      true,
    );
    expect(data.quality(fixtureRequest.quality.at(-1)!).unavailableMetrics.fundingRate).toBe(1);
  });
  it('applies independent volume, liquidity, coverage and window freshness rules', () => {
    const data = new SnapshotMarketData(marketQualityFixture());
    expect(data.universe({ ...universe, minQuoteVolume: '4001' }).selected).toHaveLength(0);
    expect(
      data
        .universe({ ...universe, minLiquidityQuote: '400' })
        .selected.map((v) => v.instrument.baseCode),
    ).toEqual(['BTC']);
    expect(data.universe({ ...universe, maxWindowAgeMs: 2999 }).excluded).toContainEqual({
      instrumentKey: 'alpha:SPOT:BTC',
      reason: 'STALE_WINDOW',
    });
    expect(data.universe({ ...universe, minCoverageFraction: '0.5' }).excluded).toContainEqual({
      instrumentKey: 'alpha:SPOT:SOL',
      reason: 'MISSING_METRICS',
    });
  });
  it('ranks decimal volumes beyond float precision exactly and breaks ties by key', () => {
    const data = change((dataset) => {
      for (const row of dataset.observations)
        if (row.sourceId === 'synthetic:alpha' && row.instrumentKey.includes(':SPOT:'))
          row.quoteVolume = decimal(
            row.instrumentKey.endsWith('ETH') ? '9007199254740993' : '9007199254740992',
          );
    });
    expect(data.universe(universe).selected.map((v) => v.instrument.baseCode)).toEqual([
      'ETH',
      'BTC',
    ]);
    const tied = change((dataset) => {
      for (const row of dataset.observations)
        if (row.instrumentKey === 'alpha:SPOT:ETH') {
          row.quoteVolume = decimal('1000');
          row.liquidityQuote = decimal('500');
        }
    });
    expect(tied.universe(universe).selected.map((v) => v.instrument.baseCode)).toEqual([
      'BTC',
      'ETH',
    ]);
  });
  it('rejects stale observations and bad timestamp drift even when coverage is relaxed', () => {
    const stale = change((dataset) => {
      dataset.observations = dataset.observations.filter(
        (v) => v.id !== 'alpha:SPOT:BTC:sample:4:1',
      );
    });
    expect(stale.universe({ ...universe, minCoverageFraction: '0.75' }).excluded).toContainEqual({
      instrumentKey: 'alpha:SPOT:BTC',
      reason: 'STALE_OBSERVATION',
    });
    const drift = change((dataset) => {
      sample(dataset).providerAt = at(1000);
    });
    expect(drift.universe(universe).excluded).toContainEqual({
      instrumentKey: 'alpha:SPOT:BTC',
      reason: 'DRIFT',
    });
  });
  it('does not import a late delisting announcement into an earlier universe', () => {
    const data = change((dataset) => {
      const announcement = dataset.instruments.find((v) => v.id === 'alpha:SPOT:OLD:metadata:2')!;
      announcement.observedAt = at(200000);
      announcement.availableAt = at(200000);
    });
    const before = data.universe({ ...universe, to: at(180000), decisionAt: at(180100) });
    expect(before.selected[0]?.instrument.instrumentKey).toBe('alpha:SPOT:OLD');
    expect(data.universe(universe).excluded).toContainEqual({
      instrumentKey: 'alpha:SPOT:OLD',
      reason: 'DELISTED',
    });
  });
});

describe('market quality and conservative source joins', () => {
  it('reports golden missingness, spikes, drift and missing derivative metrics', () => {
    const report = buildMarketQualityArtifact(
      marketQualityFixture(),
      fixtureRequest,
      'fixture-code.v1',
    ).report;
    expect(
      report.quality.map((v) => [
        v.request.instrumentKey,
        v.missingFraction,
        v.spikes.length,
        v.driftViolationIds.length,
      ]),
    ).toEqual([
      ['alpha:SPOT:BTC', '0', 0, 0],
      ['alpha:SPOT:ETH', '0', 0, 0],
      ['alpha:SPOT:SOL', '0.25', 0, 1],
      ['beta:SPOT:BTC', '0', 0, 0],
      ['beta:SPOT:ETH', '0', 0, 4],
      ['beta:SPOT:SOL', '0', 2, 1],
      ['alpha:PERPETUAL:BTC', '0.75', 0, 0],
    ]);
    expect(report.quality[2]?.missingEnds).toEqual([at(120000)]);
    expect(report.quality[4]?.maxAbsReceiptDriftMs).toBe('1000');
    expect(report.quality[5]?.spikes.map((v) => v.changeBps)).toEqual([
      '5000',
      '3333.333333333333333333',
    ]);
    expect(
      report.comparisons.map((v) => [
        v.matches.length,
        v.unmatchedLeftIds.length,
        v.matches.filter((m) => m.divergent).length,
      ]),
    ).toEqual([
      [4, 0, 0],
      [0, 4, 0],
      [3, 0, 1],
    ]);
  });
  it('does not count unlisted slots as missing and reports undefined fractions with no eligible slots', () => {
    const data = new SnapshotMarketData(marketQualityFixture());
    const result = data.quality({ ...quality, instrumentKey: 'alpha:SPOT:NEW' });
    expect([result.expectedSlots, result.ineligibleSlots, result.missingSlots]).toEqual([2, 2, 0]);
    const before = data.quality({
      ...quality,
      instrumentKey: 'alpha:SPOT:NEW',
      to: at(120000),
      decisionAt: at(120000),
    });
    expect(before.expectedSlots).toBe(0);
    expect(before.missingFraction).toBe(null);
  });
  it('rejects off-tick, wrong-symbol, mid-window metadata and invalid derivative attribution visibly', () => {
    const data = change((dataset) => {
      sample(dataset, 'alpha:SPOT:BTC:sample:3:1').price = decimal('100.01');
    });
    expect(data.query(query()).excluded).toContainEqual({
      id: 'alpha:SPOT:BTC:sample:3:1',
      reason: 'PRECISION',
    });
    const badSymbol = change((dataset) => {
      sample(dataset).providerSymbol = 'ETHUSDT';
    });
    expect(badSymbol.query(query()).excluded[0]?.reason).toBe('MAPPING');
    const badDerivative = change((dataset) => {
      sample(dataset).derivatives.fundingRate = { status: 'KNOWN', value: decimal('0') };
    });
    expect(badDerivative.query(query()).excluded[0]?.reason).toBe('DERIVATIVE_STATUS');
    const boundary = change((dataset) => {
      const revision = dataset.instruments.find((v) => v.id === 'alpha:SPOT:BTC:metadata:2')!;
      revision.effectiveFrom = at(90000);
    });
    expect(boundary.query(query()).excluded).toContainEqual({
      id: 'alpha:SPOT:BTC:sample:2:1',
      reason: 'METADATA_CHANGE',
    });
  });
  it('requires explicit source IDs and tolerance; wider tolerance is an explicit different query', () => {
    const data = new SnapshotMarketData(marketQualityFixture());
    const missingTolerance = { ...comparison, toleranceMs: undefined };
    expect(() => data.compare(missingTolerance)).toThrow();
    expect(() =>
      data.compare({ ...comparison, left: { instrumentKey: 'alpha:SPOT:BTC' } }),
    ).toThrow();
    expect(() => data.compare({ ...comparison, toleranceMs: -1 })).toThrow();
    const eth = fixtureRequest.comparisons[1]!;
    expect(data.compare(eth).matches).toHaveLength(0);
    expect(data.compare({ ...eth, toleranceMs: 900 }).matches).toHaveLength(4);
    expect(data.compare({ ...eth, toleranceMs: 900 }).matches[0]?.lagMs).toBe('900');
  });
  it('forbids same-venue, different asset, quote and spot/perpetual comparisons', () => {
    const data = new SnapshotMarketData(marketQualityFixture());
    expect(() => data.compare({ ...comparison, right: comparison.left })).toThrow();
    expect(() =>
      data.compare({
        ...comparison,
        right: { sourceId: 'synthetic:beta', instrumentKey: 'beta:SPOT:ETH' },
      }),
    ).toThrow();
    expect(() =>
      data.compare({
        ...comparison,
        left: { sourceId: 'synthetic:alpha', instrumentKey: 'alpha:PERPETUAL:BTC' },
      }),
    ).toThrow();
    const differentQuote = change((dataset) => {
      for (const row of dataset.instruments)
        if (row.instrumentKey === 'beta:SPOT:BTC') row.quoteAssetId = 'asset:USDC';
    });
    expect(() => differentQuote.compare(comparison)).toThrow();
    expect(() =>
      data.compare({
        ...comparison,
        right: { sourceId: 'synthetic:alpha', instrumentKey: 'beta:SPOT:BTC' },
      }),
    ).toThrow();
  });
  it('never joins a later provider price, reuses a right row or backdates joined availability', () => {
    const data = change((dataset) => {
      sample(dataset, 'beta:SPOT:BTC:sample:1:1').providerAt = at(60001);
    });
    const result = data.compare(comparison);
    expect(result.unmatchedLeftIds).toContain('alpha:SPOT:BTC:sample:1:1');
    expect(new Set(result.matches.map((v) => v.rightId)).size).toBe(result.matches.length);
    for (const match of result.matches)
      expect(match.availableAt <= comparison.decisionAt).toBe(true);
    const sol = new SnapshotMarketData(marketQualityFixture()).compare(
      fixtureRequest.comparisons[2]!,
    );
    expect(sol.matches.find((v) => v.leftId.includes(':sample:3:'))?.availableAt).toBe(at(182000));
  });
  it('does not compute a one-step spike across a missing interval', () => {
    const data = change((dataset) => {
      sample(dataset, 'alpha:SPOT:SOL:sample:3:1').price = decimal('1000');
    });
    expect(
      data.quality({ ...quality, instrumentKey: 'alpha:SPOT:SOL' }).spikes.map((v) => v.id),
    ).toEqual(['alpha:SPOT:SOL:sample:4:1']);
  });
  it('validates tick multiples without rounding or changing decimal global context', () => {
    expect(
      isDecimalMultipleOf(decimal('100.000000000000000001'), decimal('0.000000000000000001')),
    ).toBe(true);
    expect(isDecimalMultipleOf(decimal('100.01'), decimal('0.1'))).toBe(false);
    expect(() => isDecimalMultipleOf(decimal('1'), decimal('0'))).toThrow();
  });
  it('does not reuse one right-hand observation for two nearby left timestamps', () => {
    const data = change((dataset) => {
      sample(dataset, 'alpha:SPOT:BTC:sample:2:1').providerAt = at(60001);
    });
    const result = data.compare(comparison);
    expect(result.matches.filter((v) => v.rightId === 'beta:SPOT:BTC:sample:1:1')).toHaveLength(1);
    expect(result.unmatchedLeftIds).toContain('alpha:SPOT:BTC:sample:2:1');
  });
  it('retains off-grid evidence as an exclusion rather than rounding timestamps', () => {
    const data = change((dataset) => {
      const row = sample(dataset);
      row.windowStart = at(1);
      row.windowEnd = at(60001);
    });
    expect(data.query(query()).excluded).toContainEqual({
      id: 'alpha:SPOT:BTC:sample:1:1',
      reason: 'GRID_ALIGNMENT',
    });
    expect(data.quality(quality).missingEnds).toEqual([at(60000)]);
  });
  it('projects existing bars with lineage and unknown book/turnover metrics without promoting candles', () => {
    const dataset = marketQualityFixture(),
      instrument = dataset.instruments.find((v) => v.id === 'alpha:SPOT:BTC:metadata:1')!;
    const bar = { ...createDomainFixtures().marketBar, exchange: instrument.venue };
    const row = marketObservationFromBar(bar, instrument, 1);
    expect(row.quality).toBe('CANDLE_ONLY');
    expect(row.evidence).toEqual({ id: bar.id, contentHash: canonicalHash(bar) });
    expect(row.quoteVolume).toBe(null);
    expect(row.liquidityQuote).toBe(null);
    dataset.observations = dataset.observations.filter((v) => v.id !== 'alpha:SPOT:BTC:sample:1:1');
    dataset.observations.push(row);
    const data = new SnapshotMarketData(dataset);
    expect(data.query(query()).rows[0]?.id).toBe(row.id);
    expect(data.universe(universe).excluded).toContainEqual({
      instrumentKey: 'alpha:SPOT:BTC',
      reason: 'MISSING_METRICS',
    });
    expect(data.compare(comparison).unmatchedLeftIds).toContain(row.id);
    expect(MarketObservationSchema.safeParse({ ...row, liquidityQuote: '999' }).success).toBe(
      false,
    );
  });
  it('preserves unknown historical availability in bar projection and refuses incorrect bindings', () => {
    const instrument = marketQualityFixture().instruments.find(
      (v) => v.id === 'alpha:SPOT:BTC:metadata:1',
    )!;
    const original = createDomainFixtures().marketBar,
      bar = { ...original, exchange: instrument.venue };
    expect(() => marketObservationFromBar(original, instrument, 1)).toThrow();
    expect(() =>
      marketObservationFromBar({ ...bar, instrumentId: 'ETH/USDT' }, instrument, 1),
    ).toThrow();
    expect(() => marketObservationFromBar(bar, instrument, 0)).toThrow();
    const row = marketObservationFromBar(
      { ...bar, availableAt: null, availabilityBasis: 'UNKNOWN', researchUse: 'DESCRIPTIVE_ONLY' },
      instrument,
      1,
    );
    expect(row.availableAt).toBe(null);
    expect(row.researchUse).toBe('DESCRIPTIVE_ONLY');
  });
});

describe('snapshot and boundary failures', () => {
  it('is deterministic under input reordering and isolates both input/output mutation', () => {
    const input = marketQualityFixture(),
      data = new SnapshotMarketData(input);
    input.instruments.reverse();
    input.observations.reverse();
    input.sources.reverse();
    expect(new SnapshotMarketData(input).datasetHash).toBe(data.datasetHash);
    sample(input).price = decimal('999');
    expect(data.query(query()).rows[0]?.price).toBe('100');
    const result = data.query(query());
    expect(Object.isFrozen(result.rows[0]?.derivatives)).toBe(true);
    expect(() => {
      result.rows[0]!.price = decimal('200');
    }).toThrow();
  });
  it('rejects duplicate/reused identity, conflicting revisions and source mismatches', () => {
    expect(() =>
      change((dataset) => {
        dataset.instruments.push(dataset.instruments[0]!);
      }),
    ).toThrow();
    expect(() =>
      change((dataset) => {
        const duplicate = { ...dataset.instruments[0]!, id: 'different-id' };
        dataset.instruments.push(duplicate);
      }),
    ).toThrow();
    expect(() =>
      change((dataset) => {
        const row = dataset.instruments.find((v) => v.id === 'alpha:SPOT:BTC:metadata:2')!;
        row.marketType = 'PERPETUAL';
        row.derivatives = {
          fundingRate: 'UNAVAILABLE',
          openInterest: 'UNAVAILABLE',
          markPrice: 'UNAVAILABLE',
        };
      }),
    ).toThrow();
    expect(() =>
      change((dataset) => {
        sample(dataset).sourceId = 'synthetic:beta';
      }),
    ).toThrow();
    expect(() =>
      change((dataset) => {
        const original = sample(dataset);
        dataset.observations.push({ ...original, id: 'new-id' });
      }),
    ).toThrow();
    expect(() =>
      change((dataset) => {
        const row = dataset.instruments.find((v) => v.id === 'alpha:SPOT:BTC:metadata:2')!;
        row.observedAt = at(0);
        row.availableAt = at(0);
      }),
    ).not.toThrow();
    expect(() =>
      change((dataset) => {
        const original = sample(dataset);
        dataset.observations.push({
          ...original,
          id: 'regressed-revision',
          revision: 2,
          observedAt: at(60000),
          availableAt: at(60000),
        });
      }),
    ).toThrow();
  });
  it('fails closed for simultaneous provider-symbol reuse without changing earlier queries', () => {
    const data = change((dataset) => {
      const row = dataset.instruments.find((v) => v.instrumentKey === 'alpha:SPOT:ETH')!;
      dataset.instruments.push({
        ...row,
        id: 'future-symbol-collision',
        revision: 2,
        providerSymbol: 'BTCUSDT',
        effectiveFrom: at(0),
        observedAt: at(200000),
        availableAt: at(200000),
      });
    });
    expect(data.query(query('alpha:SPOT:BTC', at(120100), at(120000))).rows).toHaveLength(2);
    expect(data.query(query()).excluded.every((v) => v.reason === 'AMBIGUOUS_MAPPING')).toBe(true);
    expect(() => data.resolve(resolution('BTCUSDT'))).toThrow();
    expect(data.universe(universe).excluded).toContainEqual({
      instrumentKey: 'alpha:SPOT:BTC',
      reason: 'AMBIGUOUS_MAPPING',
    });
  });
  it.each([0, -1, 1.5, 86401])(
    'rejects invalid interval %s without schema arithmetic errors',
    (intervalSeconds) => {
      expect(MarketDataQuerySchema.safeParse({ ...query(), intervalSeconds }).success).toBe(false);
    },
  );
  it('rejects future/unbounded/misaligned windows, extra fields and implicit selection defaults', () => {
    expect(() => MarketDataQuerySchema.parse({ ...query(), decisionAt: at(120000) })).toThrow();
    expect(() => MarketDataQuerySchema.parse({ ...query(), from: at(1) })).toThrow();
    expect(() =>
      MarketDataQuerySchema.parse({
        ...query(),
        to: at(60000 * 2001),
        decisionAt: at(60000 * 2001),
      }),
    ).toThrow();
    expect(() => MarketDataQuerySchema.parse({ ...query(), apiKey: 'hidden' })).toThrow();
    const missingSource = { ...universe, sourceId: undefined };
    expect(UniverseRequestSchema.safeParse(missingSource).success).toBe(false);
    expect(CrossVenueQuerySchema.safeParse({ ...comparison, toleranceMs: 60001 }).success).toBe(
      false,
    );
    const malformed = marketQualityFixture();
    (malformed.observations[0] as unknown as { price: number }).price = 0.1;
    expect(MarketDatasetSchema.safeParse(malformed).success).toBe(false);
  });
});

describe('report artifact and HTTP query API', () => {
  it('publishes and recomputes reproducible immutable artifacts', async () => {
    const root = await temporary(),
      first = await writeMarketQualityArtifact(
        marketQualityFixture(),
        fixtureRequest,
        root,
        'fixture-code.v1',
      );
    const before = await stat(first.path),
      second = await writeMarketQualityArtifact(
        marketQualityFixture(),
        fixtureRequest,
        root,
        'fixture-code.v1',
      );
    expect(second.hash).toBe(first.hash);
    expect((await stat(first.path)).mtimeMs).toBe(before.mtimeMs);
    expect((await verifyMarketQualityArtifact(first.path)).artifact).toEqual(first.artifact);
    const separate = await writeMarketQualityArtifact(
      marketQualityFixture(),
      fixtureRequest,
      await temporary(),
      'fixture-code.v1',
    );
    expect(await readFile(separate.path)).toEqual(await readFile(first.path));
    expect(MarketQualityArtifactSchema.safeParse(first.artifact).success).toBe(true);
  });
  it('refuses report/config/input tampering and never overwrites a conflicting artifact', async () => {
    const root = await temporary(),
      result = await writeMarketQualityArtifact(
        marketQualityFixture(),
        fixtureRequest,
        root,
        'fixture-code.v1',
      );
    const body = await readFile(result.path, 'utf8'),
      artifact = MarketQualityArtifactSchema.parse(JSON.parse(body));
    artifact.report.comparisons[0]!.matches = [];
    await writeFile(result.path, JSON.stringify(artifact));
    await expect(verifyMarketQualityArtifact(result.path)).rejects.toThrow('integrity');
    await expect(
      writeMarketQualityArtifact(marketQualityFixture(), fixtureRequest, root, 'fixture-code.v1'),
    ).rejects.toThrow();
    expect(JSON.parse(await readFile(result.path, 'utf8'))).toEqual(artifact);
    expect(canonicalHash(artifact)).not.toBe(result.hash);
  });
  it('serves versioned read-only queries and rejects missing sources/tolerances without reflecting input', async () => {
    const app = buildMarketQueryApp(new SnapshotMarketData(marketQualityFixture()));
    try {
      for (const [name, payload] of [
        ['query', query()],
        ['history', history()],
        ['resolve', resolution('BTCUSDT')],
        ['universe', universe],
        ['quality', quality],
        ['compare', comparison],
      ] as const) {
        const response = await app.inject({
          method: 'POST',
          url: `/market/${name}`,
          payload,
          headers: { 'x-request-id': 'untrusted-id' },
        });
        expect(response.statusCode).toBe(200);
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.headers['x-request-id']).not.toBe('untrusted-id');
      }
      const response = await app.inject({
        method: 'POST',
        url: '/market/compare',
        payload: { ...comparison, toleranceMs: undefined, apiKey: 'sensitive-input' },
      });
      expect(response.statusCode).toBe(400);
      expect(response.body).not.toContain('sensitive-input');
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/market/query',
            headers: { 'content-type': 'application/json' },
            payload: '{broken',
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/market/query',
            payload: { data: 'x'.repeat(17000) },
          })
        ).statusCode,
      ).toBe(413);
      expect((await app.inject({ method: 'POST', url: '/orders', payload: {} })).statusCode).toBe(
        404,
      );
    } finally {
      await app.close();
    }
  });
  it('runs the fixture report CLI and verifier, refusing non-fixture providers and endpoint flags', async () => {
    const execute = promisify(execFile),
      root = await temporary();
    const result = await execute(process.execPath, [
      '--import',
      'tsx',
      'apps/cli/src/market.ts',
      'quality',
      '--provider',
      'fixture',
      '--out',
      root,
    ]);
    const report = JSON.parse(result.stdout) as {
      path: string;
      universe: string[];
      origin: string;
    };
    expect(report.origin).toBe('SYNTHETIC');
    expect(report.universe).toEqual(['alpha:SPOT:BTC', 'alpha:SPOT:ETH']);
    const verified = await execute(process.execPath, [
      '--import',
      'tsx',
      'apps/cli/src/market.ts',
      'verify-quality',
      '--artifact',
      report.path,
    ]);
    expect(JSON.parse(verified.stdout)).toMatchObject({ verified: true });
    for (const flags of [
      ['--provider', 'binance-public'],
      ['--url', 'sensitive-input'],
    ])
      await expect(
        execute(process.execPath, [
          '--import',
          'tsx',
          'apps/cli/src/market.ts',
          'quality',
          ...flags,
        ]),
      ).rejects.toThrow();
  });
});
