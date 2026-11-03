import { z } from 'zod';
import { Decimal } from 'decimal.js';
import {
  AvailabilityShape,
  CurrencySchema,
  DecimalStringSchema,
  HashSchema,
  IdSchema,
  NonNegativeDecimalSchema,
  PortfolioSchema,
  PositiveDecimalSchema,
  ProvenanceSchema,
  QualityFlagsSchema,
  ReproducibilitySchema,
  SeedSchema,
  SymbolSchema,
  TemporalRecordSchema,
  UnitDecimalSchema,
  UtcTimestampSchema,
  compareDecimal,
  decimalProductEquals,
  uncertainValueSchema,
  validateTemporal,
  utcNanoseconds,
} from './primitives.js';

function ordered(before: string, after: string, ctx: z.RefinementCtx, path: string): void {
  if (before > after)
    ctx.addIssue({ code: 'custom', message: 'Timestamp precedes its prerequisite', path: [path] });
}

// Object refinements may run after a child format issue. Never do arithmetic on
// invalid values: safeParse must return issues rather than throw from Decimal.
function validDecimals(...values: unknown[]): boolean {
  return values.every((value) => DecimalStringSchema.safeParse(value).success);
}

export function eventEnvelopeSchema<T extends z.ZodType>(payload: T) {
  return z
    .strictObject({
      schemaVersion: z.literal('event-envelope.v1'),
      id: IdSchema,
      kind: IdSchema,
      provider: IdSchema,
      occurredAt: UtcTimestampSchema.nullable(),
      observedAt: UtcTimestampSchema,
      ...AvailabilityShape,
      ingestedAt: UtcTimestampSchema,
      processedAt: UtcTimestampSchema.optional(),
      payload,
      rawHash: HashSchema,
      correlationId: IdSchema.optional(),
      qualityFlags: QualityFlagsSchema,
      provenance: ProvenanceSchema,
    })
    .superRefine((event, ctx) => {
      validateTemporal(event, ctx);
      if (event.availableAt !== null)
        ordered(event.observedAt, event.availableAt, ctx, 'availableAt');
      ordered(event.observedAt, event.ingestedAt, ctx, 'ingestedAt');
      if (event.processedAt) ordered(event.ingestedAt, event.processedAt, ctx, 'processedAt');
      // A normalized temporal payload cannot be made knowable earlier by wrapping it.
      const content: unknown = 'payload' in event ? event.payload : undefined;
      if (
        content &&
        typeof content === 'object' &&
        'availableAt' in content &&
        'availabilityBasis' in content &&
        'researchUse' in content
      ) {
        const temporal = TemporalRecordSchema.safeParse(content);
        if (
          !temporal.success ||
          (event.researchUse === 'ELIGIBLE' &&
            (temporal.data.researchUse !== 'ELIGIBLE' ||
              temporal.data.availableAt === null ||
              event.availableAt === null ||
              temporal.data.availableAt > event.availableAt))
        ) {
          ctx.addIssue({
            code: 'custom',
            message: 'Envelope cannot promote or predate its temporal payload',
            path: ['payload'],
          });
        }
      }
    });
}
export const EventEnvelopeSchema = eventEnvelopeSchema(z.json());
export type EventEnvelope<T = z.infer<ReturnType<typeof z.json>>> = Omit<
  z.infer<typeof EventEnvelopeSchema>,
  'payload'
> & { payload: T };

