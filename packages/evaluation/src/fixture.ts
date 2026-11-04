import { EvaluationPlanSchema } from '@crypto/contracts';
import { canonicalHash } from '@crypto/core';
import { paperSoakFixture, paperFixture, syntheticPaperQuote, replayPaper } from '@crypto/paper';
export function evaluationFixturePlan() {
  return EvaluationPlanSchema.parse({
    schemaVersion: 'evaluation-plan.v1',
    frozenAt: '2025-12-31T00:00:00Z',
    generatedAt: '2026-01-03T00:00:00Z',
    randomSeed: 42,
    phase: 'FORWARD',
    trialRegistryHash: canonicalHash('synthetic:trial-registry'),
    experimentCount: 1,
    hyperparameterTrials: 1,
    familySize: 3,
    opportunityGrid: [{ at: '2026-01-01T00:01:01Z', symbol: 'BTC/USDT' }],
    blockDays: 3,
    overlapHorizonDays: 1,
    minimumBlocks: 8,
    minimumClosedTrades: 30,
    resamples: 999,
    alpha: 0.05,
    maximumTailContribution: '0.5',
    minimumCoverage: '0.95',
    maximumDrawdown: '0.1',
    minimumPairedDailyImprovement: '0',
    scenarios: [
      { id: 'FEES_2X', feeMultiplier: '2', slippageMultiplier: '1', addedLatencyMs: 0 },
      { id: 'IMPACT_2X', feeMultiplier: '1', slippageMultiplier: '2', addedLatencyMs: 0 },
      { id: 'ENTRY_LAG', feeMultiplier: '1', slippageMultiplier: '1', addedLatencyMs: 59000 },
    ],
  });
}
export function evaluationFixture() {
  const f = paperSoakFixture();
  return { paper: replayPaper(f.config, f.events), plan: evaluationFixturePlan() };
}
/** Deliberately misleading profitable toy: one dramatic tail event and no independent evidence. */
export function misleadingProfitableFixture() {
  const f = paperFixture(),
    events = [
      ...f.events,
      syntheticPaperQuote(70, '200', '200.01'),
      syntheticPaperQuote(71, '230', '230.01'),
      {
        kind: 'CONTROL',
        id: 'synthetic:misleading-end',
        at: f.config.endAt,
        action: 'STOP',
        actor: 'synthetic:operator',
        reason: 'End of toy period',
      },
    ];
  return { paper: replayPaper(f.config, events), plan: evaluationFixturePlan() };
}
