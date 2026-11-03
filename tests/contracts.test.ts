import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  EventEnvelopeSchema,
  eventEnvelopeSchema,
  MarketBarSchema,
  NewsDocumentSchema,
  EventClaimSchema,
  SignalCandidateSchema,
  RiskDecisionSchema,
  SimulatedOrderSchema,
  SimulatedFillSchema,
  LedgerEntrySchema,
  ExperimentManifestSchema,
  DecimalStringSchema,
  PositiveDecimalSchema,
  NonNegativeDecimalSchema,
  UnitDecimalSchema,
  UtcTimestampSchema,
  validateFillAgainstOrder,
} from '@crypto/contracts';
import { canonicalHash } from '@crypto/core';
import { createDomainFixtures } from './fixtures/domain.js';

const schemas = {
  eventEnvelope: EventEnvelopeSchema,
  marketBar: MarketBarSchema,
  newsDocument: NewsDocumentSchema,
  eventClaim: EventClaimSchema,
  signalCandidate: SignalCandidateSchema,
  riskDecision: RiskDecisionSchema,
  simulatedOrder: SimulatedOrderSchema,
  simulatedFill: SimulatedFillSchema,
  ledgerEntry: LedgerEntrySchema,
  experimentManifest: ExperimentManifestSchema,
};
const fixtures = createDomainFixtures();

