import {
  MarketBarSchema,
  SpotSimulationInputSchema,
  SpotSimulationRequestSchema,
  SpotCommandSchema,
} from '@crypto/contracts';
import { canonicalHash, fromEpoch } from '@crypto/core';
import { crossFeatureFixture } from '@crypto/research';

/** Fictional manual authorizations and prices for accounting tests, not a trading strategy. */
export function spotSimulationFixture() {
  const at = (s: number) => fromEpoch(1767225600n + BigInt(s), 'seconds'),
    base = crossFeatureFixture(),
    request = SpotSimulationRequestSchema.parse({
      schemaVersion: 'spot-simulation-request.v1',
      sourceId: 'synthetic:cross',
      venue: 'synthetic-cross',
      instrumentKeys: ['cross:SPOT:BTC'],
      portfolios: ['BASELINE'],
      initialBalances: [
        { asset: 'USDT', amount: '1000' },
        { asset: 'BTC', amount: '0' },
      ],
      quoteCurrency: 'USDT',
      startAt: at(0),
      endAt: at(300),
      generatedAt: at(360),
      intervalSeconds: 60,
      latencyMs: 0,
      maxBarDelayMs: 30000,
      makerRate: '0.0005',
      takerRate: '0.001',
      spreadBps: '0',
      slippageBps: '0',
      quoteScale: 8,
      participationFraction: '0.1',
      randomSeed: 42,
      marketType: 'SPOT',
      derivatives: 'DISABLED',
      leverage: '1',
      allowShort: false,
      fillPolicy: 'FULL_WINDOW_ADVERSE_MARKET_STRICT_LIMIT_V1',
      ambiguityPolicy: 'STOP_FIRST_ADVERSE',
      partialPolicy: 'SHARED_VOLUME_CAP',
    }),
    bars = base.input.technical.bars
      .filter((b) => b.instrumentId === 'BTC/USDT' && b.marketType === 'SPOT')
      .slice(0, 4)
      .map((b, i) => {
        const price = i === 2 ? '110' : '100';
        return MarketBarSchema.parse({
          ...b,
          id: `synthetic:spot:bar:${i + 1}`,
          open: price,
          high: price,
          low: price,
          close: price,
        });
      }),
    commands = [
      { id: 'synthetic:buy', client: 'synthetic:buy:1', side: 'BUY', at: 0 },
      { id: 'synthetic:sell', client: 'synthetic:sell:1', side: 'SELL', at: 61 },
    ].map((c, index) => {
      const candidate = {
          schemaVersion: 'signal-candidate.v1',
          id: `${c.id}:candidate`,
          strategyId: 'synthetic:manual-scenario',
          version: '1',
          portfolio: 'BASELINE',
          symbol: 'BTC/USDT',
          decisionAt: at(c.at),
          dataCutoff: at(c.at),
          horizon: { value: 10, unit: 'minutes' },
          side: c.side === 'BUY' ? 'LONG' : 'SHORT',
          score: { status: 'MISSING', reason: 'Synthetic accounting scenario, no prediction' },
          calibration: { status: 'MISSING', reason: 'No model' },
          rationaleIds: ['synthetic:manual-authorization'],
          validUntil: at(600),
          reproducibility: {
            datasetHashes: [canonicalHash('synthetic:manual-scenario.v1')],
            configHash: canonicalHash(request),
            codeVersion: 'synthetic:manual-scenario.v1',
            modelVersion: 'synthetic:manual-scenario.v1',
            randomSeed: 42,
            randomAlgorithm: 'mulberry32.v1',
            clockSemantics: 'utc-nanoseconds.v1',
            generatedAt: at(c.at),
            feeAssumptionsHash: canonicalHash({
              maker: request.makerRate,
              taker: request.takerRate,
            }),
          },
        },
        risk = {
          schemaVersion: 'risk-decision.v1',
          id: `${c.id}:risk`,
          candidateId: candidate.id,
          portfolio: 'BASELINE',
          decisionAt: at(c.at),
          allowed: true,
          ruleIds: ['synthetic:manual-spot-risk-permit'],
          sizing: { quantity: '1', maxNotional: '500', currency: 'USDT' },
          expiresAt: at(600),
          stopTargetPolicy: { kind: 'NONE' },
          audit: {
            inputHash: canonicalHash(candidate),
            configHash: canonicalHash(request),
            codeVersion: 'synthetic:manual-authorization.v1',
            reasons: ['Synthetic explicit risk permit for ledger tests only'],
          },
        },
        intent = {
          clientOrderId: c.client,
          portfolio: 'BASELINE',
          instrumentKey: 'cross:SPOT:BTC',
          side: c.side,
          orderType: 'MARKET',
          quantity: '1',
          limitPrice: null,
          marketPriceBound: '100',
          allowPartial: true,
          expiresAt: at(290),
          protection: null,
        };
      return SpotCommandSchema.parse({
        kind: 'SUBMIT',
        id: c.id,
        sequence: index + 1,
        at: at(c.at),
        intent,
        candidate,
        risk,
      });
    }),
    input = SpotSimulationInputSchema.parse({
      schemaVersion: 'spot-simulation-input.v1',
      market: base.input.market,
      bars,
      commands,
    });
  return { input, request };
}