export const MarketBarSchema = z
  .strictObject({
    schemaVersion: z.literal('market-bar.v1'),
    id: IdSchema,
    exchange: IdSchema,
    instrumentId: SymbolSchema,
    marketType: z.enum(['SPOT', 'PERPETUAL']),
    interval: z.strictObject({
      value: z.number().int().positive(),
      unit: z.enum(['seconds', 'minutes', 'hours', 'days']),
    }),
    openAt: UtcTimestampSchema,
    closeAt: UtcTimestampSchema,
    open: PositiveDecimalSchema,
    high: PositiveDecimalSchema,
    low: PositiveDecimalSchema,
    close: PositiveDecimalSchema,
    volume: NonNegativeDecimalSchema,
    ...AvailabilityShape,
    sourceVersion: z.string().min(1),
    qualityFlags: QualityFlagsSchema,
    provenance: ProvenanceSchema,
  })
  .superRefine((bar, ctx) => {
    validateTemporal(bar, ctx);
    if (bar.openAt >= bar.closeAt)
      ctx.addIssue({
        code: 'custom',
        message: 'Bar must have positive duration',
        path: ['closeAt'],
      });
    if (bar.availableAt !== null) ordered(bar.closeAt, bar.availableAt, ctx, 'availableAt');
    const durations = { seconds: 1n, minutes: 60n, hours: 3600n, days: 86400n };
    if (
      UtcTimestampSchema.safeParse(bar.openAt).success &&
      UtcTimestampSchema.safeParse(bar.closeAt).success &&
      Number.isSafeInteger(bar.interval.value) &&
      utcNanoseconds(bar.closeAt) - utcNanoseconds(bar.openAt) !==
        BigInt(bar.interval.value) * durations[bar.interval.unit] * 1_000_000_000n
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Exclusive bar duration does not match interval',
        path: ['interval'],
      });
    }
    if (
      validDecimals(bar.low, bar.high, bar.open, bar.close) &&
      (compareDecimal(bar.low, bar.high) > 0 ||
        compareDecimal(bar.low, bar.open) > 0 ||
        compareDecimal(bar.low, bar.close) > 0 ||
        compareDecimal(bar.high, bar.open) < 0 ||
        compareDecimal(bar.high, bar.close) < 0)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'OHLC prices violate low/high bounds',
        path: ['high'],
      });
    }
  });
export type MarketBar = z.infer<typeof MarketBarSchema>;

const SourceChainLinkSchema = z.strictObject({
  sourceId: IdSchema,
  documentId: IdSchema,
  relationship: z.enum(['ORIGINAL', 'CITES', 'SYNDICATED', 'REWRITE', 'UNKNOWN']),
});
export const LicensingSchema = z.strictObject({
  policy: z.enum(['OFFICIAL_PUBLIC', 'LICENSED', 'METADATA_ONLY', 'SYNTHETIC']),
  reference: z.string().min(1),
  permitsSnippet: z.boolean(),
});
export const NewsDocumentSchema = z
  .strictObject({
    schemaVersion: z.literal('news-document.v1'),
    id: IdSchema,
    sourceId: IdSchema,
    canonicalUrl: z.url({ protocol: /^https?$/ }),
    sourceChain: z.array(SourceChainLinkSchema).min(1),
    language: z.string().regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/),
    publishedAt: UtcTimestampSchema.optional(),
    firstObservedAt: UtcTimestampSchema,
    ...AvailabilityShape,
    licensing: LicensingSchema,
    contentHash: HashSchema,
    title: z.string().min(1).max(500),
    approvedSnippet: z.string().max(1000).optional(),
    qualityFlags: QualityFlagsSchema,
    provenance: ProvenanceSchema,
  })
  .superRefine((document, ctx) => {
    validateTemporal(document, ctx);
    if (document.availableAt !== null)
      ordered(document.firstObservedAt, document.availableAt, ctx, 'availableAt');
    if (document.approvedSnippet !== undefined && !document.licensing.permitsSnippet) {
      ctx.addIssue({
        code: 'custom',
        message: 'License does not permit a snippet',
        path: ['approvedSnippet'],
      });
    }
  });
export type NewsDocument = z.infer<typeof NewsDocumentSchema>;

export const EventClaimSchema = z
  .strictObject({
    schemaVersion: z.literal('event-claim.v1'),
    id: IdSchema,
    eventId: IdSchema,
    predicate: z.string().min(1),
    subject: z.string().min(1),
    object: uncertainValueSchema(z.string().min(1)),
    confidence: uncertainValueSchema(z.number().min(0).max(1)),
    evidenceIds: z.array(IdSchema).min(1),
    contradictionIds: z.array(IdSchema),
    verifiedStatus: z.enum(['UNVERIFIED', 'CORROBORATED', 'DISPUTED', 'RETRACTED']),
    firstKnownAt: UtcTimestampSchema,
    lastUpdatedAt: UtcTimestampSchema,
    ...AvailabilityShape,
    qualityFlags: QualityFlagsSchema,
    provenance: ProvenanceSchema,
  })
  .superRefine((claim, ctx) => {
    validateTemporal(claim, ctx);
    ordered(claim.firstKnownAt, claim.lastUpdatedAt, ctx, 'lastUpdatedAt');
    if (claim.availableAt !== null)
      ordered(claim.lastUpdatedAt, claim.availableAt, ctx, 'availableAt');
    if (claim.verifiedStatus === 'DISPUTED' && claim.contradictionIds.length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'Disputed claims must retain contradictions',
        path: ['contradictionIds'],
      });
    }
  });