describe('versioned domain contracts', () => {
  for (const [name, schema] of Object.entries(schemas)) {
    it(`${name} validates, round-trips JSON and rejects unknown fields/versions`, () => {
      const fixture = fixtures[name as keyof typeof fixtures];
      const serialized: unknown = JSON.parse(JSON.stringify(fixture));
      expect(schema.parse(serialized)).toEqual(fixture);
      expect(schema.safeParse({ ...fixture, schemaVersion: 'future.v999' }).success).toBe(false);
      expect(schema.safeParse({ ...fixture, privateWalletKey: 'forbidden' }).success).toBe(false);
    });
  }

  it('validates a typed envelope payload instead of trusting arbitrary JSON', () => {
    const schema = eventEnvelopeSchema(MarketBarSchema);
    expect(schema.parse(fixtures.eventEnvelope).payload).toEqual(fixtures.marketBar);
    expect(schema.safeParse({ ...fixtures.eventEnvelope, payload: { open: 1 } }).success).toBe(
      false,
    );
    expect(fixtures.eventEnvelope.rawHash).toBe(canonicalHash(fixtures.marketBar));
    expect(
      schema.safeParse({
        ...fixtures.eventEnvelope,
        payload: {
          ...fixtures.marketBar,
          availableAt: '2026-01-01T00:01:02Z',
        },
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        ...fixtures.eventEnvelope,
        payload: {
          ...fixtures.marketBar,
          researchUse: 'DESCRIPTIVE_ONLY',
        },
      }).success,
    ).toBe(false);
  });

  it('rejects floating money, invalid decimals and invalid OHLC ranges without throwing', () => {
    for (const input of [
      0.1,
      NaN,
      Infinity,
      'NaN',
      'Infinity',
      '1e-8',
      '01',
      '',
      ' 1',
      '0.' + '1'.repeat(37),
      '1'.repeat(81),
    ]) {
      for (const schema of [
        DecimalStringSchema,
        PositiveDecimalSchema,
        NonNegativeDecimalSchema,
        UnitDecimalSchema,
      ]) {
        expect(schema.safeParse(input).success).toBe(false);
      }
      expect(MarketBarSchema.safeParse({ ...fixtures.marketBar, high: input }).success).toBe(false);
    }
    expect(MarketBarSchema.safeParse({ ...fixtures.marketBar, high: '98' }).success).toBe(false);
    expect(MarketBarSchema.safeParse({ ...fixtures.marketBar, close: '-1' }).success).toBe(false);
    expect(
      MarketBarSchema.safeParse({ ...fixtures.marketBar, availableAt: fixtures.marketBar.openAt })
        .success,
    ).toBe(false);
    expect(MarketBarSchema.safeParse({ ...fixtures.marketBar, volume: '-1' }).success).toBe(false);
  });

  it('represents missing/uncertain values explicitly and retains disputed evidence', () => {
    expect(
      MarketBarSchema.safeParse({ ...fixtures.marketBar, interval: { value: 2, unit: 'minutes' } })
        .success,
    ).toBe(false);
    expect(fixtures.signalCandidate.score.status).toBe('MISSING');
    expect(
      EventClaimSchema.safeParse({ ...fixtures.eventClaim, confidence: { status: 'KNOWN' } })
        .success,
    ).toBe(false);
    expect(
      EventClaimSchema.safeParse({ ...fixtures.eventClaim, verifiedStatus: 'DISPUTED' }).success,
    ).toBe(false);
    expect(
      EventClaimSchema.parse({
        ...fixtures.eventClaim,
        verifiedStatus: 'DISPUTED',
        contradictionIds: ['news:conflict'],
      }).contradictionIds,
    ).toEqual(['news:conflict']);
  });

  it('rejects missing or estimated availability labelled eligible, while preserving descriptive news', () => {
    for (const availability of [
      { availableAt: null, availabilityBasis: 'UNKNOWN' },
      { availableAt: fixtures.newsDocument.availableAt, availabilityBasis: 'ESTIMATED' },
    ]) {
      expect(
        NewsDocumentSchema.safeParse({ ...fixtures.newsDocument, ...availability }).success,
      ).toBe(false);
      expect(
        NewsDocumentSchema.parse({
          ...fixtures.newsDocument,
          ...availability,
          researchUse: 'DESCRIPTIVE_ONLY',
        }).researchUse,
      ).toBe('DESCRIPTIVE_ONLY');
    }
    expect(
      NewsDocumentSchema.safeParse({
        ...fixtures.newsDocument,
        availableAt: fixtures.newsDocument.publishedAt,
      }).success,
    ).toBe(false);
    expect(
      NewsDocumentSchema.safeParse({
        ...fixtures.newsDocument,
        licensing: { ...fixtures.newsDocument.licensing, permitsSnippet: false },
      }).success,
    ).toBe(false);
    expect(
      MarketBarSchema.safeParse({
        ...fixtures.marketBar,
        provenance: { ...fixtures.marketBar.provenance, capturedAt: '2026-01-01T00:02:00Z' },
      }).success,
    ).toBe(false);
  });

  it('requires chronological envelopes, claim revisions and causal candidates', () => {
    expect(
      EventEnvelopeSchema.safeParse({
        ...fixtures.eventEnvelope,
        ingestedAt: '2025-12-31T00:00:00Z',
      }).success,
    ).toBe(false);
    expect(
      EventClaimSchema.safeParse({ ...fixtures.eventClaim, lastUpdatedAt: '2026-01-01T00:00:00Z' })
        .success,
    ).toBe(false);
    expect(
      SignalCandidateSchema.safeParse({
        ...fixtures.signalCandidate,
        dataCutoff: '2026-01-01T00:01:06.000000001Z',
      }).success,
    ).toBe(false);
    expect(
      SignalCandidateSchema.safeParse({
        ...fixtures.signalCandidate,
        validUntil: fixtures.signalCandidate.decisionAt,
      }).success,
    ).toBe(false);
  });

  it('requires denied sizing to be zero and freezes the risk audit including reasons', () => {
    expect(RiskDecisionSchema.safeParse({ ...fixtures.riskDecision, allowed: false }).success).toBe(
      false,
    );
    const denied = RiskDecisionSchema.parse({
      ...fixtures.riskDecision,
      allowed: false,
      sizing: { ...fixtures.riskDecision.sizing, quantity: '0', maxNotional: '0' },
    });
    expect(denied.allowed).toBe(false);
    expect(Object.isFrozen(denied.audit)).toBe(true);
    expect(Object.isFrozen(denied.audit.reasons)).toBe(true);
  });

  it('validates legal state transitions and forbids terminal-to-open transitions', () => {
    const order = fixtures.simulatedOrder;
    expect(
      SimulatedOrderSchema.safeParse({
        ...order,
        transitions: [{ from: 'CREATED', to: 'FILLED', at: order.updatedAt }],
      }).success,
    ).toBe(false);
    expect(
      SimulatedOrderSchema.safeParse({
        ...order,
        transitions: [
          ...order.transitions,
          { from: 'FILLED', to: 'ACCEPTED', at: order.updatedAt },
        ],
        status: 'ACCEPTED',
      }).success,
    ).toBe(false);
    expect(SimulatedOrderSchema.safeParse({ ...order, submittedAt: null }).success).toBe(false);
    expect(SimulatedOrderSchema.safeParse({ ...order, execution: 'LIVE' }).success).toBe(false);
    expect(SimulatedOrderSchema.safeParse({ ...order, orderType: 'MARKET' }).success).toBe(false);
  });

  it('checks causal fills, exact costs, portfolio identity, remaining quantity and limit bounds', () => {
    const fill = fixtures.simulatedFill,
      order = fixtures.simulatedOrder;
    expect(validateFillAgainstOrder(fill, order)).toEqual(fill);
    expect(
      SimulatedFillSchema.safeParse({ ...fill, filledAt: '2026-01-01T00:01:07Z' }).success,
    ).toBe(false);
    expect(
      SimulatedFillSchema.safeParse({ ...fill, notional: '10.000000000000000001' }).success,
    ).toBe(false);
    expect(() => validateFillAgainstOrder({ ...fill, portfolio: 'FUSION' }, order)).toThrow(
      'identity',
    );
    expect(() => validateFillAgainstOrder(fill, order, '0.01')).toThrow('quantity');
    expect(() =>
      validateFillAgainstOrder({ ...fill, price: '101', notional: '10.1' }, order),
    ).toThrow('limit');
    expect(() => validateFillAgainstOrder({ ...fill, filledAt: order.expiresAt }, order)).toThrow(
      'timing',
    );
    expect(() =>
      validateFillAgainstOrder(
        { ...fill, quantity: '0.05', notional: '5' },
        { ...order, fillConstraints: { ...order.fillConstraints, allowPartial: false } },
      ),
    ).toThrow('partial');
  });

  it('requires append-only correction references and four frozen comparable experiment arms', () => {
    expect(
      LedgerEntrySchema.safeParse({ ...fixtures.ledgerEntry, kind: 'CORRECTION' }).success,
    ).toBe(false);
    const manifest = fixtures.experimentManifest;
    expect(
      ExperimentManifestSchema.safeParse({
        ...manifest,
        portfolios: ['BASELINE', 'BASELINE', 'NEWS_ONLY', 'FUSION'],
      }).success,
    ).toBe(false);
    expect(
      ExperimentManifestSchema.safeParse({ ...manifest, frozenAt: manifest.dateRange.endAt })
        .success,
    ).toBe(false);
    expect(
      ExperimentManifestSchema.safeParse({
        ...manifest,
        exposureLimits: { ...manifest.exposureLimits, leverage: '2' },
      }).success,
    ).toBe(false);
    expect(
      ExperimentManifestSchema.safeParse({ ...manifest, models: Array(4).fill(manifest.models[0]) })
        .success,
    ).toBe(false);
  });
});

