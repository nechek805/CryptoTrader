import { Decimal } from 'decimal.js';
import {
  SpotSimulationInputSchema,
  SpotSimulationRequestSchema,
  SpotSimulationArtifactSchema,
  SimulatedOrderSchema,
  SimulatedFillSchema,
  validateFillAgainstOrder,
} from '@crypto/contracts';
import type {
  SpotSimulationInput,
  SpotSimulationRequest,
  SpotSimulationArtifact,
  SpotOrder,
  SpotCommand,
  SpotFillTrace,
  SpotTrace,
  SpotPosting,
  MarketBar,
  InstrumentRevision,
  UtcTimestamp,
  SimulatedOrder,
  DecimalString,
} from '@crypto/contracts';
import {
  canonicalHash,
  deepFreeze,
  deterministicId,
  isDecimalMultipleOf,
  isAvailableAt,
  SyntheticClock,
} from '@crypto/core';
import { scheduleReplayEvents, barCloseKey } from './scheduler.js';
import { SpotEvidence } from './spot-evidence.js';
import { SpotLedger, reconcileSpotJournal, journalGenesis } from './spot-ledger.js';
import { D, amount, grid, plusMs } from './spot-math.js';

const active = (o: SpotOrder) =>
  o.order.status === 'ACCEPTED' || o.order.status === 'PARTIALLY_FILLED';
const zero = amount(0),
  negative = (v: string) => amount(new D(v).neg());