export type EventClaim = z.infer<typeof EventClaimSchema>;

export const SignalCandidateSchema = z
  .strictObject({
    schemaVersion: z.literal('signal-candidate.v1'),
    id: IdSchema,
    strategyId: IdSchema,
    version: z.string().min(1),
    portfolio: PortfolioSchema,
    symbol: SymbolSchema,
    decisionAt: UtcTimestampSchema,
    dataCutoff: UtcTimestampSchema,
    horizon: z.strictObject({
      value: z.number().int().positive(),
      unit: z.enum(['seconds', 'minutes', 'hours', 'days']),
    }),
    side: z.enum(['LONG', 'SHORT', 'HOLD']),
    score: uncertainValueSchema(z.number().min(-1).max(1)),
    calibration: uncertainValueSchema(
      z.strictObject({ modelVersion: z.string().min(1), probability: z.number().min(0).max(1) }),
    ),
    rationaleIds: z.array(IdSchema).min(1),
    validUntil: UtcTimestampSchema,
    reproducibility: ReproducibilitySchema,
  })
  .superRefine((signal, ctx) => {
    ordered(signal.dataCutoff, signal.decisionAt, ctx, 'dataCutoff');
    if (signal.validUntil <= signal.decisionAt)
      ctx.addIssue({
        code: 'custom',
        message: 'Signal must expire after decision',
        path: ['validUntil'],
      });
    ordered(signal.decisionAt, signal.reproducibility.generatedAt, ctx, 'reproducibility');
  });
export type SignalCandidate = z.infer<typeof SignalCandidateSchema>;

export const RiskDecisionSchema = z
  .strictObject({
    schemaVersion: z.literal('risk-decision.v1'),
    id: IdSchema,
    candidateId: IdSchema,
    portfolio: PortfolioSchema,
    decisionAt: UtcTimestampSchema,
    allowed: z.boolean(),
    ruleIds: z.array(IdSchema).min(1),
    sizing: z.strictObject({
      quantity: NonNegativeDecimalSchema,
      maxNotional: NonNegativeDecimalSchema,
      currency: CurrencySchema,
    }),
    expiresAt: UtcTimestampSchema,
    stopTargetPolicy: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('NONE') }),
      z.strictObject({
        kind: z.literal('FIXED'),
        stopPrice: PositiveDecimalSchema,
        targetPrice: PositiveDecimalSchema,
      }),
    ]),
    audit: z
      .strictObject({
        inputHash: HashSchema,
        configHash: HashSchema,
        codeVersion: z.string().min(1),
        reasons: z.array(z.string().min(1)).min(1).readonly(),
      })
      .readonly(),
  })
  .superRefine((risk, ctx) => {
    if (risk.expiresAt <= risk.decisionAt)
      ctx.addIssue({
        code: 'custom',
        message: 'Risk authorization must expire after decision',
        path: ['expiresAt'],
      });
    if (!validDecimals(risk.sizing.quantity, risk.sizing.maxNotional)) return;
    const hasQuantity = compareDecimal(risk.sizing.quantity, DecimalStringSchema.parse('0')) > 0;
    const hasNotional = compareDecimal(risk.sizing.maxNotional, DecimalStringSchema.parse('0')) > 0;
    if (risk.allowed ? !hasQuantity || !hasNotional : hasQuantity || hasNotional) {
      ctx.addIssue({
        code: 'custom',
        message: 'Denied sizing must be zero; allowed sizing must be positive',
        path: ['sizing'],
      });
    }
  });
export type RiskDecision = z.infer<typeof RiskDecisionSchema>;

