import { expect, it } from 'vitest';
import { PaperEventSchema } from '@crypto/contracts';
import { makeDecisionRecord } from '@crypto/risk';
import { PaperBroker, syntheticPaperQuote, syntheticPaperProposal } from '@crypto/paper';
import {
  freezeExperiment,
  experimentProtocolFixture,
  experimentPaperConfig,
  trialFixtureAt,
  assessExperiment,
} from '@crypto/evaluation';

it('stops for an adverse-gap daily loss breach even below the broad drawdown threshold', () => {
  const manifest = freezeExperiment(experimentProtocolFixture()),
    b = new PaperBroker(experimentPaperConfig(manifest)),
    quote = (s: number, bid: string, ask: string) => {
      const e = syntheticPaperQuote(s, bid, ask);
      if (e.kind !== 'QUOTE') throw new Error('Quote fixture');
      return PaperEventSchema.parse({ ...e, metadataHash: b.config.instruments[0]!.metadataHash });
    };
  b.consume(quote(60, '101', '101.05'));
  b.consume({
    kind: 'HEARTBEAT',
    id: 'synthetic:gap-news-heartbeat',
    at: trialFixtureAt(60),
    sourceId: b.config.newsSources[0]!.id,
    licenseReviewHash: b.config.newsSources[0]!.licenseReviewHash,
    healthy: true,
  });
  b.consume({ kind: 'TICK', id: 'synthetic:gap-decision-clock', at: trialFixtureAt(61) });
  const proposal = syntheticPaperProposal(b, 'NEWS_ONLY', 61);
  if (proposal.kind !== 'PROPOSE') throw new Error('Proposal fixture');
  const request = proposal.decision.request;
  proposal.decision = makeDecisionRecord(
    manifest.protocol.riskPolicy,
    {
      ...request,
      risk: {
        ...request.risk,
        market: { ...request.risk.market, entryPrice: '102' },
        positionPolicy: { stopPrice: '100.99', targetPrice: '110' },
      },
    },
    b.config.codeVersion,
  );
  b.consume(proposal);
  b.consume(quote(62, '101', '101.05'));
  b.consume(quote(120, '10', '10.01'));
  b.consume(quote(121, '9.99', '10'));
  const a = assessExperiment({
    schemaVersion: 'trial-run.v1',
    manifest,
    paper: b.report(),
    annotations: [],
    wallClockStartedAt: null,
    wallClockFinishedAt: null,
  });
  expect(a.recommendation).toBe('STOP');
  expect(a.reasons).toContain('HARD_SIMULATED_RISK_BREACH_STOP_AND_INVESTIGATE');
  expect(
    Number(a.evaluation.metrics.find((v) => v.portfolio === 'NEWS_ONLY')!.observedMaxDrawdown),
  ).toBeLessThan(0.1);
});
