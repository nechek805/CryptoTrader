import {
  DecisionPolicySchema,
  PaperConfigSchema,
  PaperEventSchema,
  RiskRequestSchema,
  SignalCandidateSchema,
} from '@crypto/contracts';
import type { PaperBroker as Broker } from './broker.js';
import type { PaperEvent } from '@crypto/contracts';
import { canonicalHash, deterministicId, fromEpoch } from '@crypto/core';
import { defaultRiskConfig, makeDecisionRecord } from '@crypto/risk';
import { PaperBroker } from './broker.js';

const at = (seconds: number) => fromEpoch(1767225600n + BigInt(seconds), 'seconds');
export function paperFixtureConfig(codeVersion = 'synthetic:paper-fixture.v1') {
  const risk = defaultRiskConfig();
  risk.killSwitch = false;
  const policy = DecisionPolicySchema.parse({
      schemaVersion: 'decision-policy.v1',
      risk,
      allowedRegimes: ['TREND', 'RANGE'],
      uncalibratedDiscount: '0.5',
    }),
    config = PaperConfigSchema.parse({
      schemaVersion: 'paper-config.v1',
      runManifestHash: canonicalHash({ origin: 'SYNTHETIC', experiment: 'paper-fixture.v1' }),
      riskPolicyHash: canonicalHash(policy),
      codeVersion,
      origin: 'SYNTHETIC',
      startAt: at(0),
      endAt: at(86400),
      initialCash: '10000',
      quoteCurrency: 'USDT',
      instruments: [
        {
          symbol: 'BTC/USDT',
          base: 'BTC',
          quantityStep: '0.001',
          minimumQuantity: '0.001',
          tickSize: '0.01',
          metadataHash: canonicalHash({ origin: 'SYNTHETIC', instrument: 'BTC/USDT' }),
          availableAt: at(0),
          validUntil: at(2678400),
        },
      ],
      source: {
        id: 'synthetic:paper-feed',
        adapterVersion: 'synthetic-paper-feed.v1',
        licenseReviewHash: canonicalHash({ origin: 'SYNTHETIC', permission: 'locally-authored' }),
        reviewedAt: at(0),
        validUntil: at(2678400),
        approved: true,
      },
      latencyMs: 100,
      maxQuoteAgeSeconds: 120,
      maxClockSkewSeconds: 2,
      makerRate: '0.0005',
      takerRate: '0.001',
      slippageBps: '5',
      participation: '0.25',
      queueAheadQuantity: '1',
    });
  return { config, policy };
}
export function syntheticPaperQuote(
  seconds: number,
  bid = '99.99',
  ask = '100',
  quantity = '10000',
) {
  const { config } = paperFixtureConfig();
  return PaperEventSchema.parse({
    id: `synthetic:quote:${seconds}`,
    kind: 'QUOTE',
    at: at(seconds),
    observedAt: at(seconds),
    providerAt: at(seconds),
    providerEventAt: at(seconds),
    sourceId: config.source.id,
    providerEventId: `synthetic:book:${seconds}`,
    symbol: 'BTC/USDT',
    bid,
    ask,
    bidQuantity: quantity,
    askQuantity: quantity,
    metadataHash: config.instruments[0]!.metadataHash,
    rawHash: canonicalHash({ origin: 'SYNTHETIC', seconds, bid, ask, quantity }),
  });
}
export function syntheticPaperProposal(
  broker: Broker,
  portfolio: 'BASELINE' | 'NEWS_ONLY' | 'MARKET_ONLY' | 'FUSION',
  seconds = 61,
  orderType: 'MARKET' | 'LIMIT' = 'MARKET',
) {
  const { policy } = paperFixtureConfig(),
    q = broker.quoteAt('BTC/USDT');
  if (!q) throw new Error('Synthetic proposal needs an actually available quote');
  const body = {
      schemaVersion: 'signal-candidate.v1',
      strategyId: `synthetic:${portfolio}`,
      version: '1',
      portfolio,
      symbol: q.symbol,
      decisionAt: at(seconds),
      dataCutoff: q.at,
      horizon: { value: 1, unit: 'hours' },
      side: portfolio === 'BASELINE' ? 'HOLD' : 'LONG',
      score: { status: 'MISSING', reason: 'Synthetic accounting scenario' },
      calibration: { status: 'MISSING', reason: 'No predictive calibration' },
      rationaleIds: ['synthetic:claim'],
      validUntil: at(seconds + 300),
      reproducibility: {
        datasetHashes: [canonicalHash('synthetic:paper-input')],
        configHash: canonicalHash(policy),
        codeVersion: broker.config.codeVersion,
        modelVersion: 'synthetic-rule.v1',
        randomSeed: 42,
        randomAlgorithm: 'mulberry32.v1',
        clockSemantics: 'utc-nanoseconds.v1',
        generatedAt: at(seconds),
        feeAssumptionsHash: canonicalHash({
          maker: broker.config.makerRate,
          taker: broker.config.takerRate,
        }),
      },
    },
    candidate = SignalCandidateSchema.parse({
      ...body,
      id: deterministicId('synthetic-paper-signal', body),
    }),
    risk = RiskRequestSchema.parse({
      schemaVersion: 'risk-request.v1',
      candidate,
      at: at(seconds),
      account: broker.account(portfolio),
      market: {
        symbol: q.symbol,
        availableAt: q.at,
        observedAt: q.observedAt,
        entryPrice: '101',
        spreadBps: '2',
        liquidityNotional: '990000',
        quantityStep: '0.001',
        minimumQuantity: '0.001',
        evidenceIds: [q.id],
        eligibility: 'ELIGIBLE',
      },
      positionPolicy: { stopPrice: '95', targetPrice: '110' },
      overrides: [
        {
          id: 'synthetic:operator-clear',
          actor: 'synthetic:operator',
          reason: 'Synthetic fixture run only',
          at: at(seconds),
          action: 'CLEAR_KILL_SWITCH',
        },
      ],
      uncertaintyDiscount: '1',
    }),
    evidence = ['synthetic:claim', 'synthetic:regime', q.id].map((id) => ({
      id,
      contentHash: id === q.id ? canonicalHash(q) : canonicalHash({ origin: 'SYNTHETIC', id }),
      availableAt: q.at,
      availabilityBasis: 'OBSERVED',
      researchUse: 'ELIGIBLE',
      origin: 'SYNTHETIC',
    })),
    decision = makeDecisionRecord(
      policy,
      {
        schemaVersion: 'decision-request.v1',
        risk,
        runManifestHash: broker.config.runManifestHash,
        sourceSnapshotHash: canonicalHash(q),
        evidence,
        regime: { id: 'synthetic:regime', kind: 'TREND', availableAt: q.at },
        calibration: null,
        previousHash: canonicalHash({ origin: 'SYNTHETIC', portfolio, decisionChain: 'genesis' }),
      },
      broker.config.codeVersion,
    );
  return PaperEventSchema.parse({
    id: `synthetic:proposal:${portfolio}:${seconds}`,
    kind: 'PROPOSE',
    at: at(seconds),
    decision,
    orderType,
    limitPrice: orderType === 'LIMIT' ? '100' : null,
  });
}
/** Fictional market and independent virtual accounting, not observed performance. */
export function paperFixture(codeVersion = 'synthetic:paper-fixture.v1') {
  const { config } = paperFixtureConfig(codeVersion),
    broker = new PaperBroker(config),
    events: PaperEvent[] = [];
  const push = (input: unknown) => {
    const e = PaperEventSchema.parse(input);
    broker.consume(e);
    events.push(e);
  };
  push(syntheticPaperQuote(60));
  push({ id: 'synthetic:clock:61', kind: 'TICK', at: at(61) });
  for (const portfolio of ['BASELINE', 'NEWS_ONLY', 'MARKET_ONLY', 'FUSION'] as const)
    push(syntheticPaperProposal(broker, portfolio));
  push(syntheticPaperQuote(62, '99.99', '100', '0.4'));
  push(syntheticPaperQuote(63));
  return { config, events };
}
