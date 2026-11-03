import { describe, expect, expectTypeOf, it } from 'vitest';
import fc from 'fast-check';
import { MarketBarSchema, NewsDocumentSchema } from '@crypto/contracts';
import type { DecimalString, MarketBar, UtcTimestamp } from '@crypto/contracts';
import {
  addDecimal,
  subtractDecimal,
  multiplyDecimal,
  divideDecimal,
  equalDecimal,
  decimal,
  utc,
  fromEpoch,
  toEpoch,
  compareTimes,
  SyntheticClock,
  MockClock,
  canonicalHash,
  canonicalJson,
  deterministicId,
  SeededRandom,
  decisionView,
  isAvailableAt,
} from '@crypto/core';
import { createDomainFixtures } from './fixtures/domain.js';

describe('typed UTC and explicit epoch units', () => {
  it('brands normalized instants and preserves nanoseconds across the year boundary', () => {
    expectTypeOf(utc('2026-01-01T00:00:00Z')).toEqualTypeOf<UtcTimestamp>();
    expectTypeOf<string>().not.toExtend<UtcTimestamp>();
    expect(utc('2026-01-01T00:00:00.1Z')).toBe('2026-01-01T00:00:00.100000000Z');
    const clock = new SyntheticClock('2025-12-31T23:59:59.999999999Z');
    expect(clock.advanceBy(1n, 'nanoseconds')).toBe('2026-01-01T00:00:00.000000000Z');
    expect(compareTimes(utc('2026-01-01T00:00:00.000000001Z'), clock.now())).toBe(1);
    expect(() => clock.advanceTo('2025-12-31T23:59:59Z')).toThrow('backwards');
    expect(() => clock.advanceBy(-1n, 'seconds')).toThrow('nonnegative');
    expect(new MockClock(clock.now()).now()).toBe(clock.now());
  });

  it('never infers units and refuses lossy conversion, unsafe numeric epochs or unsupported dates', () => {
    expect(fromEpoch(1n, 'seconds')).toBe('1970-01-01T00:00:01.000000000Z');
    expect(fromEpoch(1n, 'milliseconds')).toBe('1970-01-01T00:00:00.001000000Z');
    expect(toEpoch(utc('1970-01-01T00:00:00.001001000Z'), 'microseconds')).toBe(1001n);
    expect(() => toEpoch(utc('1970-01-01T00:00:00.000000001Z'), 'milliseconds')).toThrow(
      'precision',
    );
    expect(() => fromEpoch(-1n, 'nanoseconds')).toThrow();
    expect(() => fromEpoch(253402300800n, 'seconds')).toThrow('9999');
    // @ts-expect-error Explicit bigint epochs are mandatory at the public boundary.
    expect(() => fromEpoch(1000, 'milliseconds')).toThrow('bigint');
    // @ts-expect-error Units must be explicit and supported.
    expect(() => fromEpoch(1n, 'auto')).toThrow();
    for (const value of [
      '2025-02-29T00:00:00Z',
      '2026-01-01T24:00:00Z',
      '1969-12-31T23:59:59Z',
      '2026-01-01T00:00:00+03:00',
    ])
      expect(() => utc(value)).toThrow();
    expect(utc('2024-02-29T00:00:00Z')).toContain('2024-02-29');
  });

  it('round-trips 300 randomized nanosecond epochs with no floating-point precision loss', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 253402300799999999999n }), (epoch) => {
        expect(toEpoch(fromEpoch(epoch, 'nanoseconds'), 'nanoseconds')).toBe(epoch);
      }),
      { seed: 42, numRuns: 300 },
    );
  });

  it('synthetic clocks advance monotonically and replay the same increments', () => {
    fc.assert(
      fc.property(fc.array(fc.nat(1000), { maxLength: 30 }), (steps) => {
        const a = new SyntheticClock('2026-01-01T00:00:00Z'),
          b = new MockClock(a.now());
        for (const step of steps) {
          const before = a.now();
          a.advanceBy(BigInt(step), 'microseconds');
          b.advanceBy(BigInt(step), 'microseconds');
          expect(compareTimes(before, a.now())).not.toBe(1);
          expect(a.now()).toBe(b.now());
        }
      }),
      { seed: 42, numRuns: 100 },
    );
  });
});

