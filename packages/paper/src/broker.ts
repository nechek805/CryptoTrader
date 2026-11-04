import { Decimal } from 'decimal.js';
import {
  PaperConfigSchema,
  PaperEventSchema,
  PaperReportSchema,
  RiskAccountSchema,
  SignalCandidateSchema,
  SimulatedFillSchema,
  SimulatedOrderSchema,
  validateFillAgainstOrder,
  utcNanoseconds,
} from '@crypto/contracts';
import type {
  PaperConfig,
  PaperEvent,
  PaperFill,
  PaperLog,
  PaperOrder,
  PaperQuote,
  PaperReport,
  RiskRequest,
  SimulatedOrder,
  UtcTimestamp,
} from '@crypto/contracts';
import { canonicalHash, deepFreeze, deterministicId, fromEpoch } from '@crypto/core';
import { SpotLedger, reconcileSpotJournal } from '@crypto/backtest';
import { verifyDecisionRecord } from '@crypto/risk';

const D = Decimal.clone({ precision: 256, rounding: Decimal.ROUND_HALF_EVEN });
const money = (v: Decimal.Value) => new D(v).toDecimalPlaces(36, Decimal.ROUND_DOWN).toFixed();
const portfolios = ['BASELINE', 'NEWS_ONLY', 'MARKET_ONLY', 'FUSION'] as const;
const active = (o: PaperOrder) => ['ACCEPTED', 'PARTIALLY_FILLED'].includes(o.order.status);
const afterMs = (at: UtcTimestamp, ms: number) =>
  fromEpoch(utcNanoseconds(at) + BigInt(ms) * 1000000n, 'nanoseconds');
type Trade = Extract<PaperEvent, { kind: 'TRADE' }>;