export const OrderStatusSchema = z.enum([
  'CREATED',
  'ACCEPTED',
  'PARTIALLY_FILLED',
  'FILLED',
  'CANCELED',
  'REJECTED',
  'EXPIRED',
]);
const transitions: Record<z.infer<typeof OrderStatusSchema>, readonly string[]> = {
  CREATED: ['ACCEPTED', 'REJECTED', 'CANCELED', 'EXPIRED'],
  ACCEPTED: ['PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'EXPIRED'],
  PARTIALLY_FILLED: ['PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'EXPIRED'],
  FILLED: [],
  CANCELED: [],
  REJECTED: [],
  EXPIRED: [],
};
export const SimulatedOrderSchema = z
  .strictObject({
    schemaVersion: z.literal('simulated-order.v1'),
    execution: z.literal('SIMULATED'),
    id: IdSchema,
    clientOrderId: IdSchema,
    candidateId: IdSchema,
    riskDecisionId: IdSchema,
    portfolio: PortfolioSchema,
    symbol: SymbolSchema,
    side: z.enum(['BUY', 'SELL']),
    orderType: z.enum(['MARKET', 'LIMIT']),
    quantity: PositiveDecimalSchema,
    limitPrice: PositiveDecimalSchema.nullable(),
    status: OrderStatusSchema,
    createdAt: UtcTimestampSchema,
    submittedAt: UtcTimestampSchema.nullable(),
    updatedAt: UtcTimestampSchema,
    expiresAt: UtcTimestampSchema,
    fillConstraints: z.strictObject({
      priceDataAvailableAt: UtcTimestampSchema,
      earliestFillAt: UtcTimestampSchema,
      allowPartial: z.boolean(),
      maxSlippageBps: NonNegativeDecimalSchema,
      modelVersion: z.string().min(1),
      limitFillPolicy: z.literal('CONSERVATIVE_NO_GUARANTEE'),
    }),
    transitions: z
      .array(
        z.strictObject({ from: OrderStatusSchema, to: OrderStatusSchema, at: UtcTimestampSchema }),
      )
      .readonly(),
  })
  .superRefine((order, ctx) => {
    ordered(order.createdAt, order.updatedAt, ctx, 'updatedAt');
    if (order.expiresAt <= order.createdAt)
      ctx.addIssue({
        code: 'custom',
        message: 'Order must have positive lifetime',
        path: ['expiresAt'],
      });
    if ((order.orderType === 'LIMIT') !== (order.limitPrice !== null))
      ctx.addIssue({
        code: 'custom',
        message: 'Only LIMIT orders require a limit price',
        path: ['limitPrice'],
      });
    if (order.submittedAt !== null) {
      ordered(order.createdAt, order.submittedAt, ctx, 'submittedAt');
      ordered(order.submittedAt, order.fillConstraints.earliestFillAt, ctx, 'fillConstraints');
      ordered(order.submittedAt, order.updatedAt, ctx, 'updatedAt');
    } else if (['ACCEPTED', 'PARTIALLY_FILLED', 'FILLED'].includes(order.status)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Accepted/filled order requires submission time',
        path: ['submittedAt'],
      });
    }
    ordered(
      order.fillConstraints.priceDataAvailableAt,
      order.fillConstraints.earliestFillAt,
      ctx,
      'fillConstraints',
    );
    ordered(order.createdAt, order.fillConstraints.earliestFillAt, ctx, 'fillConstraints');
    let current: z.infer<typeof OrderStatusSchema> = 'CREATED';
    let previousAt = order.createdAt;
    for (const transition of order.transitions) {
      if (transition.from !== current || !transitions[current].includes(transition.to))
        ctx.addIssue({
          code: 'custom',
          message: 'Illegal order state transition',
          path: ['transitions'],
        });
      ordered(previousAt, transition.at, ctx, 'transitions');
      ordered(transition.at, order.updatedAt, ctx, 'updatedAt');
      if (
        order.submittedAt !== null &&
        ['ACCEPTED', 'PARTIALLY_FILLED', 'FILLED'].includes(transition.to)
      ) {
        ordered(order.submittedAt, transition.at, ctx, 'transitions');
      }
      if (['PARTIALLY_FILLED', 'FILLED'].includes(transition.to)) {
        ordered(order.fillConstraints.earliestFillAt, transition.at, ctx, 'transitions');
      }
      current = transition.to;
      previousAt = transition.at;
    }
    if (current !== order.status)
      ctx.addIssue({
        code: 'custom',
        message: 'Status does not match transition history',
        path: ['status'],
      });
  });
