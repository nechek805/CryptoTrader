import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { compareDecimal } from '@crypto/contracts';
import { defaultRiskConfig, evaluateRisk } from '@crypto/risk';
import { canonicalHash, decimal, divideDecimal, multiplyDecimal } from '@crypto/core';
import { riskFixture } from './fixtures/risk.js';

describe('Module 11 Iteration 2 deterministic risk', () => {
  it('sizes from stop distance, fees and adverse gap allowance', () => {
    const f = riskFixture(),
      r = evaluateRisk(f.config, f.request, 'synthetic:risk-test');
    expect(r.decision.allowed).toBe(true);
    expect(r.lossBudget).toBe('25');
    expect(r.modeledLossPerUnit).toBe('6.2');
    expect(r.decision.sizing.quantity).toBe('4.032');
    expect(
      compareDecimal(
        multiplyDecimal(r.decision.sizing.quantity, r.modeledLossPerUnit),
        decimal('25'),
      ),
    ).toBeLessThanOrEqual(0);
    expect(r.stopExecution).toContain('NO_GUARANTEE');
    expect(r.decision.audit.reasons.some((x) => x.startsWith('OVERRIDE:'))).toBe(true);
    expect(Object.isFrozen(r.decision.audit)).toBe(true);
  });
  it('starts globally killed and requires an explicit audited clear', () => {
    const f = riskFixture();
    expect(evaluateRisk(defaultRiskConfig(), f.request, 'test').decision.ruleIds).toContain(
      'risk:KILL_SWITCH',
    );
    f.request.overrides = [];
    expect(evaluateRisk(f.config, f.request, 'test').decision.ruleIds).toContain(
      'risk:KILL_SWITCH',
    );
  });
  it.each(['equity', 'cash', 'dayStartEquity'] as const)('rejects unknown %s', (field) => {
    const f = riskFixture();
    f.request.account[field] = null;
    expect(evaluateRisk(f.config, f.request, 'test').decision.ruleIds).toContain(
      'risk:UNKNOWN_BALANCE',
    );
  });
  it.each(['stale', 'future'] as const)('rejects %s market evidence', (kind) => {
    const f = riskFixture();
    f.request.market.observedAt = (
      kind === 'stale' ? '2026-01-01T00:00:00.000000000Z' : '2026-01-01T00:05:00.000000000Z'
    ) as typeof f.request.at;
    expect(evaluateRisk(f.config, f.request, 'test').decision.ruleIds).toContain(
      'risk:STALE_MARKET',
    );
  });
  it('blocks new exposure at the daily loss boundary', () => {
    const f = riskFixture();
    f.request.account.equity = '9800' as typeof f.request.account.equity;
    expect(evaluateRisk(f.config, f.request, 'test').decision.ruleIds).toContain(
      'risk:DAILY_LOSS_CAP',
    );
  });
  it.each(['HOLD', 'SHORT'] as const)('never opens spot exposure for %s', (side) => {
    const f = riskFixture();
    f.request.candidate.side = side;
    expect(evaluateRisk(f.config, f.request, 'test').decision.allowed).toBe(false);
  });
  it('rejects missing or invalid stops', () => {
    const f = riskFixture();
    f.request.positionPolicy = null;
    expect(evaluateRisk(f.config, f.request, 'test').decision.ruleIds).toContain(
      'risk:INVALID_POSITION_POLICY',
    );
  });
  it('caps symbol and correlated exposure including existing holdings', () => {
    const f = riskFixture();
    f.request.account.positions = [{ symbol: 'BTC/USDT', notional: '1000' as never }];
    expect(evaluateRisk(f.config, f.request, 'test').decision.allowed).toBe(false);
    f.request.account.positions = [{ symbol: 'ETH/USDT', notional: '1990' as never }];
    expect(evaluateRisk(f.config, f.request, 'test').decision.sizing.quantity).toBe('0.1');
  });
  it('enforces cooldown and spread/liquidity gates', () => {
    const f = riskFixture();
    f.request.account.lastEntryAt = f.request.at;
    f.request.market.spreadBps = '25' as never;
    f.request.market.liquidityNotional = '100' as never;
    expect(evaluateRisk(f.config, f.request, 'test').decision.ruleIds).toEqual(
      expect.arrayContaining(['risk:COOLDOWN', 'risk:SPREAD_LIMIT', 'risk:LIQUIDITY_LIMIT']),
    );
  });
  it('uncertainty only reduces size and zero uncertainty budget denies', () => {
    const f = riskFixture(),
      before = evaluateRisk(f.config, f.request, 'test');
    f.request.uncertaintyDiscount = '0.5' as never;
    expect(
      compareDecimal(
        evaluateRisk(f.config, f.request, 'test').decision.sizing.quantity,
        before.decision.sizing.quantity,
      ),
    ).toBeLessThanOrEqual(0);
    f.request.uncertaintyDiscount = '0' as never;
    expect(evaluateRisk(f.config, f.request, 'test').decision.allowed).toBe(false);
  });
  it('tighter ceilings never increase allowed size (property check)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1000 }), (n) => {
        const f = riskFixture(),
          before = evaluateRisk(f.config, f.request, 'test');
        const factor = divideDecimal(decimal(String(n)), decimal('1000'), 3, 'DOWN');
        for (const key of [
          'riskFraction',
          'maxGrossFraction',
          'maxNetFraction',
          'maxSymbolFraction',
          'maxCorrelatedFraction',
          'liquidityParticipation',
        ] as const)
          f.config[key] = multiplyDecimal(f.config[key], factor);
        const after = evaluateRisk(f.config, f.request, 'test');
        expect(
          compareDecimal(after.decision.sizing.quantity, before.decision.sizing.quantity),
        ).toBeLessThanOrEqual(0);
      }),
      { numRuns: 50 },
    );
  });
  it('denied expired candidates remain denied without creating a renewed authorization', () => {
    const f = riskFixture();
    f.request.at = f.request.candidate.validUntil;
    const r = evaluateRisk(f.config, f.request, 'test');
    expect(r.decision.allowed).toBe(false);
    expect(r.decision.sizing.quantity).toBe('0');
    expect(r.decision.ruleIds).toContain('risk:EXPIRED_CANDIDATE');
  });
  it('replays deterministically without mutating input', () => {
    const f = riskFixture(),
      hash = canonicalHash(f);
    expect(evaluateRisk(f.config, f.request, 'test')).toEqual(
      evaluateRisk(f.config, f.request, 'test'),
    );
    expect(canonicalHash(f)).toBe(hash);
  });
});
