import { Decimal } from 'decimal.js';
import {
  RiskConfigSchema,
  RiskRequestSchema,
  RiskResultSchema,
  utcNanoseconds,
} from '@crypto/contracts';
import type { RiskConfig, RiskResult } from '@crypto/contracts';
import { canonicalHash, deepFreeze, deterministicId, fromEpoch } from '@crypto/core';
export * from './decision-audit.js';

const D = Decimal.clone({ precision: 256, rounding: Decimal.ROUND_FLOOR });
const amount = (v: Decimal.Value) => new D(v).toFixed();
export function defaultRiskConfig(): RiskConfig {
  return RiskConfigSchema.parse({
    schemaVersion: 'risk-config.v1',
    frozenAt: '2026-01-01T00:00:00Z',
    killSwitch: true,
    leverage: '1',
    allowShort: false,
    riskFraction: '0.0025',
    dailyLossFraction: '0.02',
    maxGrossFraction: '0.5',
    maxNetFraction: '0.5',
    maxSymbolFraction: '0.1',
    maxCorrelatedFraction: '0.2',
    maxSpreadBps: '20',
    minLiquidityNotional: '10000',
    liquidityParticipation: '0.01',
    gapAllowanceFraction: '0.01',
    feeRate: '0.001',
    maxFeedAgeSeconds: 30,
    maxAccountAgeSeconds: 30,
    cooldownSeconds: 60,
    maxValiditySeconds: 300,
    correlationGroups: [
      { symbol: 'BTC/USDT', group: 'crypto-major' },
      { symbol: 'ETH/USDT', group: 'crypto-major' },
    ],
  });
}
export function evaluateRisk(
  configInput: unknown,
  requestInput: unknown,
  codeVersion: string,
): RiskResult {
  const config = RiskConfigSchema.parse(configInput),
    request = RiskRequestSchema.parse(requestInput),
    c = request.candidate,
    a = request.account,
    m = request.market,
    now = request.at,
    reasons: string[] = [],
    add = (condition: boolean, reason: string) => {
      if (condition) reasons.push(reason);
    },
    age = (at: typeof now) => Number(utcNanoseconds(now) - utcNanoseconds(at)) / 1e9;
  if (!codeVersion || codeVersion.length > 200) throw new Error('Risk software version required');
  if (
    new Set(config.correlationGroups.map((g) => g.symbol)).size !== config.correlationGroups.length
  )
    throw new Error('Duplicate correlation membership');
  if (new Set(a.positions.map((p) => p.symbol)).size !== a.positions.length)
    throw new Error('Duplicate risk position');
  const validClear = request.overrides.some((o) => o.at <= now && o.at >= config.frozenAt);
  add(config.frozenAt > now, 'CONFIG_NOT_AVAILABLE');
  add(config.killSwitch || !validClear, 'KILL_SWITCH');
  add(
    request.overrides.some((o) => o.at > now),
    'FUTURE_OVERRIDE',
  );
  add(
    c.portfolio !== a.portfolio || c.symbol !== m.symbol || c.symbol.split('/')[1] !== a.currency,
    'IDENTITY_MISMATCH',
  );
  add(c.decisionAt > now || c.dataCutoff > now, 'FUTURE_CANDIDATE');
  add(c.validUntil <= now, 'EXPIRED_CANDIDATE');
  add(c.side === 'HOLD', 'HOLD');
  add(c.side === 'SHORT', 'SPOT_SHORT_DISABLED');
  add(a.equity === null || a.cash === null || a.dayStartEquity === null, 'UNKNOWN_BALANCE');
  add(a.day !== now.slice(0, 10), 'UNKNOWN_DAILY_BASELINE');
  add(age(a.asOf) < 0 || age(a.asOf) > config.maxAccountAgeSeconds, 'STALE_ACCOUNT');
  add(
    m.observedAt > m.availableAt ||
      age(m.availableAt) < 0 ||
      age(m.observedAt) < 0 ||
      age(m.observedAt) > config.maxFeedAgeSeconds ||
      age(m.availableAt) > config.maxFeedAgeSeconds,
    'STALE_MARKET',
  );
  add(new D(m.spreadBps).gt(config.maxSpreadBps), 'SPREAD_LIMIT');
  add(new D(m.liquidityNotional).lt(config.minLiquidityNotional), 'LIQUIDITY_LIMIT');
  add(
    a.lastEntryAt !== null &&
      (age(a.lastEntryAt) < 0 || age(a.lastEntryAt) < config.cooldownSeconds),
    'COOLDOWN',
  );
  const policy = request.positionPolicy,
    entry = new D(m.entryPrice),
    group = config.correlationGroups.find((g) => g.symbol === c.symbol)?.group;
  add(
    !group || a.positions.some((p) => !config.correlationGroups.some((g) => g.symbol === p.symbol)),
    'UNKNOWN_CORRELATION_GROUP',
  );
  add(
    policy === null ||
      (policy !== null &&
        (new D(policy.stopPrice).gte(entry) || new D(policy.targetPrice).lte(entry))),
    'INVALID_POSITION_POLICY',
  );
  if (a.equity !== null && a.dayStartEquity !== null)
    add(
      new D(a.dayStartEquity)
        .minus(a.equity)
        .gte(new D(a.dayStartEquity).mul(config.dailyLossFraction)),
      'DAILY_LOSS_CAP',
    );
  let quantity = new D(0),
    budget = new D(0),
    unitLoss = new D(0);
  if (!reasons.length && policy && a.equity && a.cash) {
    const equity = new D(a.equity),
      gross = a.positions.reduce((s, p) => s.plus(p.notional), new D(0)),
      symbol = a.positions.find((p) => p.symbol === c.symbol)?.notional ?? '0',
      correlated = a.positions
        .filter((p) => config.correlationGroups.find((g) => g.symbol === p.symbol)?.group === group)
        .reduce((s, p) => s.plus(p.notional), new D(0));
    budget = equity.mul(config.riskFraction).mul(request.uncertaintyDiscount);
    unitLoss = entry
      .minus(policy.stopPrice)
      .plus(entry.mul(config.gapAllowanceFraction))
      .plus(entry.mul(config.feeRate).mul(2));
    const caps = [
      budget.div(unitLoss),
      new D(a.cash).div(entry.mul(new D(1).plus(config.feeRate))),
      equity.mul(config.maxGrossFraction).minus(gross).div(entry),
      equity.mul(config.maxNetFraction).minus(gross).div(entry),
      equity.mul(config.maxSymbolFraction).minus(symbol).div(entry),
      equity.mul(config.maxCorrelatedFraction).minus(correlated).div(entry),
      new D(m.liquidityNotional).mul(config.liquidityParticipation).div(entry),
    ];
    quantity = D.max(0, D.min(...caps))
      .div(m.quantityStep)
      .floor()
      .mul(m.quantityStep);
    add(quantity.lt(m.minimumQuantity) || quantity.isZero(), 'SIZING_CAP');
  }
  const allowed = reasons.length === 0;
  if (!allowed) quantity = new D(0);
  const expiry = allowed
    ? [
        c.validUntil,
        fromEpoch(
          utcNanoseconds(now) + BigInt(config.maxValiditySeconds) * 1000000000n,
          'nanoseconds',
        ),
      ].sort()[0]!
    : fromEpoch(utcNanoseconds(now) + 1n, 'nanoseconds');
  const body = {
    schemaVersion: 'risk-decision.v1',
    candidateId: c.id,
    portfolio: c.portfolio,
    decisionAt: now,
    allowed,
    ruleIds: allowed ? ['risk:ALL_LIMITS_PASSED'] : reasons.map((r) => `risk:${r}`),
    sizing: {
      quantity: amount(quantity),
      maxNotional: amount(quantity.mul(entry)),
      currency: a.currency,
    },
    expiresAt: expiry,
    stopTargetPolicy: allowed && policy ? { kind: 'FIXED', ...policy } : { kind: 'NONE' },
    audit: {
      inputHash: canonicalHash(request),
      configHash: canonicalHash(config),
      codeVersion,
      reasons: [
        ...(allowed ? ['ALL_LIMITS_PASSED'] : reasons),
        ...request.overrides.map((o) => `OVERRIDE:${o.id}:${o.actor}:${o.action}`),
      ],
    },
  };
  const result = RiskResultSchema.parse({
    schemaVersion: 'risk-result.v1',
    execution: 'SIMULATED',
    config,
    request,
    decision: { ...body, id: deterministicId('risk-decision', body) },
    stopExecution: 'ADVERSE_GAP_POSSIBLE_NO_GUARANTEE',
    lossBudget: amount(budget),
    modeledLossPerUnit: amount(unitLoss),
    overridesHash: canonicalHash(request.overrides),
  });
  deepFreeze(result);
  return result;
}
