import { NewsAuditInputSchema, NewsSignalManifestSchema } from '@crypto/contracts';
import { canonicalHash, utc } from '@crypto/core';
import { trainNewsEdge } from '@crypto/strategies';
import { newsSignalFixture, newsSignalScenarioFixture } from './news-signal-fixture.js';
import { newsEdgeEvaluationFixture } from './news-edge-fixture.js';
/** All roles, text, times, prices and predeclaration assertions are fictional. */
export async function newsAuditFixture(codeVersion: string) {
  const rules = await newsSignalFixture();
  rules.cases = rules.cases.filter((c) => c.id !== 'synthetic:LISTING');
  for (const kind of ['INJECTION', 'ALTERED_TIMESTAMP', 'CONTRADICTED'] as const)
    rules.cases.push(await newsSignalScenarioFixture(kind));
  const f = await newsEdgeEvaluationFixture(),
    model = trainNewsEdge(f.input, codeVersion);
  const requests = f.queries.map((request) => {
    const observation = f.input.dataset.observations.find(
      (o) => o.eventId === request.query.eventId && o.decisionAt === request.query.decisionAt,
    );
    if (!observation) throw new Error('Synthetic held-out observation missing');
    return { observationId: observation.id, request };
  });
  if (new Set(requests.map((r) => r.observationId)).size !== 12)
    throw new Error('Synthetic TEST cohort mismatch');
  const input = NewsAuditInputSchema.parse({
    schemaVersion: 'news-audit-input.v1',
    rules: NewsSignalManifestSchema.parse(rules),
    model,
    evaluation: {
      dataset: f.input.dataset,
      requests,
      plan: {
        schemaVersion: 'news-evaluation-plan.v1',
        declaredAt: utc('2026-01-26T00:05:00Z'),
        from: utc('2026-01-28T00:00:00Z'),
        to: utc('2026-02-10T00:00:00Z'),
        generatedAt: utc('2026-02-10T00:00:00Z'),
        horizonSeconds: 300,
        roundTripCostBps: 10,
        opportunityIds: requests.map((r) => r.observationId),
        baseline: 'CASH_AND_ALWAYS_LONG_ON_SAME_GRID',
        minimumUnits: 3,
        bootstrapSamples: 1000,
        seed: 42,
      },
    },
  });
  if (canonicalHash(model.input.plan) !== canonicalHash(input.model.input.plan))
    throw new Error('Frozen policy changed');
  return { ...input, model };
}