/** Event-sourced virtual spot broker. No transport, private account, signing or real order capability. */
export class PaperBroker {
  readonly config: PaperConfig;
  readonly #ledger = new SpotLedger();
  readonly #orders: PaperOrder[] = [];
  readonly #fills: PaperFill[] = [];
  readonly #decisions: PaperReport['decisions'] = [];
  readonly #log: PaperLog[] = [];
  readonly #equity: PaperReport['equity'] = [];
  readonly #alerts: PaperReport['alerts'] = [];
  readonly #quotes = new Map<string, PaperQuote>();
  readonly #seen = new Map<string, string>();
  readonly #providerSeen = new Map<string, string>();
  readonly #intentSeen = new Map<string, string>();
  readonly #basis = new Map<string, string>();
  readonly #realized = new Map<string, string>();
  readonly #peak = new Map<string, string>();
  readonly #daily = new Map<string, { day: string; equity: string | null }>();
  readonly #exitTriggers = new Map<string, 'STOP' | 'TARGET'>();
  readonly #lastNews = new Map<string, { at: UtcTimestamp; healthy: boolean }>();
  #previousNewsFresh = true;
  #now: UtcTimestamp;
  #status: PaperReport['status'] = 'RUNNING';
  #marketHealthy = false;
  #newsHealthy = true;
  #tradeHealthy = true;
  #fatal = false;
  constructor(configInput: unknown) {
    this.config = PaperConfigSchema.parse(configInput);
    const c = this.config;
    if (
      c.startAt >= c.endAt ||
      !c.source.approved ||
      c.source.reviewedAt > c.startAt ||
      c.source.validUntil < c.endAt ||
      new D(c.makerRate).gt('0.1') ||
      new D(c.takerRate).gt('0.1') ||
      new D(c.participation).isZero() ||
      new D(c.slippageBps).gt(1000) ||
      new Set(c.instruments.map((i) => i.symbol)).size !== c.instruments.length ||
      c.instruments.some(
        (i) =>
          i.symbol !== `${i.base}/${c.quoteCurrency}` ||
          i.availableAt > c.startAt ||
          i.validUntil < c.endAt,
      )
    )
      throw new Error('Invalid paper freeze, provider eligibility or instrument metadata');
    deepFreeze(c);
    this.#now = c.startAt;
    this.#tradeHealthy = c.origin === 'SYNTHETIC';
    this.#previousNewsFresh = c.newsSources.length === 0;
    for (const portfolio of portfolios) {
      for (const [asset, value] of [
        [c.quoteCurrency, c.initialCash],
        ...c.instruments.map((i) => [i.base, '0']),
      ] as [string, string][])
        this.#ledger.post(c.startAt, 'DEPOSIT', [
          { portfolio, asset, account: 'FREE', amount: money(value) as never },
          { portfolio, asset, account: 'EXTERNAL', amount: money(new D(value).neg()) as never },
        ]);
      this.#peak.set(portfolio, c.initialCash);
      this.#daily.set(portfolio, { day: c.startAt.slice(0, 10), equity: c.initialCash });
    }
    this.mark();
  }
  private alert(code: string, sourceId: string | null = null) {
    this.#alerts.push({
      id: deterministicId('paper-alert', {
        at: this.#now,
        index: this.#alerts.length,
        code,
        sourceId,
      }),
      at: this.#now,
      code,
      sourceId,
    });
  }
  private fresh(symbol: string): PaperQuote | null {
    const q = this.#quotes.get(symbol);
    return q &&
      this.#marketHealthy &&
      !this.#fatal &&
      utcNanoseconds(this.#now) - utcNanoseconds(q.observedAt) <=
        BigInt(this.config.maxQuoteAgeSeconds) * 1000000000n
      ? q
      : null;
  }
  private valuation(portfolio: (typeof portfolios)[number]) {
    const cashBalance = this.#ledger.balance(portfolio, this.config.quoteCurrency),
      cash = new D(cashBalance.free).plus(cashBalance.reserved);
    let holdings = new D(0),
      cost = new D(0),
      known = true;
    const sourceQuoteIds: string[] = [],
      positions: RiskRequest['account']['positions'] = [];
    for (const i of this.config.instruments) {
      const balance = this.#ledger.balance(portfolio, i.base),
        quantity = new D(balance.free).plus(balance.reserved),
        q = this.fresh(i.symbol);
      cost = cost.plus(this.#basis.get(`${portfolio}/${i.symbol}`) ?? 0);
      if (quantity.gt(0)) {
        if (!q) known = false;
        else {
          const value = quantity.mul(q.bid);
          holdings = holdings.plus(value);
          sourceQuoteIds.push(q.id);
          positions.push({ symbol: i.symbol, notional: money(value) as never });
        }
      }
    }
    const equity = known ? cash.plus(holdings) : null;
    return { cash, holdings: known ? holdings : null, equity, cost, sourceQuoteIds, positions };
  }
  account(portfolio: (typeof portfolios)[number]): RiskRequest['account'] {
    const v = this.valuation(portfolio),
      latestEntry = this.#fills
        .filter((f) => f.fill.portfolio === portfolio && f.fill.side === 'BUY')
        .at(-1);
    return RiskAccountSchema.parse({
      portfolio,
      asOf: this.#now,
      day: this.#now.slice(0, 10),
      equity: v.equity?.gt(0) ? money(v.equity) : null,
      cash: this.#ledger.balance(portfolio, this.config.quoteCurrency).free,
      dayStartEquity: this.#daily.get(portfolio)?.equity ?? null,
      currency: this.config.quoteCurrency,
      positions: v.positions,
      lastEntryAt: latestEntry?.fill.filledAt ?? null,
    });
  }
  private mark() {
    for (const portfolio of portfolios) {
      const v = this.valuation(portfolio),
        peak = new D(this.#peak.get(portfolio)!),
        realized = new D(this.#realized.get(portfolio) ?? 0);
      if (v.equity && v.equity.gt(peak)) this.#peak.set(portfolio, money(v.equity));
      const currentPeak = new D(this.#peak.get(portfolio)!);
      this.#equity.push({
        portfolio,
        at: this.#now,
        cash: money(v.cash) as never,
        equity: v.equity === null ? null : (money(v.equity) as never),
        holdingsValue: v.holdings === null ? null : (money(v.holdings) as never),
        realizedNetPnl: money(realized) as never,
        unrealizedNetPnl: v.holdings === null ? null : (money(v.holdings.minus(v.cost)) as never),
        exposureFraction:
          v.equity?.gt(0) && v.holdings ? (money(v.holdings.div(v.equity)) as never) : null,
        drawdownFraction:
          v.equity === null ? null : (money(currentPeak.minus(v.equity).div(currentPeak)) as never),
        sourceQuoteIds: v.sourceQuoteIds,
      });
      if (
        v.equity &&
        !v.equity.minus(this.config.initialCash).eq(realized.plus(v.holdings!.minus(v.cost)))
      )
        throw new Error('Paper equity/cost basis does not reconcile');
    }
  }
  private transition(o: PaperOrder, status: SimulatedOrder['status']) {
    o.order = SimulatedOrderSchema.parse({
      ...o.order,
      status,
      updatedAt: this.#now,
      transitions: [...o.order.transitions, { from: o.order.status, to: status, at: this.#now }],
    });
    o.lifecycle = (
      {
        ACCEPTED: 'ACCEPTED',
        PARTIALLY_FILLED: 'PARTIAL',
        FILLED: 'FILLED',
        CANCELED: 'CANCELLED',
        EXPIRED: 'EXPIRED',
        REJECTED: 'RISK_REJECTED',
        CREATED: 'PROPOSED',
      } as const
    )[status];
  }
  private release(o: PaperOrder, status: 'CANCELED' | 'EXPIRED') {
    if (!active(o)) return;
    if (new D(o.reservedCash).gt(0))
      this.#ledger.move(
        this.#now,
        o.order.portfolio,
        this.config.quoteCurrency,
        o.reservedCash,
        false,
        o.order.id,
      );
    o.reservedCash = money(0) as never;
    this.transition(o, status);
  }
  private blocked(portfolio: (typeof portfolios)[number]) {
    return (
      this.#status !== 'RUNNING' ||
      this.#fatal ||
      !this.#marketHealthy ||
      !this.#tradeHealthy ||
      (!this.newsFresh() && (portfolio === 'NEWS_ONLY' || portfolio === 'FUSION'))
    );
  }
  private newsFresh() {
    return (
      this.#newsHealthy &&
      this.config.newsSources.every((s) => {
        const h = this.#lastNews.get(s.id);
        return (
          h?.healthy &&
          s.validUntil > this.#now &&
          utcNanoseconds(this.#now) - utcNanoseconds(h.at) <=
            BigInt(s.heartbeatTtlSeconds) * 1000000000n
        );
      })
    );
  }
  quoteAt(symbol: string): PaperQuote | null {
    const q = this.fresh(symbol);
    if (!q) return null;
    const copy = structuredClone(q);
    deepFreeze(copy);
    return copy;
  }
  executionInterest() {
    return {
      activeOrders: this.#orders.some(active),
      limitOrders: this.#orders.some((o) => active(o) && o.order.orderType === 'LIMIT'),
    };
  }
  hasConflictingDecision(input: unknown) {
    const c = SignalCandidateSchema.parse(input);
    return this.#decisions.some((d) => {
      const old = d.request.risk.candidate;
      return (
        old.portfolio === c.portfolio &&
        old.decisionAt === c.decisionAt &&
        old.symbol === c.symbol &&
        old.id !== c.id
      );
    });
  }
  operationalStatus() {
    return {
      status: this.#status,
      now: this.#now,
      events: this.#log.length,
      orders: this.#orders.length,
      fills: this.#fills.length,
    };
  }
  /** Current accepted state at the replay clock; historical alerts are separate. */
  sourceHealth() {
    return {
      fatal: this.#fatal,
      marketConnected: this.#marketHealthy && this.#tradeHealthy,
      marketFresh: this.config.instruments.every((i) => this.fresh(i.symbol) !== null),
      news: this.config.newsSources.map((s) => {
        const h = this.#lastNews.get(s.id);
        return {
          id: s.id,
          lastObservedAt: h?.at ?? null,
          connected: this.#newsHealthy && (h?.healthy ?? false),
          fresh:
            !!h &&
            s.validUntil > this.#now &&
            utcNanoseconds(this.#now) - utcNanoseconds(h.at) <=
              BigInt(s.heartbeatTtlSeconds) * 1000000000n,
        };
      }),
    };
  }
  private propose(e: Extract<PaperEvent, { kind: 'PROPOSE' }>) {
    const r = verifyDecisionRecord(e.decision),
      c = r.request.risk.candidate,
      risk = r.risk.decision,
      key = `${c.strategyId}/${c.portfolio}/${c.id}/${c.version}`,
      intentHash = canonicalHash({ decision: r, orderType: e.orderType, limitPrice: e.limitPrice }),
      old = this.#intentSeen.get(key);
    if (old) {
      if (old !== intentHash) throw new Error('Conflicting paper signal idempotency key');
      return;
    }
    const { asOf: accountAsOf, ...suppliedAccount } = r.request.risk.account,
      { asOf: _currentAsOf, ...currentAccount } = this.account(c.portfolio);
    void _currentAsOf;
    const instrument = this.config.instruments.find((i) => i.symbol === c.symbol),
      q = this.fresh(c.symbol),
      expiresAt = [c.validUntil, risk.expiresAt].sort()[0]!,
      denied =
        !risk.allowed ||
        this.blocked(c.portfolio) ||
        c.side !== 'LONG' ||
        c.portfolio === 'BASELINE' ||
        !instrument ||
        !q ||
        r.configHash !== this.config.riskPolicyHash ||
        r.request.runManifestHash !== this.config.runManifestHash ||
        r.request.evidence.some(
          (e) => e.origin !== (this.config.origin === 'SYNTHETIC' ? 'SYNTHETIC' : 'RESEARCH'),
        ) ||
        r.request.risk.at > this.#now ||
        r.risk.decision.audit.codeVersion !== this.config.codeVersion ||
        utcNanoseconds(this.#now) - utcNanoseconds(accountAsOf) >
          BigInt(r.policy.risk.maxAccountAgeSeconds) * 1000000000n ||
        c.decisionAt > this.#now ||
        expiresAt <= this.#now ||
        !new D(r.policy.risk.feeRate).gte(D.max(this.config.makerRate, this.config.takerRate)) ||
        canonicalHash(suppliedAccount) !== canonicalHash(currentAccount) ||
        (q !== null &&
          (!r.request.risk.market.evidenceIds.includes(q.id) ||
            !r.request.evidence.some((e) => e.id === q.id && e.contentHash === canonicalHash(q)) ||
            r.request.risk.market.observedAt !== q.observedAt ||
            r.request.risk.market.availableAt !== q.at ||
            new D(q.ask).minus(q.bid).div(q.bid).mul(10000).gt(r.policy.risk.maxSpreadBps) ||
            new D(r.request.risk.market.liquidityNotional).gt(
              D.min(new D(q.bid).mul(q.bidQuantity), new D(q.ask).mul(q.askQuantity)),
            ))) ||
        (instrument !== undefined &&
          (r.request.risk.market.quantityStep !== instrument.quantityStep ||
            r.request.risk.market.minimumQuantity !== instrument.minimumQuantity)) ||
        (e.orderType === 'LIMIT') !== (e.limitPrice !== null) ||
        (e.limitPrice !== null &&
          (!new D(e.limitPrice).mod(instrument?.tickSize ?? '1').isZero() ||
            new D(e.limitPrice).gt(r.request.risk.market.entryPrice)));
    const quantity = risk.allowed ? risk.sizing.quantity : r.request.risk.market.minimumQuantity,
      o: PaperOrder = {
        order: SimulatedOrderSchema.parse({
          schemaVersion: 'simulated-order.v1',
          execution: 'SIMULATED',
          id: deterministicId('paper-order', { manifest: this.config.runManifestHash, key }),
          clientOrderId: deterministicId('paper-client', { key }),
          candidateId: c.id,
          riskDecisionId: risk.id,
          portfolio: c.portfolio,
          symbol: c.symbol,
          side: 'BUY',
          orderType: e.orderType,
          quantity,
          limitPrice: e.limitPrice,
          status: 'CREATED',
          createdAt: this.#now,
          submittedAt: null,
          updatedAt: this.#now,
          expiresAt: expiresAt > this.#now ? expiresAt : afterMs(this.#now, 1),
          fillConstraints: {
            priceDataAvailableAt: this.#now,
            earliestFillAt: afterMs(this.#now, this.config.latencyMs),
            allowPartial: true,
            maxSlippageBps: this.config.slippageBps,
            modelVersion: 'paper-quote-trade.v1',
            limitFillPolicy: 'CONSERVATIVE_NO_GUARANTEE',
          },
          transitions: [],
        }),
        lifecycle: 'PROPOSED',
        decisionId: r.id,
        parentOrderId: null,
        intentHash,
        filledQuantity: money(0) as never,
        reservedCash: money(0) as never,
        positionRemaining: money(0) as never,
        queueAheadRemaining: this.config.queueAheadQuantity,
        rejectionReason: null,
      };
    this.#intentSeen.set(key, intentHash);
    this.#decisions.push(r);
    this.#orders.push(o);
    const bound = new D(r.request.risk.market.entryPrice),
      step = instrument?.quantityStep ?? r.request.risk.market.quantityStep,
      unitFee = new D(step)
        .mul(bound)
        .mul(D.max(this.config.makerRate, this.config.takerRate))
        .toDecimalPlaces(8, Decimal.ROUND_CEIL),
      reserve = new D(quantity).mul(bound).plus(new D(quantity).div(step).mul(unitFee));
    if (
      denied ||
      !new D(this.#ledger.balance(c.portfolio, this.config.quoteCurrency).free).gte(reserve)
    ) {
      o.rejectionReason = risk.allowed
        ? 'BROKER_STATE_OR_AUTHORIZATION_VETO'
        : r.finalReasons.join('|');
      this.transition(o, 'REJECTED');
      return;
    }
    this.#ledger.move(
      this.#now,
      c.portfolio,
      this.config.quoteCurrency,
      money(reserve),
      true,
      o.order.id,
    );
    o.reservedCash = money(reserve) as never;
    o.order = { ...o.order, submittedAt: this.#now };
    this.transition(o, 'ACCEPTED');
  }
  private quote(e: PaperQuote) {
    const instrument = this.config.instruments.find((i) => i.symbol === e.symbol),
      ageNs = utcNanoseconds(this.#now) - utcNanoseconds(e.observedAt),
      skew = utcNanoseconds(e.observedAt) - utcNanoseconds(e.providerAt);
    if (
      e.sourceId !== this.config.source.id ||
      !instrument ||
      e.metadataHash !== instrument.metadataHash ||
      e.observedAt > e.at ||
      ageNs > BigInt(this.config.maxQuoteAgeSeconds) * 1000000000n ||
      (skew < 0n ? -skew : skew) > BigInt(this.config.maxClockSkewSeconds) * 1000000000n ||
      new D(e.bid).gt(e.ask) ||
      !new D(e.bid).mod(instrument.tickSize).isZero() ||
      !new D(e.ask).mod(instrument.tickSize).isZero()
    ) {
      this.#marketHealthy = false;
      this.alert('QUARANTINED_QUOTE', e.sourceId);
      return;
    }
    const key = `${e.sourceId}/${e.providerEventId}`,
      semantic = canonicalHash({
        symbol: e.symbol,
        bid: e.bid,
        ask: e.ask,
        bidQuantity: e.bidQuantity,
        askQuantity: e.askQuantity,
        providerAt: e.providerAt,
        rawHash: e.rawHash,
      }),
      old = this.#providerSeen.get(key);
    if (old) {
      if (old !== semantic) {
        this.#marketHealthy = false;
        this.alert('CONFLICTING_PROVIDER_ID', e.sourceId);
      }
      return;
    }
    this.#providerSeen.set(key, semantic);
    this.#quotes.set(e.symbol, e);
    this.#marketHealthy = true;
    this.fillExits(e);
    for (const portfolio of portfolios) {
      let capacity = new D(e.askQuantity).mul(this.config.participation);
      for (const o of this.#orders.filter(
        (o) =>
          active(o) &&
          o.order.portfolio === portfolio &&
          o.order.symbol === e.symbol &&
          o.order.side === 'BUY' &&
          o.order.orderType === 'MARKET',
      )) {
        if (
          this.blocked(portfolio) ||
          o.order.fillConstraints.earliestFillAt > this.#now ||
          e.providerAt < o.order.fillConstraints.earliestFillAt ||
          e.observedAt < o.order.fillConstraints.earliestFillAt
        )
          continue;
        const price = new D(e.ask)
            .mul(new D(1).plus(new D(this.config.slippageBps).div(10000)))
            .div(instrument.tickSize)
            .ceil()
            .mul(instrument.tickSize),
          decision = this.#decisions.find((d) => d.id === o.decisionId)!;
        if (
          price.gt(decision.request.risk.market.entryPrice) ||
          (decision.risk.decision.stopTargetPolicy.kind === 'FIXED' &&
            price.lte(decision.risk.decision.stopTargetPolicy.stopPrice)) ||
          new D(e.ask).minus(e.bid).div(e.bid).mul(10000).gt(decision.policy.risk.maxSpreadBps)
        )
          continue;
        const quantity = D.min(new D(o.order.quantity).minus(o.filledQuantity), capacity)
          .div(instrument.quantityStep)
          .floor()
          .mul(instrument.quantityStep);
        if (quantity.lte(0)) continue;
        this.fillBuy(o, e, quantity, price, new D(this.config.takerRate));
        capacity = capacity.minus(quantity);
      }
    }
    this.protect(e);
  }
  private fillBuy(
    o: PaperOrder,
    e: PaperQuote | Trade,
    quantity: Decimal,
    price: Decimal,
    rate: Decimal,
  ) {
    const maker = e.kind === 'TRADE',
      reference = maker ? price : new D(e.ask);
    const notional = quantity.mul(price),
      fee = notional.mul(rate).toDecimalPlaces(8, Decimal.ROUND_CEIL),
      prior = new D(o.filledQuantity),
      fill = SimulatedFillSchema.parse({
        schemaVersion: 'simulated-fill.v1',
        execution: 'SIMULATED',
        id: deterministicId('paper-fill', {
          order: o.order.id,
          evidence: e.providerEventId,
          prior: money(prior),
        }),
        orderId: o.order.id,
        clientOrderId: o.order.clientOrderId,
        portfolio: o.order.portfolio,
        symbol: o.order.symbol,
        side: 'BUY',
        quantity: money(quantity),
        price: money(price),
        notional: money(notional),
        fee: money(fee),
        feeCurrency: this.config.quoteCurrency,
        liquidity: maker ? 'MAKER' : 'TAKER',
        priceAvailableAt: e.at,
        orderSubmittedAt: o.order.submittedAt,
        earliestFillAt: e.at,
        filledAt: this.#now,
        modelVersion: 'paper-quote-trade.v1',
        evidenceIds: [e.id, e.rawHash],
      });
    validateFillAgainstOrder(fill, o.order, o.filledQuantity);
    if (notional.plus(fee).gt(o.reservedCash)) throw new Error('Paper reserved cash exceeded');
    const portfolio = o.order.portfolio,
      asset = this.config.instruments.find((i) => i.symbol === o.order.symbol)!.base,
      journalIds = [
        this.#ledger.post(
          this.#now,
          'TRADE',
          [
            {
              portfolio,
              asset: this.config.quoteCurrency,
              account: 'RESERVED',
              amount: money(notional.neg()) as never,
            },
            {
              portfolio,
              asset: this.config.quoteCurrency,
              account: 'EXTERNAL',
              amount: money(notional) as never,
            },
          ],
          o.order.id,
          fill.id,
        ),
        this.#ledger.post(
          this.#now,
          'TRADE',
          [
            { portfolio, asset, account: 'FREE', amount: money(quantity) as never },
            { portfolio, asset, account: 'EXTERNAL', amount: money(quantity.neg()) as never },
          ],
          o.order.id,
          fill.id,
        ),
        this.#ledger.post(
          this.#now,
          'FEE',
          [
            {
              portfolio,
              asset: this.config.quoteCurrency,
              account: 'RESERVED',
              amount: money(fee.neg()) as never,
            },
            {
              portfolio,
              asset: this.config.quoteCurrency,
              account: 'FEES',
              amount: money(fee) as never,
            },
          ],
          o.order.id,
          fill.id,
        ),
      ];
    o.reservedCash = money(new D(o.reservedCash).minus(notional).minus(fee)) as never;
    o.filledQuantity = money(prior.plus(quantity)) as never;
    o.positionRemaining = money(new D(o.positionRemaining).plus(quantity)) as never;
    const basisKey = `${portfolio}/${o.order.symbol}`;
    this.#basis.set(
      basisKey,
      money(new D(this.#basis.get(basisKey) ?? 0).plus(notional).plus(fee)),
    );
    this.#fills.push({
      fill,
      journalIds,
      referencePrice: money(reference) as never,
      slippageCost: money(price.minus(reference).mul(quantity)) as never,
      fidelity: maker ? 'TRADE_THROUGH_ASSUMED_QUEUE' : 'OBSERVED_TOP_OF_BOOK_MODELED_SLIPPAGE',
      trigger: null,
      parentOrderId: null,
      realizedNetPnl: null,
      costBasisReleased: money(0) as never,
    });
    if (new D(o.filledQuantity).eq(o.order.quantity)) {
      if (new D(o.reservedCash).gt(0))
        journalIds.push(
          this.#ledger.move(
            this.#now,
            portfolio,
            this.config.quoteCurrency,
            o.reservedCash,
            false,
            o.order.id,
          ),
        );
      o.reservedCash = money(0) as never;
      this.transition(o, 'FILLED');
    } else this.transition(o, 'PARTIALLY_FILLED');
  }
  private trade(e: Trade) {
    const q = this.fresh(e.symbol),
      instrument = this.config.instruments.find((i) => i.symbol === e.symbol),
      age = utcNanoseconds(this.#now) - utcNanoseconds(e.observedAt),
      skew = utcNanoseconds(e.observedAt) - utcNanoseconds(e.providerAt);
    if (
      !q ||
      !instrument ||
      e.sourceId !== this.config.source.id ||
      e.metadataHash !== instrument.metadataHash ||
      e.observedAt > e.at ||
      age > BigInt(this.config.maxQuoteAgeSeconds) * 1000000000n ||
      (skew < 0n ? -skew : skew) > BigInt(this.config.maxClockSkewSeconds) * 1000000000n
    ) {
      this.alert('QUARANTINED_TRADE', e.sourceId);
      return;
    }
    const key = `${e.sourceId}/${e.providerEventId}`,
      semantic = canonicalHash({
        symbol: e.symbol,
        providerAt: e.providerAt,
        price: e.price,
        quantity: e.quantity,
        aggressor: e.aggressor,
        rawHash: e.rawHash,
      }),
      old = this.#providerSeen.get(key);
    if (old) {
      if (old !== semantic) {
        this.#marketHealthy = false;
        this.alert('CONFLICTING_PROVIDER_ID', e.sourceId);
      }
      return;
    }
    this.#providerSeen.set(key, semantic);
    if (e.aggressor !== 'SELL') return;
    for (const portfolio of portfolios) {
      let capacity = new D(e.quantity).mul(this.config.participation);
      for (const o of this.#orders.filter(
        (o) =>
          active(o) &&
          o.order.portfolio === portfolio &&
          o.order.symbol === e.symbol &&
          o.order.orderType === 'LIMIT',
      )) {
        if (
          this.blocked(portfolio) ||
          e.providerAt < o.order.fillConstraints.earliestFillAt ||
          e.observedAt < o.order.fillConstraints.earliestFillAt ||
          new D(e.price).gte(o.order.limitPrice!)
        )
          continue;
        const queueUsed = D.min(capacity, o.queueAheadRemaining);
        o.queueAheadRemaining = money(new D(o.queueAheadRemaining).minus(queueUsed)) as never;
        capacity = capacity.minus(queueUsed);
        const qty = D.min(new D(o.order.quantity).minus(o.filledQuantity), capacity)
          .div(instrument.quantityStep)
          .floor()
          .mul(instrument.quantityStep);
        if (qty.lte(0)) continue;
        this.fillBuy(o, e, qty, new D(o.order.limitPrice!), new D(this.config.makerRate));
        capacity = capacity.minus(qty);
      }
    }
  }
  private protect(e: PaperQuote) {
    if (!this.fresh(e.symbol) || this.#status === 'STOPPED' || this.#now >= this.config.endAt)
      return;
    for (const parent of this.#orders.filter(
      (o) =>
        o.parentOrderId === null && o.order.symbol === e.symbol && new D(o.positionRemaining).gt(0),
    )) {
      const d = this.#decisions.find((d) => d.id === parent.decisionId)!,
        policy = d.risk.decision.stopTargetPolicy;
      if (policy.kind !== 'FIXED') throw new Error('Paper position lacks protective policy');
      if (new D(e.bid).lte(policy.stopPrice)) this.#exitTriggers.set(parent.order.id, 'STOP');
      else if (new D(e.bid).gte(policy.targetPrice) && !this.#exitTriggers.has(parent.order.id))
        this.#exitTriggers.set(parent.order.id, 'TARGET');
      const trigger = this.#exitTriggers.get(parent.order.id);
      if (!trigger || this.#orders.some((o) => o.parentOrderId === parent.order.id && active(o)))
        continue;
      if (active(parent)) this.release(parent, 'CANCELED');
      const key = { parent: parent.order.id, trigger, at: this.#now },
        expiresAt = [afterMs(this.#now, 300000), this.config.endAt].sort()[0]!,
        order = SimulatedOrderSchema.parse({
          ...parent.order,
          id: deterministicId('paper-exit', key),
          clientOrderId: deterministicId('paper-exit-client', key),
          side: 'SELL',
          orderType: 'MARKET',
          limitPrice: null,
          quantity: parent.positionRemaining,
          status: 'CREATED',
          createdAt: this.#now,
          submittedAt: this.#now,
          updatedAt: this.#now,
          expiresAt,
          transitions: [],
          fillConstraints: {
            ...parent.order.fillConstraints,
            priceDataAvailableAt: this.#now,
            earliestFillAt: afterMs(this.#now, this.config.latencyMs),
          },
        }),
        child: PaperOrder = {
          order,
          lifecycle: 'PROPOSED',
          decisionId: parent.decisionId,
          parentOrderId: parent.order.id,
          intentHash: canonicalHash(key),
          filledQuantity: money(0) as never,
          reservedCash: money(0) as never,
          positionRemaining: money(0) as never,
          queueAheadRemaining: money(0) as never,
          rejectionReason: null,
        };
      this.#orders.push(child);
      this.transition(child, 'ACCEPTED');
      this.alert(`PROTECTIVE_${trigger}`);
    }
  }
  private fillExits(e: PaperQuote) {
    if (!this.fresh(e.symbol) || this.#status === 'STOPPED') return;
    const instrument = this.config.instruments.find((i) => i.symbol === e.symbol)!;
    for (const portfolio of portfolios) {
      let capacity = new D(e.bidQuantity).mul(this.config.participation);
      for (const o of this.#orders.filter(
        (o) =>
          o.order.portfolio === portfolio &&
          o.order.symbol === e.symbol &&
          o.parentOrderId !== null &&
          active(o),
      )) {
        if (
          e.providerAt < o.order.fillConstraints.earliestFillAt ||
          e.observedAt < o.order.fillConstraints.earliestFillAt
        )
          continue;
        const parent = this.#orders.find((p) => p.order.id === o.parentOrderId)!,
          quantity = D.min(
            new D(o.order.quantity).minus(o.filledQuantity),
            parent.positionRemaining,
            this.#ledger.balance(portfolio, instrument.base).free,
            capacity,
          )
            .div(instrument.quantityStep)
            .floor()
            .mul(instrument.quantityStep),
          price = new D(e.bid)
            .mul(new D(1).minus(new D(this.config.slippageBps).div(10000)))
            .div(instrument.tickSize)
            .floor()
            .mul(instrument.tickSize);
        if (quantity.lte(0) || price.lte(0)) continue;
        const notional = price.mul(quantity),
          fee = notional.mul(this.config.takerRate).toDecimalPlaces(8, Decimal.ROUND_CEIL),
          held = new D(this.#ledger.balance(portfolio, instrument.base).free),
          basisKey = `${portfolio}/${e.symbol}`,
          basis = new D(this.#basis.get(basisKey) ?? 0),
          released = quantity.eq(held)
            ? basis
            : basis.mul(quantity).div(held).toDecimalPlaces(36, Decimal.ROUND_DOWN),
          realized = notional.minus(fee).minus(released);
        if (
          new D(this.#ledger.balance(portfolio, this.config.quoteCurrency).free)
            .plus(notional)
            .lt(fee)
        ) {
          this.alert('EXIT_FEE_EXCEEDS_CASH');
          continue;
        }
        const fill = SimulatedFillSchema.parse({
          schemaVersion: 'simulated-fill.v1',
          execution: 'SIMULATED',
          id: deterministicId('paper-exit-fill', {
            order: o.order.id,
            evidence: e.providerEventId,
            prior: o.filledQuantity,
          }),
          orderId: o.order.id,
          clientOrderId: o.order.clientOrderId,
          portfolio,
          symbol: e.symbol,
          side: 'SELL',
          quantity: money(quantity),
          price: money(price),
          notional: money(notional),
          fee: money(fee),
          feeCurrency: this.config.quoteCurrency,
          liquidity: 'TAKER',
          priceAvailableAt: e.at,
          orderSubmittedAt: o.order.submittedAt,
          earliestFillAt: e.at,
          filledAt: e.at,
          modelVersion: 'paper-quote-trade.v1',
          evidenceIds: [e.id, e.rawHash],
        });
        validateFillAgainstOrder(fill, o.order, o.filledQuantity);
        const journalIds = [
          this.#ledger.post(
            this.#now,
            'TRADE',
            [
              {
                portfolio,
                asset: instrument.base,
                account: 'FREE',
                amount: money(quantity.neg()) as never,
              },
              {
                portfolio,
                asset: instrument.base,
                account: 'EXTERNAL',
                amount: money(quantity) as never,
              },
            ],
            o.order.id,
            fill.id,
          ),
          this.#ledger.post(
            this.#now,
            'TRADE',
            [
              {
                portfolio,
                asset: this.config.quoteCurrency,
                account: 'FREE',
                amount: money(notional) as never,
              },
              {
                portfolio,
                asset: this.config.quoteCurrency,
                account: 'EXTERNAL',
                amount: money(notional.neg()) as never,
              },
            ],
            o.order.id,
            fill.id,
          ),
          this.#ledger.post(
            this.#now,
            'FEE',
            [
              {
                portfolio,
                asset: this.config.quoteCurrency,
                account: 'FREE',
                amount: money(fee.neg()) as never,
              },
              {
                portfolio,
                asset: this.config.quoteCurrency,
                account: 'FEES',
                amount: money(fee) as never,
              },
            ],
            o.order.id,
            fill.id,
          ),
        ];
        this.#basis.set(basisKey, money(basis.minus(released)));
        this.#realized.set(
          portfolio,
          money(new D(this.#realized.get(portfolio) ?? 0).plus(realized)),
        );
        parent.positionRemaining = money(new D(parent.positionRemaining).minus(quantity)) as never;
        o.filledQuantity = money(new D(o.filledQuantity).plus(quantity)) as never;
        this.#fills.push({
          fill,
          journalIds,
          referencePrice: e.bid,
          slippageCost: money(new D(e.bid).minus(price).mul(quantity)) as never,
          fidelity: 'OBSERVED_TOP_OF_BOOK_MODELED_SLIPPAGE',
          trigger: this.#exitTriggers.get(parent.order.id)!,
          parentOrderId: parent.order.id,
          realizedNetPnl: money(realized) as never,
          costBasisReleased: money(released) as never,
        });
        this.transition(
          o,
          new D(o.filledQuantity).eq(o.order.quantity) ? 'FILLED' : 'PARTIALLY_FILLED',
        );
        capacity = capacity.minus(quantity);
      }
    }
  }
  consume(input: unknown): PaperLog | null {
    const e = PaperEventSchema.parse(input),
      eventHash = canonicalHash(e),
      old = this.#seen.get(e.id);
    if (e.kind === 'HEARTBEAT' && e.observedAt !== undefined && e.observedAt > e.at)
      throw new Error('Future news heartbeat observation');
    if (old) {
      if (old !== eventHash) throw new Error('Conflicting paper event identity');
      return null;
    }
    if (
      e.at < this.#now ||
      e.at < this.config.startAt ||
      e.at > this.config.endAt ||
      this.#log.length >= 200000
    )
      throw new Error('Paper event clock or work budget');
    if (e.kind === 'PROPOSE') verifyDecisionRecord(e.decision);
    if (this.#status === 'STOPPED' && e.kind !== 'TICK') throw new Error('Paper run stopped');
    const previousNow = this.#now;
    this.#now = e.at;
    for (const portfolio of portfolios) {
      const day = this.#daily.get(portfolio)!;
      if (day.day !== e.at.slice(0, 10)) {
        const value = this.valuation(portfolio).equity;
        this.#daily.set(portfolio, {
          day: e.at.slice(0, 10),
          equity: value?.gt(0) ? money(value) : null,
        });
      }
    }
    this.#now = previousNow;
    for (const o of this.#orders
      .filter((o) => active(o) && o.order.expiresAt <= e.at)
      .sort((a, b) => a.order.expiresAt.localeCompare(b.order.expiresAt))) {
      this.#now = o.order.expiresAt;
      this.release(o, 'EXPIRED');
    }
    this.#now = e.at;
    if (this.#status === 'STOPPED' && e.kind !== 'TICK') throw new Error('Paper run stopped');
    if (e.kind === 'HEARTBEAT') {
      const source = this.config.newsSources.find((s) => s.id === e.sourceId);
      if (
        !source ||
        source.licenseReviewHash !== e.licenseReviewHash ||
        source.validUntil <= this.#now
      ) {
        this.#fatal = true;
        this.#status = 'KILLED';
        this.alert('NEWS_SOURCE_VALIDATION_FAILED', e.sourceId);
        for (const o of this.#orders) this.release(o, 'CANCELED');
      } else this.#lastNews.set(e.sourceId, { at: e.observedAt ?? this.#now, healthy: e.healthy });
    } else if (e.kind === 'RECONCILE') {
      if (
        canonicalHash(reconcileSpotJournal(this.#ledger.entries)) !==
        canonicalHash(this.#ledger.balances())
      ) {
        this.#fatal = true;
        this.#status = 'KILLED';
        this.alert('RECONCILIATION_FAILED');
      } else this.alert('DAILY_RECONCILIATION_OK');
    } else if (e.kind === 'QUOTE') this.quote(e);
    else if (e.kind === 'TRADE') this.trade(e);
    else if (e.kind === 'PROPOSE') this.propose(e);
    else if (e.kind === 'CANCEL') {
      const order = this.#orders.find(
        (o) => o.order.id === e.orderId && o.order.portfolio === e.portfolio,
      );
      if (!order) throw new Error('Unknown own-portfolio paper order');
      this.release(order, 'CANCELED');
    } else if (e.kind === 'CONTROL') {
      if (e.action === 'RESUME' && (this.#status === 'KILLED' || this.#fatal))
        throw new Error('Killed paper run requires a new manifest');
      this.#status = (
        { PAUSE: 'PAUSED', RESUME: 'RUNNING', KILL: 'KILLED', STOP: 'STOPPED' } as const
      )[e.action];
      this.alert(`CONTROL_${e.action}`);
      if (e.action !== 'RESUME') for (const o of this.#orders) this.release(o, 'CANCELED');
    } else if (e.kind === 'SAFETY') {
      this.alert(e.code, e.sourceId);
      if (e.code === 'NEWS_OUTAGE') this.#newsHealthy = false;
      else if (e.code === 'NEWS_RESTORED') this.#newsHealthy = true;
      else if (e.code === 'TRADE_OUTAGE') this.#tradeHealthy = false;
      else if (e.code === 'TRADE_RESTORED') this.#tradeHealthy = true;
      else {
        this.#marketHealthy = false;
        for (const o of this.#orders.filter(active)) o.lifecycle = 'UNKNOWN';
      }
      if (
        [
          'LICENSE_CHANGED',
          'INVALID_METADATA',
          'SOURCE_VALIDATION_FAILED',
          'RECONCILIATION_FAILED',
        ].includes(e.code)
      ) {
        this.#fatal = true;
        this.#status = 'KILLED';
        for (const o of this.#orders) this.release(o, 'CANCELED');
      }
    }
    if (this.config.source.validUntil <= e.at && e.at < this.config.endAt) {
      this.#fatal = true;
      this.#marketHealthy = false;
      this.alert('LICENSE_EXPIRED');
    }
    const newsFresh = this.newsFresh();
    if (this.#previousNewsFresh && !newsFresh) this.alert('STALE_OR_FAILED_NEWS');
    this.#previousNewsFresh = newsFresh;
    this.#seen.set(e.id, eventHash);
    this.mark();
    this.assertReservations();
    const stateHash = canonicalHash({
        orders: this.#orders,
        fills: this.#fills,
        balances: this.#ledger.balances(),
        journalHead: this.#ledger.entries.at(-1)!.hash,
        status: this.#status,
        marketHealthy: this.#marketHealthy,
        newsHealthy: this.#newsHealthy,
        tradeHealthy: this.#tradeHealthy,
        fatal: this.#fatal,
        quotes: [...this.#quotes],
        basis: [...this.#basis],
        realized: [...this.#realized],
        daily: [...this.#daily],
        peak: [...this.#peak],
        exitTriggers: [...this.#exitTriggers],
        lastNews: [...this.#lastNews],
      }),
      body = {
        schemaVersion: 'paper-log.v1' as const,
        sequence: this.#log.length + 1,
        event: e,
        previousHash: this.#log.at(-1)?.hash ?? canonicalHash(this.config),
        stateHash,
      },
      entry = { ...body, hash: canonicalHash(body) };
    deepFreeze(entry);
    this.#log.push(entry);
    return entry;
  }
  private assertReservations() {
    for (const portfolio of portfolios) {
      const reserved = this.#orders
        .filter((o) => o.order.portfolio === portfolio)
        .reduce((s, o) => s.plus(o.reservedCash), new D(0));
      if (!reserved.eq(this.#ledger.balance(portfolio, this.config.quoteCurrency).reserved))
        throw new Error('Paper reservation reconciliation');
    }
  }
  report(): PaperReport {
    this.assertReservations();
    if (
      canonicalHash(reconcileSpotJournal(this.#ledger.entries)) !==
      canonicalHash(this.#ledger.balances())
    )
      throw new Error('Paper journal reconciliation');
    const r = PaperReportSchema.parse({
      schemaVersion: 'paper-report.v1',
      execution: 'SIMULATED',
      liveExecution: 'DISABLED',
      config: this.config,
      configHash: canonicalHash(this.config),
      status: this.#status,
      now: this.#now,
      log: this.#log,
      orders: this.#orders,
      fills: this.#fills,
      decisions: this.#decisions,
      journal: this.#ledger.entries,
      balances: this.#ledger.balances(),
      equity: this.#equity,
      alerts: this.#alerts,
      ledgerReconciled: true,
      logHead: this.#log.at(-1)?.hash ?? canonicalHash(this.config),
    });
    deepFreeze(r);
    return r;
  }
}
export function replayPaper(config: unknown, events: unknown[]) {
  const broker = new PaperBroker(config);
  for (const e of events) broker.consume(e);
  return broker.report();
}
// Only a successfully rebuilt, deeply frozen result enters this cache. Caller-frozen
// objects and structurally valid reports still require a full semantic replay.
const verifiedReports = new WeakSet<object>();
export function verifyPaperReport(input: unknown) {
  if (typeof input === 'object' && input !== null && verifiedReports.has(input))
    return input as PaperReport;
  const r = PaperReportSchema.parse(input),
    rebuilt = replayPaper(
      r.config,
      r.log.map((l) => l.event),
    );
  if (canonicalHash(r) !== canonicalHash(rebuilt))
    throw new Error('Paper report semantic integrity');
  verifiedReports.add(rebuilt);
  return rebuilt;
}