export type SimulatedOrder = z.infer<typeof SimulatedOrderSchema>;

export const SimulatedFillSchema = z
  .strictObject({
    schemaVersion: z.literal('simulated-fill.v1'),
    execution: z.literal('SIMULATED'),
    id: IdSchema,
    orderId: IdSchema,
    clientOrderId: IdSchema,
    portfolio: PortfolioSchema,
    symbol: SymbolSchema,
    side: z.enum(['BUY', 'SELL']),
    quantity: PositiveDecimalSchema,
    price: PositiveDecimalSchema,
    notional: PositiveDecimalSchema,
    fee: NonNegativeDecimalSchema,
    feeCurrency: CurrencySchema,
    liquidity: z.enum(['MAKER', 'TAKER']),
    priceAvailableAt: UtcTimestampSchema,
    orderSubmittedAt: UtcTimestampSchema,
    earliestFillAt: UtcTimestampSchema,
    filledAt: UtcTimestampSchema,
    modelVersion: z.string().min(1),
    evidenceIds: z.array(IdSchema).min(1),
  })
  .superRefine((fill, ctx) => {
    ordered(fill.priceAvailableAt, fill.earliestFillAt, ctx, 'earliestFillAt');
    ordered(fill.orderSubmittedAt, fill.earliestFillAt, ctx, 'earliestFillAt');
    ordered(fill.earliestFillAt, fill.filledAt, ctx, 'filledAt');
    if (
      validDecimals(fill.quantity, fill.price, fill.notional) &&
      !decimalProductEquals(fill.quantity, fill.price, fill.notional)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Notional must equal exact quantity times price',
        path: ['notional'],
      });
    }
  });
export type SimulatedFill = z.infer<typeof SimulatedFillSchema>;

/** Static contract validation only; execution realism and ledger idempotency come later. */
export function validateFillAgainstOrder(
  fillInput: unknown,
  orderInput: unknown,
  alreadyFilled = '0',
): SimulatedFill {
  const fill = SimulatedFillSchema.parse(fillInput);
  const order = SimulatedOrderSchema.parse(orderInput);
  const prior = NonNegativeDecimalSchema.parse(alreadyFilled);
  const Arithmetic = Decimal.clone({ precision: 256 });
  const total = new Arithmetic(prior).plus(fill.quantity);
  if (
    fill.orderId !== order.id ||
    fill.clientOrderId !== order.clientOrderId ||
    fill.portfolio !== order.portfolio ||
    fill.symbol !== order.symbol ||
    fill.side !== order.side ||
    fill.modelVersion !== order.fillConstraints.modelVersion
  )
    throw new Error('Fill/order identity mismatch');
  if (
    order.submittedAt === null ||
    fill.orderSubmittedAt !== order.submittedAt ||
    fill.earliestFillAt < order.fillConstraints.earliestFillAt ||
    fill.filledAt >= order.expiresAt ||
    fill.priceAvailableAt < order.fillConstraints.priceDataAvailableAt
  )
    throw new Error('Fill violates order timing constraints');
  if (
    total.gt(order.quantity) ||
    (!order.fillConstraints.allowPartial && !total.eq(order.quantity))
  ) {
    throw new Error('Fill violates remaining quantity or partial-fill policy');
  }
  if (
    order.limitPrice !== null &&
    ((order.side === 'BUY' && compareDecimal(fill.price, order.limitPrice) > 0) ||
      (order.side === 'SELL' && compareDecimal(fill.price, order.limitPrice) < 0))
  )
    throw new Error('Fill violates limit price');
  return fill;
}