type ModeledPrice = {
  price: DecimalString;
  reference: DecimalString;
  flags: string[];
  trigger: SpotFillTrace['trigger'];
};
export class ExecutionSimulator {
  readonly #input: SpotSimulationInput;
  readonly #request: SpotSimulationRequest;
  readonly #code: string;
  #artifact: SpotSimulationArtifact | undefined;
  constructor(input: unknown, request: unknown, codeVersion: string) {
    this.#input = SpotSimulationInputSchema.parse(input);
    this.#request = SpotSimulationRequestSchema.parse(request);
    this.#code = codeVersion;
    deepFreeze(this.#input);
    deepFreeze(this.#request);
  }
  run() {
    if (!this.#artifact) this.#artifact = new SpotRun(this.#input, this.#request, this.#code).run();
    return this.#artifact;
  }
}
class SpotRun {
  readonly ledger = new SpotLedger();
  readonly orders: SpotOrder[] = [];
  readonly fills: SpotFillTrace[] = [];
  readonly trace: SpotTrace[] = [];
  readonly evidence: SpotEvidence;
  readonly clock: SyntheticClock;
  readonly inputHash: string;
  readonly configHash: string;
  readonly runId: string;
  readonly retries = new Map<string, string>();
  readonly lastCloses = new Map<string, UtcTimestamp>();
  constructor(
    readonly input: SpotSimulationInput,
    readonly request: SpotSimulationRequest,
    readonly codeVersion: string,
  ) {
    this.evidence = new SpotEvidence(input, request);
    this.clock = new SyntheticClock(request.startAt);
    this.inputHash = canonicalHash(input);
    this.configHash = canonicalHash(request);
    this.runId = deterministicId('spot-run', {
      inputHash: this.inputHash,
      configHash: this.configHash,
      codeVersion,
    });
  }
  reserveCost(quantity: string, bound: string, m: InstrumentRevision) {
    const rate = D.max(this.request.makerRate, this.request.takerRate),
      unitFee = new D(m.quantityStep)
        .mul(bound)
        .mul(rate)
        .toDecimalPlaces(this.request.quoteScale, Decimal.ROUND_CEIL);
    return amount(
      new D(quantity).mul(bound).plus(new D(quantity).div(m.quantityStep).mul(unitFee)),
    );
  }
  transition(o: SpotOrder, status: SimulatedOrder['status']) {
    const at = this.clock.now();
    o.order = SimulatedOrderSchema.parse({
      ...o.order,
      status,
      updatedAt: at,
      transitions: [...o.order.transitions, { from: o.order.status, to: status, at }],
    });
  }
  checkpoint(
    kind: SpotTrace['kind'],
    recordId: string,
    reason: string,
    orderIds: string[] = [],
    fillIds: string[] = [],
  ) {
    this.assertReservations();
    this.trace.push({
      sequence: this.trace.length + 1,
      at: this.clock.now(),
      kind,
      recordId,
      reason,
      orderIds,
      fillIds,
      balancesHash: canonicalHash(this.ledger.balances()),
      journalHead: this.ledger.entries.at(-1)?.hash ?? journalGenesis,
    });
    if (
      this.trace.length > 10000 ||
      this.ledger.entries.length > 25000 ||
      this.orders.length > 2000 ||
      this.fills.length > 5000
    )
      throw new Error('Spot simulation work budget');
  }
  assertReservations() {
    const sums = new Map<string, InstanceType<typeof D>>();
    for (const o of this.orders) {
      const k = `${o.intent.portfolio}|${o.reservedAsset}`;
      sums.set(k, (sums.get(k) ?? new D(0)).plus(o.reservedAmount));
      if (!active(o) && !new D(o.reservedAmount).isZero())
        throw new Error('Terminal order retains a reservation');
      if (!new D(o.filledQuantity).plus(o.remainingQuantity).eq(o.intent.quantity))
        throw new Error('Order quantity reconciliation');
    }
    for (const b of this.ledger.balances())
      if (!new D(b.reserved).eq(sums.get(`${b.portfolio}|${b.asset}`) ?? 0))
        throw new Error('Order reservation reconciliation');
  }
  release(o: SpotOrder, status: 'CANCELED' | 'EXPIRED', reason: string, kind: SpotTrace['kind']) {
    if (!active(o)) return;
    if (new D(o.reservedAmount).gt(0))
      this.ledger.move(
        this.clock.now(),
        o.intent.portfolio,
        o.reservedAsset,
        o.reservedAmount,
        false,
        o.order.id,
      );
    o.reservedAmount = zero;
    this.transition(o, status);
    this.checkpoint(kind, o.order.id, reason, [o.order.id]);
  }
  advance(at: UtcTimestamp) {
    const expired = this.orders
      .filter((o) => active(o) && o.order.expiresAt <= at)
      .sort((a, b) =>
        a.order.expiresAt < b.order.expiresAt ? -1 : a.order.expiresAt > b.order.expiresAt ? 1 : 0,
      );
    for (const o of expired) {
      this.clock.advanceTo(o.order.expiresAt);
      this.release(o, 'EXPIRED', 'ORDER_LIFETIME_ENDED', 'EXPIRY');
    }
    this.clock.advanceTo(at);
  }
  submit(c: Extract<SpotCommand, { kind: 'SUBMIT' }>) {
    const i = c.intent,
      key = `${i.portfolio}|${i.clientOrderId}`,
      bodyHash = canonicalHash({ intent: i, candidate: c.candidate, risk: c.risk }),
      old = this.retries.get(key);
    if (old) {
      if (old !== bodyHash) throw new Error('Conflicting client order idempotency key');
      this.checkpoint('SUBMIT', c.id, 'IDEMPOTENT_RETRY');
      return;
    }
    this.retries.set(key, bodyHash);
    const m = this.request.instrumentKeys.includes(i.instrumentKey)
        ? this.evidence.metadata(i.instrumentKey, c.at, c.at)
        : null,
      bound = i.limitPrice ?? i.marketPriceBound!,
      eligibleAt = plusMs(c.at, this.request.latencyMs),
      id = deterministicId('spot-order', {
        runId: this.runId,
        portfolio: i.portfolio,
        clientOrderId: i.clientOrderId,
      }),
      o: SpotOrder = {
        order: SimulatedOrderSchema.parse({
          schemaVersion: 'simulated-order.v1',
          execution: 'SIMULATED',
          id,
          clientOrderId: i.clientOrderId,
          candidateId: c.candidate.id,
          riskDecisionId: c.risk.id,
          portfolio: i.portfolio,
          symbol: c.candidate.symbol,
          side: i.side,
          orderType: i.orderType,
          quantity: i.quantity,
          limitPrice: i.limitPrice,
          status: 'CREATED',
          createdAt: c.at,
          submittedAt: c.at,
          updatedAt: c.at,
          expiresAt: i.expiresAt,
          fillConstraints: {
            priceDataAvailableAt: c.at,
            earliestFillAt: eligibleAt,
            allowPartial: i.allowPartial,
            maxSlippageBps: this.request.slippageBps,
            modelVersion: 'spot-execution.v1',
            limitFillPolicy: 'CONSERVATIVE_NO_GUARANTEE',
          },
          transitions: [],
        }),
        intent: i,
        metadataId: m?.id ?? null,
        filledQuantity: zero,
        remainingQuantity: i.quantity,
        reservedAsset:
          i.side === 'BUY'
            ? this.request.quoteCurrency
            : (m?.baseCode ?? this.request.quoteCurrency),
        reservedAmount: zero,
        rejectionReason: null,
        parentOrderId: null,
        protection: null,
      };
    let reason: string | null = null;
    if (!this.request.portfolios.includes(i.portfolio)) reason = 'UNKNOWN_PORTFOLIO';
    else if (!m) reason = 'HISTORICAL_METADATA_UNAVAILABLE';
    else if (
      c.candidate.portfolio !== i.portfolio ||
      c.risk.portfolio !== i.portfolio ||
      c.risk.candidateId !== c.candidate.id ||
      c.candidate.symbol !== `${m.baseCode}/${m.quoteCode}` ||
      c.candidate.side !== (i.side === 'BUY' ? 'LONG' : 'SHORT')
    )
      reason = 'AUTHORIZATION_IDENTITY';
    else if (!c.risk.allowed) reason = 'RISK_DENIED';
    else if (
      c.risk.stopTargetPolicy.kind === 'FIXED' &&
      (i.protection === null ||
        !new D(i.protection.stopLoss).eq(c.risk.stopTargetPolicy.stopPrice) ||
        !new D(i.protection.takeProfit).eq(c.risk.stopTargetPolicy.targetPrice))
    )
      reason = 'RISK_PROTECTION_POLICY';
    else if (
      c.candidate.rationaleIds.some((id) => {
        const record =
          this.input.bars.find((b) => b.id === id) ??
          this.input.market.instruments.find((m) => m.id === id) ??
          this.input.market.observations.find((m) => m.id === id);
        return (
          record !== undefined &&
          (!isAvailableAt(record, c.candidate.dataCutoff) ||
            ('closeAt' in record && record.closeAt > c.candidate.dataCutoff))
        );
      })
    )
      reason = 'FUTURE_CANDIDATE_EVIDENCE';
    else if (
      c.candidate.decisionAt > c.at ||
      c.risk.decisionAt < c.candidate.decisionAt ||
      c.risk.decisionAt > c.at ||
      c.candidate.validUntil < i.expiresAt ||
      c.risk.expiresAt < i.expiresAt ||
      eligibleAt >= i.expiresAt
    )
      reason = 'AUTHORIZATION_TIMING';
    else if (
      new D(i.quantity).gt(c.risk.sizing.quantity) ||
      new D(i.quantity).mul(bound).gt(c.risk.sizing.maxNotional) ||
      c.risk.sizing.currency !== this.request.quoteCurrency
    )
      reason = 'RISK_SIZE_BOUND';
    else if (
      [m.tickSize, m.quantityStep].some((s) => (s.split('.')[1]?.length ?? 0) > 12) ||
      !isDecimalMultipleOf(i.quantity, m.quantityStep) ||
      !isDecimalMultipleOf(bound, m.tickSize) ||
      (i.protection !== null &&
        (!isDecimalMultipleOf(i.protection.stopLoss, m.tickSize) ||
          !isDecimalMultipleOf(i.protection.takeProfit, m.tickSize) ||
          new D(i.protection.stopLoss).gte(bound) ||
          new D(i.protection.takeProfit).lte(bound)))
    )
      reason = 'PRECISION_OR_PROTECTION';
    else {
      const needed = i.side === 'BUY' ? this.reserveCost(i.quantity, bound, m) : i.quantity;
      if (new D(this.ledger.balance(i.portfolio, o.reservedAsset).free).lt(needed))
        reason = 'INSUFFICIENT_UNRESERVED_BALANCE';
      else o.reservedAmount = needed;
    }
    this.orders.push(o);
    if (reason) {
      o.rejectionReason = reason;
      this.transition(o, 'REJECTED');
    } else {
      this.ledger.move(c.at, i.portfolio, o.reservedAsset, o.reservedAmount, true, id);
      this.transition(o, 'ACCEPTED');
    }
    this.checkpoint('SUBMIT', c.id, reason ?? 'ACCEPTED', [id]);
  }
  cancel(c: Extract<SpotCommand, { kind: 'CANCEL' }>) {
    const o = this.orders.find(
      (o) => o.intent.portfolio === c.portfolio && o.intent.clientOrderId === c.clientOrderId,
    );
    if (!o) {
      this.checkpoint('CANCEL', c.id, 'UNKNOWN_CLIENT_ORDER');
      return;
    }
    this.release(o, 'CANCELED', 'CLIENT_CANCEL', 'CANCEL');
    for (const child of this.orders.filter((child) => child.parentOrderId === o.order.id))
      this.release(child, 'CANCELED', 'PARENT_PROTECTION_CANCEL', 'CANCEL');
    this.checkpoint('CANCEL', c.id, 'CANCEL_COMPLETE_OR_ALREADY_TERMINAL', [o.order.id]);
  }
  price(o: SpotOrder, b: MarketBar, m: InstrumentRevision): ModeledPrice | { reason: string } {
    const impact = new D(this.request.spreadBps).div(2).plus(this.request.slippageBps).div(10000),
      buy = o.intent.side === 'BUY',
      adjust = (v: string) =>
        grid(new D(v).mul(buy ? new D(1).plus(impact) : new D(1).minus(impact)), m.tickSize, buy),
      flags = ['OHLCV_DEPTH_UNKNOWN', 'SIMULATED_PRICE_ENVELOPE'],
      bound = o.intent.limitPrice ?? o.intent.marketPriceBound!;
    let reference = buy ? b.high : b.low,
      price = adjust(reference),
      trigger: SpotFillTrace['trigger'] = null;
    if (o.protection) {
      const p = o.protection,
        stopTouched = new D(b.low).lte(p.stopLoss),
        stop = p.triggeredStop || stopTouched,
        target = new D(b.high).gte(p.takeProfit);
      if (stop) {
        if (!p.triggeredStop) p.triggerBarIds.push(b.id);
        p.triggeredStop = true;
        trigger = 'STOP';
        reference = b.low;
        price = adjust(reference);
        if (stopTouched && target) flags.push('STOP_AND_TARGET_TOUCHED_STOP_FIRST');
      } else if (
        target &&
        new D(b.high).gt(p.takeProfit) &&
        new D(adjust(b.high)).gte(p.takeProfit)
      ) {
        trigger = 'TARGET';
        reference = p.takeProfit;
        price = p.takeProfit;
      } else return { reason: 'PROTECTION_NOT_EXECUTABLE' } as const;
    } else if (o.intent.orderType === 'LIMIT') {
      reference = buy ? b.low : b.high;
      const adjusted = adjust(reference),
        penetrated = buy
          ? new D(reference).lt(bound) && new D(adjusted).lte(bound)
          : new D(reference).gt(bound) && new D(adjusted).gte(bound);
      if (!penetrated) return { reason: 'LIMIT_NOT_STRICTLY_PENETRATED' } as const;
      price = bound;
      flags.push('MAKER_QUEUE_UNKNOWN_ASSUMED_PENETRATION');
    }
    if (new D(price).lte(0)) return { reason: 'NONPOSITIVE_MODELED_PRICE' } as const;
    if (!o.protection && (buy ? new D(price).gt(bound) : new D(price).lt(bound)))
      return { reason: 'PRICE_BOUND' } as const;
    if (
      o.intent.protection &&
      (new D(price).lte(o.intent.protection.stopLoss) ||
        new D(price).gte(o.intent.protection.takeProfit))
    )
      return { reason: 'ENTRY_OUTSIDE_PROTECTION' } as const;
    return { price, reference, flags, trigger };
  }
  armProtection(
    parent: SpotOrder,
    quantity: string,
    filledAt: UtcTimestamp,
    fillId: string,
    m: InstrumentRevision,
  ) {
    const p = parent.intent.protection!;
    const id = deterministicId('spot-protection', { parentOrderId: parent.order.id, fillId }),
      eligibleAt = plusMs(filledAt, this.request.latencyMs),
      intent = {
        ...parent.intent,
        clientOrderId: id,
        side: 'SELL' as const,
        orderType: 'MARKET' as const,
        quantity: amount(quantity),
        limitPrice: null,
        marketPriceBound: m.tickSize,
        allowPartial: true,
        protection: null,
      },
      child: SpotOrder = {
        order: SimulatedOrderSchema.parse({
          ...parent.order,
          id,
          clientOrderId: id,
          side: 'SELL',
          orderType: 'MARKET',
          quantity: intent.quantity,
          limitPrice: null,
          status: 'CREATED',
          createdAt: filledAt,
          submittedAt: filledAt,
          updatedAt: filledAt,
          transitions: [],
          fillConstraints: {
            ...parent.order.fillConstraints,
            priceDataAvailableAt: filledAt,
            earliestFillAt: eligibleAt,
            allowPartial: true,
          },
        }),
        intent,
        metadataId: m.id,
        filledQuantity: zero,
        remainingQuantity: intent.quantity,
        reservedAsset: m.baseCode,
        reservedAmount: intent.quantity,
        rejectionReason: null,
        parentOrderId: parent.order.id,
        protection: { ...p, triggeredStop: false, triggerBarIds: [] },
      };
    this.orders.push(child);
    const journalId = this.ledger.move(
      filledAt,
      intent.portfolio,
      m.baseCode,
      intent.quantity,
      true,
      id,
    );
    this.transition(child, 'ACCEPTED');
    return journalId;
  }
  fill(
    o: SpotOrder,
    b: MarketBar,
    m: InstrumentRevision,
    metadataIds: string[],
    quantity: string,
    p: ModeledPrice,
  ) {
    const at = this.clock.now(),
      id = deterministicId('spot-fill', {
        runId: this.runId,
        orderId: o.order.id,
        barKey: barCloseKey(b),
      }),
      liquidity = o.intent.orderType === 'LIMIT' ? 'MAKER' : 'TAKER',
      notional = amount(new D(quantity).mul(p.price)),
      fee = amount(
        new D(notional)
          .mul(liquidity === 'MAKER' ? this.request.makerRate : this.request.takerRate)
          .toDecimalPlaces(this.request.quoteScale, Decimal.ROUND_CEIL),
      ),
      fill = SimulatedFillSchema.parse({
        schemaVersion: 'simulated-fill.v1',
        execution: 'SIMULATED',
        id,
        orderId: o.order.id,
        clientOrderId: o.order.clientOrderId,
        portfolio: o.intent.portfolio,
        symbol: o.order.symbol,
        side: o.intent.side,
        quantity,
        price: p.price,
        notional,
        fee,
        feeCurrency: this.request.quoteCurrency,
        liquidity,
        priceAvailableAt: b.availableAt,
        orderSubmittedAt: o.order.submittedAt,
        earliestFillAt: b.availableAt,
        filledAt: at,
        modelVersion: 'spot-execution.v1',
        evidenceIds: [...new Set([b.id, ...metadataIds, ...(o.protection?.triggerBarIds ?? [])])],
      }),
      remaining = amount(new D(o.remainingQuantity).minus(quantity)),
      remainingReservation =
        o.intent.side === 'BUY'
          ? this.reserveCost(remaining, o.intent.limitPrice ?? o.intent.marketPriceBound!, m)
          : remaining,
      released = amount(new D(o.reservedAmount).minus(remainingReservation)),
      journalIds: string[] = [];
    validateFillAgainstOrder(fill, o.order, o.filledQuantity);
    if (this.fills.some((f) => f.fill.id === id)) throw new Error('Duplicate fill');
    journalIds.push(
      this.ledger.move(at, o.intent.portfolio, o.reservedAsset, released, false, o.order.id),
    );
    o.reservedAmount = remainingReservation;
    const portfolio = o.intent.portfolio,
      buy = o.intent.side === 'BUY',
      postings: SpotPosting[] = [
        {
          portfolio,
          asset: m.baseCode,
          account: 'FREE',
          amount: buy ? amount(quantity) : negative(quantity),
        },
        {
          portfolio,
          asset: m.baseCode,
          account: 'EXTERNAL',
          amount: buy ? negative(quantity) : amount(quantity),
        },
        {
          portfolio,
          asset: m.quoteCode,
          account: 'FREE',
          amount: buy ? negative(notional) : notional,
        },
        {
          portfolio,
          asset: m.quoteCode,
          account: 'EXTERNAL',
          amount: buy ? notional : negative(notional),
        },
      ];
    journalIds.push(this.ledger.post(at, 'TRADE', postings, o.order.id, id));
    journalIds.push(
      this.ledger.post(
        at,
        'FEE',
        [
          { portfolio, asset: m.quoteCode, account: 'FREE', amount: negative(fee) },
          { portfolio, asset: m.quoteCode, account: 'FEES', amount: fee },
        ],
        o.order.id,
        id,
      ),
    );
    o.remainingQuantity = remaining;
    o.filledQuantity = amount(new D(o.filledQuantity).plus(quantity));
    this.transition(o, new D(remaining).isZero() ? 'FILLED' : 'PARTIALLY_FILLED');
    if (o.intent.protection) journalIds.push(this.armProtection(o, quantity, at, id, m));
    this.fills.push({
      fill,
      barId: b.id,
      metadataIds,
      referencePrice: p.reference,
      flags: p.flags,
      trigger: p.trigger,
      journalIds,
    });
  }
  bar(b: MarketBar) {
    const series = barCloseKey(b).slice(0, barCloseKey(b).lastIndexOf('|')),
      last = this.lastCloses.get(series);
    if (last && b.closeAt <= last) {
      this.checkpoint('BAR', b.id, 'LATE_OR_CORRECTED_CANDLE_NO_NEW_LIQUIDITY');
      return;
    }
    this.lastCloses.set(series, b.closeAt);
    let matched = false;
    const ids: string[] = [],
      fills: string[] = [];
    for (const key of this.request.instrumentKeys) {
      const proof = this.evidence.bar(key, b);
      if (!proof) continue;
      matched = true;
      const m = proof.metadata;
      for (const portfolio of this.request.portfolios) {
        let capacity = grid(
          new D(b.volume).mul(this.request.participationFraction),
          m.quantityStep,
        );
        const candidates = this.orders
          .filter(
            (o) => active(o) && o.intent.portfolio === portfolio && o.intent.instrumentKey === key,
          )
          .sort(
            (a, b) =>
              Number(b.protection !== null) - Number(a.protection !== null) ||
              (a.order.createdAt < b.order.createdAt
                ? -1
                : a.order.createdAt > b.order.createdAt
                  ? 1
                  : 0),
          );
        for (const o of candidates) {
          ids.push(o.order.id);
          if (o.order.fillConstraints.earliestFillAt > b.openAt) {
            this.checkpoint('BAR', b.id, 'ORDER_NOT_ACTIVE_FOR_FULL_CANDLE', [o.order.id]);
            continue;
          }
          const original = this.input.market.instruments.find((v) => v.id === o.metadataId);
          if (
            !original ||
            original.tickSize !== m.tickSize ||
            original.quantityStep !== m.quantityStep ||
            original.baseCode !== m.baseCode ||
            original.quoteCode !== m.quoteCode
          ) {
            this.release(o, 'CANCELED', 'METADATA_CHANGED', 'BAR');
            continue;
          }
          const price = this.price(o, b, m);
          if (!('price' in price)) {
            this.checkpoint('BAR', b.id, price.reason, [o.order.id]);
            continue;
          }
          const quantity = amount(D.min(o.remainingQuantity, capacity));
          if (price.flags.includes('STOP_AND_TARGET_TOUCHED_STOP_FIRST'))
            this.checkpoint('BAR', b.id, 'AMBIGUOUS_STOP_TARGET_STOP_FIRST', [o.order.id]);
          if (
            new D(quantity).isZero() ||
            (!o.intent.allowPartial && new D(quantity).lt(o.remainingQuantity))
          ) {
            this.checkpoint('BAR', b.id, 'VOLUME_CAP_NO_FILL', [o.order.id]);
            continue;
          }
          const notional = new D(quantity).mul(price.price),
            rate = o.intent.orderType === 'LIMIT' ? this.request.makerRate : this.request.takerRate,
            fee = notional.mul(rate).toDecimalPlaces(this.request.quoteScale, Decimal.ROUND_CEIL),
            authorization = this.input.commands.find(
              (c) =>
                c.kind === 'SUBMIT' &&
                c.intent.portfolio === o.intent.portfolio &&
                c.intent.clientOrderId === o.intent.clientOrderId,
            );
          if (o.intent.side === 'SELL' && fee.gt(notional)) {
            this.checkpoint('BAR', b.id, 'FEE_EXCEEDS_SALE_PROCEEDS', [o.order.id]);
            continue;
          }
          const priorNotional = this.fills
            .filter((f) => f.fill.orderId === o.order.id)
            .reduce((v, f) => v.plus(f.fill.notional), new D(0));
          if (
            o.parentOrderId === null &&
            authorization?.kind === 'SUBMIT' &&
            priorNotional.plus(notional).gt(authorization.risk.sizing.maxNotional)
          ) {
            this.checkpoint('BAR', b.id, 'RISK_NOTIONAL_AT_FILL', [o.order.id]);
            continue;
          }
          this.fill(o, b, m, proof.ids, quantity, price);
          capacity = amount(new D(capacity).minus(quantity));
          fills.push(this.fills.at(-1)!.fill.id);
          this.checkpoint(
            'BAR',
            b.id,
            price.trigger ?? 'FILLED',
            [o.order.id],
            [this.fills.at(-1)!.fill.id],
          );
        }
      }
    }
    this.checkpoint(
      'BAR',
      b.id,
      matched ? 'CANDLE_COMPLETE' : 'UNAVAILABLE_OR_INVALID_PRICE_EVIDENCE',
      ids,
      fills,
    );
  }
  run(): SpotSimulationArtifact {
    const ids = new Set<string>(),
      sequences = new Set<number>(),
      authorizations = new Map<string, string>();
    for (const c of this.input.commands) {
      if (ids.has(c.id) || sequences.has(c.sequence))
        throw new Error('Duplicate simulation command identity/sequence');
      ids.add(c.id);
      sequences.add(c.sequence);
      if (c.kind === 'SUBMIT')
        for (const [kind, record] of [
          ['candidate', c.candidate],
          ['risk', c.risk],
        ] as const) {
          const key = `${kind}|${record.id}`,
            hash = canonicalHash(record),
            old = authorizations.get(key);
          if (old && old !== hash) throw new Error('Conflicting authorization evidence identity');
          authorizations.set(key, hash);
        }
      if (c.at < this.request.startAt || c.at >= this.request.endAt)
        throw new Error('Invalid simulation command period');
    }
    const symbols = [...new Set(this.input.bars.map((b) => b.instrumentId))];
    if (symbols.length > 20) throw new Error('Simulation symbol work bound');
    const schedule = scheduleReplayEvents(
        { schemaVersion: 'replay-input.v1', bars: this.input.bars, news: [] },
        {
          schemaVersion: 'replay-request.v1',
          startAt: this.request.startAt,
          endAt: this.request.endAt,
          generatedAt: this.request.generatedAt,
          symbols: symbols.length ? symbols : ['UNKNOWN/UNKNOWN'],
          randomSeed: this.request.randomSeed,
          snapshotEvery: 1000,
          maxQueriesPerEvent: 1,
        },
      ),
      excludedBars = [
        ...schedule.exclusions.map((e) => ({ recordId: e.recordId, reason: e.reason })),
        ...schedule.events
          .filter((e) => e.availableAt < this.request.startAt)
          .map((e) => ({ recordId: e.recordId, reason: 'BEFORE_START' })),
      ],
      events = [
        ...schedule.events
          .filter((e) => e.availableAt >= this.request.startAt)
          .map((e) => ({
            at: e.availableAt,
            priority: 2,
            sequence: 0,
            id: e.recordId,
            bar: e.kind === 'MARKET_BAR' ? e.record : null,
            command: null,
            cancelAck: null,
          })),
        ...this.input.commands.map((c) => ({
          at: c.at,
          priority: 1,
          sequence: c.sequence,
          id: c.id,
          bar: null,
          command: c,
          cancelAck: null,
        })),
        ...this.input.commands
          .filter(
            (c): c is Extract<SpotCommand, { kind: 'CANCEL' }> =>
              c.kind === 'CANCEL' &&
              this.request.latencyMs > 0 &&
              plusMs(c.at, this.request.latencyMs) < this.request.endAt,
          )
          .map((c) => ({
            at: plusMs(c.at, this.request.latencyMs),
            priority: 0,
            sequence: c.sequence,
            id: c.id,
            bar: null,
            command: null,
            cancelAck: c,
          })),
      ].sort((a, b) =>
        a.at < b.at
          ? -1
          : a.at > b.at
            ? 1
            : a.priority - b.priority || a.sequence - b.sequence || (a.id < b.id ? -1 : 1),
      );
    if (events.length * Math.max(1, this.input.commands.length) > 250000)
      throw new Error('Spot execution work budget');
    this.ledger.initialize(this.request);
    for (const e of events) {
      this.advance(e.at);
      if (e.cancelAck) this.cancel(e.cancelAck);
      else if (e.command) {
        if (e.command.kind === 'SUBMIT') this.submit(e.command);
        else if (this.request.latencyMs === 0) this.cancel(e.command);
        else this.checkpoint('CANCEL', e.command.id, 'CANCEL_REQUESTED_WAITING_FOR_ACK');
      } else if (e.bar) this.bar(e.bar);
    }
    this.advance(this.request.endAt);
    for (const o of this.orders) this.release(o, 'CANCELED', 'END_OF_RUN_RELEASE', 'FINALIZE');
    this.checkpoint('FINALIZE', this.runId, 'ALL_REMAINING_RESERVATIONS_RELEASED');
    const balances = this.ledger.balances();
    if (canonicalHash(reconcileSpotJournal(this.ledger.entries)) !== canonicalHash(balances))
      throw new Error('Final journal reconciliation mismatch');
    const artifact = SpotSimulationArtifactSchema.parse({
      schemaVersion: 'spot-simulation-artifact.v1',
      execution: 'SIMULATED',
      liveExecution: 'DISABLED',
      algorithmVersion: 'spot-execution.v1',
      codeVersion: this.codeVersion,
      input: this.input,
      request: this.request,
      inputHash: this.inputHash,
      configHash: this.configHash,
      runId: this.runId,
      randomAlgorithm: 'mulberry32.v1',
      orders: this.orders,
      fills: this.fills,
      journal: this.ledger.entries,
      trace: this.trace,
      balances,
      excludedBars,
      reconciliation: {
        balanced: true,
        nonnegative: true,
        reservationsMatch: true,
        uniqueFills: true,
        journalHash: canonicalHash(this.ledger.entries),
        fillsHash: canonicalHash(this.fills),
        balancesHash: canonicalHash(balances),
      },
    });
    deepFreeze(artifact);
    return artifact;
  }
}
export function simulateSpot(input: unknown, request: unknown, codeVersion: string) {
  return new ExecutionSimulator(input, request, codeVersion).run();
}
export function validateSpotSimulationArtifact(input: unknown) {
  const artifact = SpotSimulationArtifactSchema.parse(input),
    rebuilt = simulateSpot(artifact.input, artifact.request, artifact.codeVersion);
  if (canonicalHash(artifact) !== canonicalHash(rebuilt))
    throw new Error('Spot simulation integrity mismatch');
  return rebuilt;
}
