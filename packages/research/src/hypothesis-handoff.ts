import { HypothesisHandoffRequestSchema, HypothesisHandoffSchema } from '@crypto/contracts';
import type { HypothesisCard } from '@crypto/contracts';
import { canonicalHash, deepFreeze } from '@crypto/core';
import { validateHypothesisRegistry } from './hypothesis-artifact.js';
import { hypothesisEvidence } from './hypothesis-registry.js';

/** Select known event features/card versions only; outcomes/evaluations never enter handoff rows. */
export function hypothesisNewsStrategyInputs(artifactInput: unknown, requestInput: unknown) {
  const artifact = validateHypothesisRegistry(artifactInput),
    request = HypothesisHandoffRequestSchema.parse(requestInput);
  if (request.decisionAt > artifact.request.analysisAsOf)
    throw new Error('Handoff exceeds frozen analysis cutoff');
  const evidence = hypothesisEvidence(artifact.input.dataset),
    cards = new Map<string, HypothesisCard>(),
    events: ReturnType<typeof HypothesisHandoffSchema.parse>['events'] = [],
    quarantined: ReturnType<typeof HypothesisHandoffSchema.parse>['quarantined'] = [];
  for (const e of evidence.observations) {
    const o = e.observation;
    if (o.decisionAt > request.decisionAt) continue;
    if (o.kind === 'HISTORICAL_DESCRIPTIVE') {
      if (o.provenance.capturedAt <= request.decisionAt)
        quarantined.push({ observationId: o.id, reason: 'DESCRIPTIVE_ONLY' });
      continue;
    }
    if (
      !e.event?.active ||
      !e.event.replayEligible ||
      e.availableAt === null ||
      e.availableAt > o.decisionAt
    ) {
      quarantined.push({ observationId: o.id, reason: 'UNAVAILABLE_AT_DECISION' });
      continue;
    }
    if (e.firstSeenQuality !== 'OBSERVED' && e.firstSeenQuality !== 'ARCHIVED_CAPTURE') {
      quarantined.push({ observationId: o.id, reason: 'QUALITY_EXCLUDED' });
      continue;
    }
    const heads = [
        ...new Map(
          artifact.input.cards
            .filter((c) => c.recordedAt <= o.decisionAt)
            .map((c) => [c.content.id, c]),
        ).values(),
      ],
      matching = heads.filter(
        (c) =>
          c.content.status === 'REGISTERED' &&
          c.content.claimType === 'ASSOCIATION' &&
          e.taxonomy.some((t) => c.content.eventGroup.includes(t)) &&
          c.content.eligibility.firstSeenQualities.some((q) => q === e.firstSeenQuality) &&
          (c.content.eligibility.allowUnverified ||
            ['CORROBORATED', 'OFFICIALLY_STATED'].includes(e.event.status)),
      );
    if (!matching.length) continue;
    for (const card of matching) cards.set(card.hash, card);
    events.push({
      observationId: o.id,
      observationDecisionAt: o.decisionAt,
      cardHashes: matching.map((c) => c.hash),
      eventContextHash: e.contextHash,
      event: e.event,
      firstSeenQuality: e.firstSeenQuality,
      sourceIds: e.sourceIds,
    });
  }
  const result = HypothesisHandoffSchema.parse({
    schemaVersion: 'hypothesis-news-strategy-inputs.v1',
    execution: 'DISABLED',
    defaultAction: 'HOLD',
    purpose: request.purpose,
    registryHash: canonicalHash(artifact),
    decisionAt: request.decisionAt,
    cards: [...cards.values()],
    events,
    quarantined,
  });
  deepFreeze(result);
  return result;
}
export function validateHypothesisHandoff(registry: unknown, input: unknown) {
  const handoff = HypothesisHandoffSchema.parse(input),
    expected = hypothesisNewsStrategyInputs(registry, {
      decisionAt: handoff.decisionAt,
      purpose: handoff.purpose,
    });
  if (canonicalHash(handoff) !== canonicalHash(expected))
    throw new Error('Hypothesis handoff integrity mismatch');
  return expected;
}