export const LedgerEntrySchema = z
  .strictObject({
    schemaVersion: z.literal('ledger-entry.v1'),
    execution: z.literal('SIMULATED'),
    id: IdSchema,
    clientEntryId: IdSchema,
    portfolio: PortfolioSchema,
    recordedAt: UtcTimestampSchema,
    effectiveAt: UtcTimestampSchema,
    kind: z.enum(['INITIAL_BALANCE', 'TRADE', 'FEE', 'FUNDING', 'CORRECTION']),
    asset: CurrencySchema,
    amount: DecimalStringSchema,
    balanceAfter: NonNegativeDecimalSchema,
    orderId: IdSchema.nullable(),
    fillId: IdSchema.nullable(),
    correctionOf: IdSchema.nullable(),
    auditHash: HashSchema,
  })
  .superRefine((entry, ctx) => {
    ordered(entry.effectiveAt, entry.recordedAt, ctx, 'recordedAt');
    if (entry.kind === 'CORRECTION' && entry.correctionOf === null)
      ctx.addIssue({
        code: 'custom',
        message: 'Correction must reference preserved original entry',
        path: ['correctionOf'],
      });
    if (['TRADE', 'FEE'].includes(entry.kind) && (entry.orderId === null || entry.fillId === null))
      ctx.addIssue({
        code: 'custom',
        message: 'Trade/fee entry requires order and fill references',
        path: ['fillId'],
      });
  });
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

export const ExperimentManifestSchema = z
  .strictObject({
    schemaVersion: z.literal('experiment-manifest.v1'),
    execution: z.literal('SIMULATED'),
    id: IdSchema,
    inputSnapshotHashes: z.array(HashSchema).min(1),
    configHash: HashSchema,
    codeVersion: z.string().min(1),
    randomSeed: SeedSchema,
    randomAlgorithm: z.literal('mulberry32.v1'),
    generatedAt: UtcTimestampSchema,
    frozenAt: UtcTimestampSchema,
    dateRange: z.strictObject({ startAt: UtcTimestampSchema, endAt: UtcTimestampSchema }),
    symbols: z
      .array(SymbolSchema)
      .min(3)
      .refine((values) => new Set(values).size === values.length, 'Duplicate symbol'),
    calendar: z.literal('CRYPTO_24_7_UTC'),
    quoteCurrency: CurrencySchema,
    startingBalancePerPortfolio: PositiveDecimalSchema,
    portfolios: z
      .array(PortfolioSchema)
      .length(4)
      .refine((values) => new Set(values).size === 4, 'Require four isolated portfolios'),
    fees: z.strictObject({
      makerRate: UnitDecimalSchema,
      takerRate: UnitDecimalSchema,
      spreadBps: NonNegativeDecimalSchema,
      slippageBps: NonNegativeDecimalSchema,
      fundingPolicy: z.enum(['NOT_APPLICABLE_SPOT', 'EXPLICIT_SERIES_REQUIRED']),
    }),
    models: z
      .array(
        z.strictObject({
          portfolio: PortfolioSchema,
          version: z.string().min(1),
          artifactHash: HashSchema,
        }),
      )
      .length(4)
      .refine(
        (models) => new Set(models.map((model) => model.portfolio)).size === 4,
        'Version each portfolio model',
      ),
    exposureLimits: z.strictObject({
      leverage: z.literal('1'),
      allowShort: z.literal(false),
      maxSymbolFraction: UnitDecimalSchema,
      maxPortfolioFraction: UnitDecimalSchema,
      staleAfter: z.strictObject({
        value: z.number().int().positive(),
        unit: z.literal('seconds'),
      }),
    }),
    clockSemantics: z.literal('utc-nanoseconds.v1'),
  })
  .superRefine((manifest, ctx) => {
    ordered(manifest.generatedAt, manifest.frozenAt, ctx, 'frozenAt');
    ordered(manifest.frozenAt, manifest.dateRange.startAt, ctx, 'dateRange');
    if (manifest.dateRange.endAt <= manifest.dateRange.startAt)
      ctx.addIssue({
        code: 'custom',
        message: 'Experiment must have positive duration',
        path: ['dateRange'],
      });
    if (
      validDecimals(
        manifest.exposureLimits.maxSymbolFraction,
        manifest.exposureLimits.maxPortfolioFraction,
      ) &&
      compareDecimal(
        manifest.exposureLimits.maxSymbolFraction,
        manifest.exposureLimits.maxPortfolioFraction,
      ) > 0
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Symbol exposure cannot exceed portfolio exposure',
        path: ['exposureLimits'],
      });
  });
export type ExperimentManifest = z.infer<typeof ExperimentManifestSchema>;
