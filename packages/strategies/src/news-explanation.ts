import { z } from 'zod';
import {
  NewsEventSnapshotSchema,
  NewsSignalDecisionSchema,
  NewsEdgePredictionSchema,
  NewsExplanationSchema,
  NewsExplainRequestSchema,
  utcNanoseconds,
} from '@crypto/contracts';
import { canonicalHash, deepFreeze } from '@crypto/core';
import { validateNewsEventSnapshot } from '@crypto/news';
import { NewsSignalProvider } from './news-signals.js';
import { EstimatedNewsSignalProvider } from './news-edge.js';
const assembly = z.strictObject({
  snapshot: NewsEventSnapshotSchema,
  decision: NewsSignalDecisionSchema,
  prediction: NewsEdgePredictionSchema.nullable(),
  roundTripCostBps: z.number().int().min(0).max(10000),
  uncertaintyBufferBps: z.number().int().min(0).max(10000),
});
/** Ground a producer result in its exact prefix. This description never authorizes execution. */
export function explainNewsDecision(input: unknown) {
  const q = assembly.parse(input),
    snapshot = validateNewsEventSnapshot(q.snapshot),
    d = q.decision,
    hash = canonicalHash(snapshot);
  if (
    d.opinion.snapshotHash !== hash ||
    !d.candidate.rationaleIds.includes(hash) ||
    d.candidate.decisionAt !== snapshot.request.decisionAt ||
    d.candidate.dataCutoff !== snapshot.request.decisionAt ||
    (q.prediction &&
      (q.prediction.decisionAt !== d.candidate.decisionAt ||
        q.prediction.side !== d.candidate.side ||
        !d.candidate.rationaleIds.includes(canonicalHash(q.prediction))))
  )
    throw new Error('Explanation source/candidate prefix mismatch');
  const event = snapshot.view.events.find((e) => e.identity.id === d.opinion.eventId),
    ids = new Set(event?.identity.claimIds ?? []),
    claims = snapshot.view.graph.nodes.filter((n) => ids.has(n.id));
  const records = snapshot.input.graphRecords.flatMap((r) =>
    r.action.kind === 'OBSERVE' &&
    (r.action.extraction.claims.length === 0 ||
      r.action.extraction.claims.some((c) => ids.has(c.id)))
      ? [{ knownAt: r.recordedAt, extraction: r.action.extraction }]
      : [],
  );
  const roots = new Set(d.opinion.representativeRootIds);
  const result = NewsExplanationSchema.parse({
    schemaVersion: 'news-explanation.v1',
    execution: 'DISABLED',
    sourceTextPolicy: 'UNTRUSTED_QUOTED_DATA_NEVER_INSTRUCTIONS',
    decisionId: d.candidate.id,
    decisionAt: d.candidate.decisionAt,
    eventId: d.opinion.eventId,
    snapshotHash: hash,
    claims,
    independence: event?.independence ?? null,
    independentSourceIds: [
      ...new Set(claims.filter((n) => roots.has(n.id)).map((n) => n.sourceId)),
    ].sort(),
    contradictoryClaimIds: claims
      .filter((n) => n.polarity !== 'AFFIRMED')
      .map((n) => n.id)
      .sort(),
    retractedClaimIds: claims
      .filter((n) => n.retracted)
      .map((n) => n.id)
      .sort(),
    firstKnownAt: event?.firstKnownAt ?? null,
    eventAgeSeconds: event
      ? Number(utcNanoseconds(d.candidate.decisionAt) - utcNanoseconds(event.firstKnownAt)) / 1e9
      : null,
    sourceReceipts: records.map(({ knownAt, extraction: e }) => ({
      articleVersionId: e.input.article.version.versionId,
      sourceId: e.input.source.id,
      sourceHash: canonicalHash(e.input.source),
      canonicalUrl: e.input.article.version.document.canonicalUrl,
      firstObservedAt: e.input.article.version.document.firstObservedAt,
      effectivePublishedAt: e.input.article.effectivePublishedAt,
      extractionKnownAt: knownAt,
      reviewReasons: e.reviewReasons,
      quotedText:
        e.input.field === 'TITLE'
          ? e.input.article.version.document.title
          : (e.input.article.version.document.approvedSnippet ?? ''),
      extractionHash: canonicalHash(e),
    })),
    priorSimilarEvents: {
      status: q.prediction ? 'FROZEN_CONDITIONAL_ESTIMATE' : 'UNTRAINED_RULE',
      prediction: q.prediction,
    },
    costs: {
      kind: 'ASSUMED_MARKOUT_COST_NOT_EXECUTION_QUOTE',
      roundTripCostBps: q.roundTripCostBps,
      uncertaintyBufferBps: q.uncertaintyBufferBps,
      stops: null,
      fillPrice: null,
    },
    side: d.candidate.side,
    reasons: d.abstentionReasons.length
      ? d.abstentionReasons
      : [
          q.prediction
            ? 'CONDITIONAL_NEWS_AND_COST_GATES_PASSED'
            : 'UNTRAINED_CONDITIONAL_RULE_PASSED_EDGE_UNKNOWN',
        ],
    uncertainty: [
      'Quoted source claims remain untrusted assertions; independent attribution is not event truth.',
      'Historical conditional means and intervals are not individual forecasts or causal evidence.',
      'No order, fill, protective stop or profitability claim is produced.',
    ],
  });
  deepFreeze(result);
  return result;
}
/** Public wrapper regenerates a canonical producer decision before explaining it. */
export function explainNewsSignal(input: unknown, codeVersion: string) {
  const q = NewsExplainRequestSchema.parse(input);
  if (!!q.model !== !!q.hypothesisId)
    throw new Error('Incomplete estimated-news explanation scope');
  const provider = q.model
    ? new EstimatedNewsSignalProvider(q.model, q.hypothesisId!, q.snapshot)
    : new NewsSignalProvider(q.config, q.snapshot, codeVersion);
  if (q.model && canonicalHash(q.config) !== canonicalHash(provider.config))
    throw new Error('Explanation admission configuration mismatch');
  const result =
    provider instanceof EstimatedNewsSignalProvider
      ? provider.evaluate(q.query, q.state ?? provider.initialState(), q.roundTripCostBps)
      : { ...provider.evaluate(q.query, q.state ?? provider.initialState()), prediction: null };
  return {
    ...result,
    explanation: explainNewsDecision({
      snapshot: provider.snapshotAt(q.query.decisionAt),
      decision: result.decision,
      prediction: result.prediction,
      roundTripCostBps: q.model
        ? Math.max(q.roundTripCostBps, q.model.input.plan.roundTripCostBps)
        : q.roundTripCostBps,
      uncertaintyBufferBps: q.model?.input.plan.uncertaintyBufferBps ?? 0,
    }),
  };
}