describe('randomized external input rejection', () => {
  it('returns validation issues for malformed monetary fields in nested records', () => {
    fc.assert(
      fc.property(fc.string(), (value) => {
        for (const parsed of [
          SimulatedFillSchema.safeParse({ ...fixtures.simulatedFill, price: value }),
          RiskDecisionSchema.safeParse({
            ...fixtures.riskDecision,
            sizing: { ...fixtures.riskDecision.sizing, quantity: value },
          }),
          ExperimentManifestSchema.safeParse({
            ...fixtures.experimentManifest,
            exposureLimits: {
              ...fixtures.experimentManifest.exposureLimits,
              maxSymbolFraction: value,
            },
          }),
        ])
          expect(typeof parsed.success).toBe('boolean');
      }),
      { seed: 20261030, numRuns: 200 },
    );
  });

  it('rejects malformed calendar/timezone/precision variants of 300 valid generated timestamps', () => {
    const parts = fc.record({
      year: fc.integer({ min: 1970, max: 9999 }),
      month: fc.integer({ min: 1, max: 12 }),
      day: fc.integer({ min: 1, max: 28 }),
      hour: fc.integer({ min: 0, max: 23 }),
      minute: fc.integer({ min: 0, max: 59 }),
      second: fc.integer({ min: 0, max: 59 }),
    });
    fc.assert(
      fc.property(parts, ({ year, month, day, hour, minute, second }) => {
        const pad = (value: number) => String(value).padStart(2, '0');
        const valid = `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}Z`;
        expect(UtcTimestampSchema.safeParse(valid).success).toBe(true);
        const bad = [
          valid.slice(0, -1),
          valid.replace('Z', '+00:00'),
          valid.replace('T', ' '),
          valid.replace(/-\d{2}-/, '-13-'),
          valid.replace(/:\d{2}Z$/, ':60Z'),
          valid.replace('Z', '.1234567890Z'),
          `${year}-02-30T00:00:00Z`,
        ];
        for (const value of bad) expect(UtcTimestampSchema.safeParse(value).success).toBe(false);
      }),
      { seed: 20261030, numRuns: 300 },
    );
  });

  it('never coerces arbitrary non-string amounts into financial values', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.double(), fc.boolean(), fc.constant(null), fc.array(fc.integer())),
        (value) => {
          expect(PositiveDecimalSchema.safeParse(value).success).toBe(false);
          expect(MarketBarSchema.safeParse({ ...fixtures.marketBar, open: value }).success).toBe(
            false,
          );
        },
      ),
      { seed: 20261030, numRuns: 200 },
    );
  });
});