describe('decimal-safe money and quantities', () => {
  it('uses exact decimal strings for arithmetic and semantic equality', () => {
    expectTypeOf(decimal('0.1')).toEqualTypeOf<DecimalString>();
    expectTypeOf<number>().not.toExtend<DecimalString>();
    expect(addDecimal(decimal('0.1'), decimal('0.2'))).toBe('0.3');
    expect(subtractDecimal(decimal('10000'), decimal('10.01'))).toBe('9989.99');
    expect(multiplyDecimal(decimal('0.00000001'), decimal('100000.01'))).toBe('0.0010000001');
    expect(equalDecimal(decimal('1.000'), decimal('1'))).toBe(true);
    expect(addDecimal(decimal('9007199254740993'), decimal('1'))).toBe('9007199254740994');
    expect(
      addDecimal(
        decimal('0.000000000000000000000000000000000001'),
        decimal('0.000000000000000000000000000000000001'),
      ),
    ).toBe('0.000000000000000000000000000000000002');
    // @ts-expect-error Financial helper input must be a validated decimal string.
    expect(() => decimal(0.1)).toThrow();
  });

  it('requires explicit rounding for division and rejects zero divisors or output overflow', () => {
    expect(divideDecimal(decimal('1'), decimal('3'), 6, 'DOWN')).toBe('0.333333');
    expect(divideDecimal(decimal('1'), decimal('3'), 6, 'UP')).toBe('0.333334');
    expect(divideDecimal(decimal('1.005'), decimal('1'), 2, 'HALF_EVEN')).toBe('1');
    expect(divideDecimal(decimal('1.015'), decimal('1'), 2, 'HALF_EVEN')).toBe('1.02');
    expect(() => divideDecimal(decimal('1'), decimal('0'), 2, 'DOWN')).toThrow('zero');
    expect(() => divideDecimal(decimal('1'), decimal('3'), 37, 'DOWN')).toThrow('Scale');
    expect(() => multiplyDecimal(decimal('9'.repeat(80)), decimal('2'))).toThrow();
    expect(() => multiplyDecimal(decimal('0.' + '0'.repeat(35) + '1'), decimal('0.1'))).toThrow();
  });

  it('matches a bigint oracle for 300 randomized decimal additions', () => {
    const fixedSix = (units: bigint) =>
      `${units < 0n ? '-' : ''}${(units < 0n ? -units : units) / 1000000n}.${((units < 0n ? -units : units) % 1000000n).toString().padStart(6, '0')}`;
    const units = fc.bigInt({ min: -1000000000000000000n, max: 1000000000000000000n });
    fc.assert(
      fc.property(units, units, (left, right) => {
        expect(
          equalDecimal(
            addDecimal(decimal(fixedSix(left)), decimal(fixedSix(right))),
            decimal(fixedSix(left + right)),
          ),
        ).toBe(true);
      }),
      { seed: 42, numRuns: 300 },
    );
  });
});

describe('point-in-time data views', () => {
  const bar = createDomainFixtures().marketBar;
  const decision = utc('2026-01-01T00:01:01Z');

  it('allows exact-time availability and rejects data one nanosecond in the future', () => {
    expect(isAvailableAt(bar, decision)).toBe(true);
    expect(
      isAvailableAt({ ...bar, availableAt: utc('2026-01-01T00:01:01.000000001Z') }, decision),
    ).toBe(false);
    expect(
      isAvailableAt(
        {
          ...bar,
          availableAt: null,
          availabilityBasis: 'UNKNOWN',
          researchUse: 'DESCRIPTIVE_ONLY',
        },
        decision,
      ),
    ).toBe(false);
    expect(() => isAvailableAt({ ...bar, availableAt: null }, decision)).toThrow();
  });

  it('gives a model only eligible records; extreme future prices cannot alter its result', () => {
    const model = (data: ReturnType<typeof decisionView<MarketBar>>) =>
      data.records.map((record) => record.close).join(',');
    const future = {
      ...bar,
      id: 'future:bar',
      availableAt: '2026-01-01T00:01:02Z',
      high: '999999999',
      close: '999999999',
    };
    const baseline = model(decisionView(MarketBarSchema, [bar], decision));
    expect(model(decisionView(MarketBarSchema, [bar, future], decision))).toBe(baseline);
    expect(
      model(
        decisionView(
          MarketBarSchema,
          [bar, { ...future, high: '999999999999999', close: '999999999999999' }],
          decision,
        ),
      ),
    ).toBe(baseline);
    expect(decisionView(MarketBarSchema, [bar, future], decision).records).toHaveLength(1);
  });

  it('excludes descriptive-only historical news even with an old publication time', () => {
    const news = createDomainFixtures().newsDocument;
    const historical = {
      ...news,
      publishedAt: '2020-01-01T00:00:00Z',
      availableAt: null,
      availabilityBasis: 'UNKNOWN',
      researchUse: 'DESCRIPTIVE_ONLY',
    };
    expect(
      decisionView(NewsDocumentSchema, [historical], utc('2030-01-01T00:00:00Z')).records,
    ).toHaveLength(0);
  });

  it('detaches and deeply freezes records and arrays so later corrections cannot rewrite a decision', () => {
    const raw = { ...bar, provenance: { ...bar.provenance, sourceIds: ['source:before'] } };
    const view = decisionView(MarketBarSchema, [raw], decision);
    raw.provenance.sourceIds[0] = 'source:after';
    expect(view.records[0]?.provenance.sourceIds).toEqual(['source:before']);
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view.records)).toBe(true);
    expect(Object.isFrozen(view.records[0]?.provenance.sourceIds)).toBe(true);
    expect(Reflect.set(view.records, '0', raw)).toBe(false);
    expect(Reflect.set(view.records, '1', raw)).toBe(false);
    expect(() => decisionView(MarketBarSchema, [{ ...bar, close: 'invalid' }], decision)).toThrow();
  });
});

