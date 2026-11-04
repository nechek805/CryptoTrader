import { RiskRequestSchema } from '@crypto/contracts';
import { defaultRiskConfig } from '@crypto/risk';
import { createDomainFixtures } from './domain.js';

export function riskFixture() {
  const candidate = {
    ...createDomainFixtures().signalCandidate,
    side: 'LONG',
    portfolio: 'NEWS_ONLY',
  };
  const request = RiskRequestSchema.parse({
    schemaVersion: 'risk-request.v1',
    candidate,
    at: candidate.decisionAt,
    account: {
      portfolio: 'NEWS_ONLY',
      asOf: candidate.decisionAt,
      day: '2026-01-01',
      equity: '10000',
      cash: '10000',
      dayStartEquity: '10000',
      currency: 'USDT',
      positions: [],
      lastEntryAt: null,
    },
    market: {
      symbol: 'BTC/USDT',
      availableAt: candidate.decisionAt,
      observedAt: candidate.decisionAt,
      entryPrice: '100',
      spreadBps: '5',
      liquidityNotional: '1000000',
      quantityStep: '0.001',
      minimumQuantity: '0.001',
      evidenceIds: ['synthetic:risk:quote'],
      eligibility: 'ELIGIBLE',
    },
    positionPolicy: { stopPrice: '95', targetPrice: '110' },
    uncertaintyDiscount: '1',
    overrides: [
      {
        id: 'synthetic:clear',
        actor: 'synthetic:operator',
        action: 'CLEAR_KILL_SWITCH',
        reason: 'Synthetic test only',
        at: candidate.decisionAt,
      },
    ],
  });
  const config = defaultRiskConfig();
  config.killSwitch = false;
  return { config, request };
}
