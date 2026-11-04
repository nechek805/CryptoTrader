import { Decimal } from 'decimal.js';
import {
  EvaluationPlanSchema,
  PaperConfigSchema,
  PaperEventSchema,
  PaperReportSchema,
  SensitivityResultSchema,
} from '@crypto/contracts';
import type { EvaluationPlan, PaperReport } from '@crypto/contracts';
import { canonicalHash } from '@crypto/core';
import { PaperBroker } from '@crypto/paper';
import { makeDecisionRecord } from '@crypto/risk';
import { measurePaper } from './paper-metrics.js';
const D = Decimal.clone({ precision: 256 });
/** Reprice execution/risk against the same frozen candidates and source clock; never refit signals. */
export function evaluationSensitivity(paper: PaperReport, plan: EvaluationPlan) {
  paper = PaperReportSchema.parse(paper);
  plan = EvaluationPlanSchema.parse(plan);
  const basePolicy = paper.decisions[0]?.policy;
  return plan.scenarios.map((scenario) => {
    if (new D(scenario.feeMultiplier).lt(1) || new D(scenario.slippageMultiplier).lt(1))
      throw new Error('Stress cannot secretly lower costs');
    const makerRate = new D(paper.config.makerRate).mul(scenario.feeMultiplier).toFixed(),
      takerRate = new D(paper.config.takerRate).mul(scenario.feeMultiplier).toFixed(),
      policy = basePolicy
        ? {
            ...basePolicy,
            risk: {
              ...basePolicy.risk,
              feeRate: D.max(basePolicy.risk.feeRate, makerRate, takerRate).toFixed(),
            },
          }
        : null,
      config = PaperConfigSchema.parse({
        ...paper.config,
        riskPolicyHash: policy ? canonicalHash(policy) : paper.config.riskPolicyHash,
        makerRate,
        takerRate,
        slippageBps: new D(paper.config.slippageBps).mul(scenario.slippageMultiplier).toFixed(),
        latencyMs: paper.config.latencyMs + scenario.addedLatencyMs,
        runManifestHash: canonicalHash({ base: paper.config.runManifestHash, stress: scenario }),
      }),
      broker = new PaperBroker(config);
    for (const { event } of paper.log) {
      if (event.kind !== 'PROPOSE') {
        broker.consume(event);
        continue;
      }
      if (!policy) throw new Error('Missing sensitivity risk policy');
      broker.consume(
        PaperEventSchema.parse({ kind: 'TICK', id: `stress:clock:${event.id}`, at: event.at }),
      );
      const old = event.decision.request,
        q = broker.quoteAt(old.risk.candidate.symbol),
        evidence = old.evidence.filter((e) => !q || e.id !== q.id),
        market = q
          ? {
              ...old.risk.market,
              availableAt: q.at,
              observedAt: q.observedAt,
              evidenceIds: [q.id],
              spreadBps: new D(q.ask)
                .minus(q.bid)
                .div(q.bid)
                .mul(10000)
                .toDecimalPlaces(12, Decimal.ROUND_CEIL)
                .toFixed(),
              liquidityNotional: D.min(
                new D(q.bid).mul(q.bidQuantity),
                new D(q.ask).mul(q.askQuantity),
              ).toFixed(),
            }
          : old.risk.market;
      if (q)
        evidence.push({
          id: q.id,
          contentHash: canonicalHash(q),
          availableAt: q.at,
          researchUse: 'ELIGIBLE',
          availabilityBasis: 'OBSERVED',
          origin: config.origin === 'SYNTHETIC' ? 'SYNTHETIC' : 'RESEARCH',
        });
      const request = {
          ...old,
          evidence,
          runManifestHash: config.runManifestHash,
          risk: {
            ...old.risk,
            at: event.at,
            account: broker.account(old.risk.candidate.portfolio),
            market,
          },
        },
        decision = makeDecisionRecord(policy, request, config.codeVersion);
      broker.consume({ ...event, decision });
    }
    const stressed = broker.report(),
      candidates = stressed.decisions.map((d) => d.request.risk.candidate),
      candidateSidesHash = canonicalHash(candidates);
    if (candidateSidesHash !== canonicalHash(paper.decisions.map((d) => d.request.risk.candidate)))
      throw new Error('Sensitivity altered producer candidates');
    return SensitivityResultSchema.parse({
      id: scenario.id,
      configHash: canonicalHash(config),
      candidateSidesHash,
      metrics: measurePaper(
        stressed,
        plan.opportunityGrid.filter((g) => g.at <= paper.now),
      ),
      warnings: [
        'COUNTERFACTUAL_EXECUTION_AND_RISK_REPLAY_NO_SIGNAL_REFIT',
        'Higher costs may veto orders; paths can differ',
      ],
    });
  });
}