describe('canonical hashing, IDs and controlled randomness', () => {
  it('has a stable SHA-256 encoding independent of object insertion order', () => {
    expect(canonicalJson({ z: [2, 1], a: { y: '1.00', x: true } })).toBe(
      '{"a":{"x":true,"y":"1.00"},"z":[2,1]}',
    );
    expect(canonicalHash({})).toBe(
      'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
    );
    expect(canonicalHash({ a: 1, b: 2 })).toBe(canonicalHash({ b: 2, a: 1 }));
    expect(canonicalHash(['a', 'b'])).not.toBe(canonicalHash(['b', 'a']));
    expect(canonicalHash('1.0')).not.toBe(canonicalHash('1'));
    expect(deterministicId('event', { a: 1, b: 2 })).toBe(deterministicId('event', { b: 2, a: 1 }));
    expect(deterministicId('event', {})).not.toBe(deterministicId('signal', {}));
    expect(() => deterministicId('../unsafe', {})).toThrow('namespace');
  });

  it('rejects ambiguous/non-JSON inputs, cycles, accessors and sparse arrays', () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const sparse = new Array<unknown>(2);
    for (const input of [
      undefined,
      1n,
      NaN,
      Infinity,
      new Date(),
      new Map(),
      cyclic,
      sparse,
      { a: undefined },
      { n: 9007199254740992 },
    ]) {
      expect(() => canonicalJson(input)).toThrow();
    }
    let called = false;
    expect(() =>
      canonicalJson({
        get danger() {
          called = true;
          return 1;
        },
      }),
    ).toThrow('Accessors');
    expect(called).toBe(false);
    const repeated = { x: 1 };
    expect(canonicalJson([repeated, repeated])).toBe('[{"x":1},{"x":1}]');
  });

  it('replays the versioned PRNG sequence and validates seeds and unbiased integer bounds', () => {
    const a = new SeededRandom(42),
      b = new SeededRandom(42);
    expect(a.algorithm).toBe('mulberry32.v1');
    expect(a.nextUint32()).toBe(2581720956);
    expect(b.nextUint32()).toBe(2581720956);
    for (let i = 0; i < 100; i++) expect(a.nextUint32()).toBe(b.nextUint32());
    expect(new SeededRandom(43).nextUint32()).not.toBe(new SeededRandom(42).nextUint32());
    for (const invalid of [-1, 0.5, 0x100000000, NaN])
      expect(() => new SeededRandom(invalid)).toThrow();
    for (const invalid of [0, -1, 1.5, 0x100000001]) expect(() => a.nextInt(invalid)).toThrow();
    for (let i = 0; i < 1000; i++) {
      expect(a.next()).toBeGreaterThanOrEqual(0);
      expect(a.next()).toBeLessThan(1);
      expect(a.nextInt(7)).toBeLessThan(7);
      expect(a.nextInt(7)).toBeGreaterThanOrEqual(0);
    }
    expect(a.nextInt(1)).toBe(0);
  });
});
