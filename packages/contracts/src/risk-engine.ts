import { z } from 'zod';
import { SignalCandidateSchema, RiskDecisionSchema } from './domain.js';
import {
  CurrencySchema,
  HashSchema,
  IdSchema,
  NonNegativeDecimalSchema,
  PortfolioSchema,
  PositiveDecimalSchema,
  SymbolSchema,
  UnitDecimalSchema,
  UtcTimestampSchema,
} from './primitives.js';

export const RiskConfigSchema = z.strictObject({
  schemaVersion: z.literal('risk-config.v1'),
  frozenAt: UtcTimestampSchema,
  killSwitch: z.boolean(),
  leverage: z.literal('1'),
  allowShort: z.literal(false),
  riskFraction: UnitDecimalSchema,
  dailyLossFraction: UnitDecimalSchema,
  maxGrossFraction: UnitDecimalSchema,
  maxNetFraction: UnitDecimalSchema,
  maxSymbolFraction: UnitDecimalSchema,
  maxCorrelatedFraction: UnitDecimalSchema,
  maxSpreadBps: NonNegativeDecimalSchema,
  minLiquidityNotional: NonNegativeDecimalSchema,
  liquidityParticipation: UnitDecimalSchema,
  gapAllowanceFraction: UnitDecimalSchema,
  feeRate: UnitDecimalSchema,
  maxFeedAgeSeconds: z.number().int().min(1).max(3600),
  maxAccountAgeSeconds: z.number().int().min(1).max(3600),
  cooldownSeconds: z.number().int().min(0).max(86400),
  maxValiditySeconds: z.number().int().min(1).max(86400),
  correlationGroups: z
    .array(z.strictObject({ symbol: SymbolSchema, group: IdSchema }))
    .min(1)
    .max(100),
});
export type RiskConfig = z.infer<typeof RiskConfigSchema>;
export const RiskOverrideSchema = z.strictObject({
  id: IdSchema,
  actor: IdSchema,
  reason: z.string().min(1).max(500),
  at: UtcTimestampSchema,
  action: z.literal('CLEAR_KILL_SWITCH'),
});
export const RiskAccountSchema = z.strictObject({
  portfolio: PortfolioSchema,
  asOf: UtcTimestampSchema,
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  equity: PositiveDecimalSchema.nullable(),
  cash: NonNegativeDecimalSchema.nullable(),
  dayStartEquity: PositiveDecimalSchema.nullable(),
  currency: CurrencySchema,
  positions: z
    .array(z.strictObject({ symbol: SymbolSchema, notional: NonNegativeDecimalSchema }))
    .max(100),
  lastEntryAt: UtcTimestampSchema.nullable(),
});
export const RiskRequestSchema = z.strictObject({
  schemaVersion: z.literal('risk-request.v1'),
  candidate: SignalCandidateSchema,
  at: UtcTimestampSchema,
  account: RiskAccountSchema,
  market: z.strictObject({
    symbol: SymbolSchema,
    availableAt: UtcTimestampSchema,
    observedAt: UtcTimestampSchema,
    entryPrice: PositiveDecimalSchema,
    spreadBps: NonNegativeDecimalSchema,
    liquidityNotional: NonNegativeDecimalSchema,
    quantityStep: PositiveDecimalSchema,
    minimumQuantity: PositiveDecimalSchema,
    evidenceIds: z.array(IdSchema).min(1).max(100),
    eligibility: z.literal('ELIGIBLE'),
  }),
  positionPolicy: z
    .strictObject({ stopPrice: PositiveDecimalSchema, targetPrice: PositiveDecimalSchema })
    .nullable(),
  overrides: z.array(RiskOverrideSchema).max(10),
  // Can only reduce risk. Uncalibrated probabilities are never sizing multipliers.
  uncertaintyDiscount: UnitDecimalSchema,
});
export type RiskRequest = z.infer<typeof RiskRequestSchema>;
export const RiskResultSchema = z.strictObject({
  schemaVersion: z.literal('risk-result.v1'),
  execution: z.literal('SIMULATED'),
  request: RiskRequestSchema,
  config: RiskConfigSchema,
  decision: RiskDecisionSchema,
  stopExecution: z.literal('ADVERSE_GAP_POSSIBLE_NO_GUARANTEE'),
  lossBudget: NonNegativeDecimalSchema,
  modeledLossPerUnit: NonNegativeDecimalSchema,
  overridesHash: HashSchema,
});
export type RiskResult = z.infer<typeof RiskResultSchema>;
