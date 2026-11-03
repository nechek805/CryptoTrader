import {
  NewsEventConfigSchema,
  NewsEventViewSchema,
  UtcTimestampSchema,
  utcNanoseconds,
} from '@crypto/contracts';
import type {
  NewsEventIdentity,
  NewsEventRecord,
  NewsGraphRecord,
  NewsGraphNode,
  NewsGraphViewSchema,
} from '@crypto/contracts';
import { canonicalHash, canonicalJson, deterministicId } from '@crypto/core';
import { projectNewsGraph, evidenceIndependenceScore } from './graph-projection.js';

type Graph = ReturnType<typeof NewsGraphViewSchema.parse>;
export const newsEventGenesis = canonicalHash({ schemaVersion: 'news-event-chain.v1' });
export function defaultNewsEventConfig() {
  return NewsEventConfigSchema.parse({
    schemaVersion: 'news-event-config.v1',
    algorithmVersion: 'news-temporal-events.v1',
    noveltyWindowHours: 24,
  });
}
const max = (...v: string[]) => UtcTimestampSchema.parse(v.sort().at(-1));
const normal = (s: string) => s.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
const decimal = (s: string) =>
  s
    .replace(/(\.\d*?)0+$/, '$1')
    .replace(/\.$/, '')
    .replace(/^-0$/, '0');
export function newsEventIdentities(graph: Graph, records: readonly NewsEventRecord[]) {
  const definitions = new Map<
    string,
    { identity: NewsEventIdentity; active: boolean; supersededBy: string[] }
  >();
  for (const c of graph.clusters)
    definitions.set(c.id, {
      identity: {
        id: c.id,
        kind: 'BASE',
        label: graph.nodes.find((n) => n.clusterId === c.id)?.anchorKey ?? 'provisional',
        claimIds: [...c.claimIds].sort(),
        baseClusterIds: [c.id],
        parentIds: [],
        createdAt: c.firstKnownAt,
      },
      active: true,
      supersededBy: [],
    });
  for (const record of records) {
    for (const parent of record.resolution.parents) {
      if (!definitions.has(parent.id))
        definitions.set(parent.id, { identity: parent, active: true, supersededBy: [] });
      const old = definitions.get(parent.id)!;
      old.active = false;
      old.supersededBy.push(...record.resolution.children.map((c) => c.id));
    }
    for (const child of record.resolution.children)
      definitions.set(child.id, { identity: child, active: true, supersededBy: [] });
  }
  const assigned = new Set(
    records.flatMap((r) => r.resolution.children.flatMap((c) => c.claimIds)),
  );
  for (const definition of [...definitions.values()])
    if (!definition.active && definition.identity.kind === 'BASE') {
      const unknown = graph.nodes.filter(
        (n) => n.clusterId === definition.identity.id && !assigned.has(n.id),
      );
      if (unknown.length) {
        const id = deterministicId('unassigned-event', {
          parent: definition.identity.id,
          firstClaim: unknown[0]!.id,
        });
        if (!definitions.has(id))
          definitions.set(id, {
            identity: {
              id,
              kind: 'UNASSIGNED',
              label: 'unassigned later evidence',
              claimIds: unknown.map((n) => n.id).sort(),
              baseClusterIds: [definition.identity.id],
              parentIds: [definition.identity.id],
              createdAt: unknown[0]!.knownAt,
            },
            active: true,
            supersededBy: [],
          });
      }
    }
  return [...definitions.values()].sort((a, b) => (a.identity.id < b.identity.id ? -1 : 1));
}
function scoreFor(graph: Graph, ids: readonly string[], clusterId: string) {
  const selected = new Set(ids),
    external = new Set(
      graph.edges
        .filter(
          (e) =>
            selected.has(e.from) &&
            !selected.has(e.to) &&
            !['SAME_ARTICLE', 'SAME_ORIGIN_GROUP'].includes(e.relationship),
        )
        .map((e) => e.from),
    ),
    nodes = graph.nodes
      .filter((n) => selected.has(n.id))
      .map((n) => ({
        ...n,
        clusterId,
        reportingBasis: external.has(n.id) ? ('DEPENDENT' as const) : n.reportingBasis,
      })),
    edges = graph.edges.filter((e) => selected.has(e.from) && selected.has(e.to));
  return evidenceIndependenceScore(nodes, edges);
}
function subjectFor(records: readonly NewsGraphRecord[]) {
  const claims = new Map<
    string,
    {
      candidate: Extract<
        NewsGraphRecord['action'],
        { kind: 'OBSERVE' }
      >['extraction']['claims'][number]['candidate'];
      result: Extract<NewsGraphRecord['action'], { kind: 'OBSERVE' }>['extraction'];
    }
  >();
  for (const r of records)
    if (r.action.kind === 'OBSERVE')
      for (const c of r.action.extraction.claims)
        if (!claims.has(c.id))
          claims.set(c.id, { candidate: c.candidate, result: r.action.extraction });
  return claims;
}
export function projectNewsEvents(
  graphRecords: readonly NewsGraphRecord[],
  graphConfig: Graph['config'],
  records: readonly NewsEventRecord[],
  configInput: unknown,
  decisionAt: string,
) {
  const config = NewsEventConfigSchema.parse(configInput),
    graph = projectNewsGraph(graphRecords, graphConfig, decisionAt),
    definitions = newsEventIdentities(graph, records),
    claims = subjectFor(graphRecords),
    frames = graphRecords.map((r, i) => ({
      record: r,
      graph: projectNewsGraph(graphRecords.slice(0, i + 1), graphConfig, r.recordedAt),
    }));
  const events = definitions.map((def) => {
    const { identity } = def,
      membership = new Set(identity.claimIds),
      nodes = graph.nodes.filter((n) => membership.has(n.id)),
      active = nodes.filter((n) => n.active && n.eligible && !n.retracted),
      independence = scoreFor(graph, identity.claimIds, identity.id),
      disputed =
        active.some((n) => n.polarity === 'AFFIRMED') &&
        active.some((n) => n.polarity === 'NEGATED'),
      status = disputed
        ? 'DISPUTED'
        : independence.independentAffirmativeOrigins === 0 &&
            nodes.some((n) => n.retracted && n.polarity === 'AFFIRMED')
          ? 'RETRACTED'
          : independence.groups.some((g) => g.official)
            ? 'OFFICIALLY_STATED'
            : independence.independentAffirmativeOrigins >= 2
              ? 'CORROBORATED'
              : 'UNVERIFIED',
      lineageReview = identity.kind !== 'BASE' || identity.parentIds.length > 0,
      unassigned = definitions.filter(
        (d) =>
          d.active &&
          d.identity.kind === 'UNASSIGNED' &&
          d.identity.baseClusterIds.some((id) => identity.baseClusterIds.includes(id)),
      ),
      provisional =
        identity.kind === 'UNASSIGNED' ||
        identity.claimIds.some((id) => graph.nodes.find((n) => n.id === id)?.anchorKey === null),
      grade = disputed
        ? 'DISPUTED'
        : status === 'RETRACTED'
          ? 'WITHDRAWN'
          : lineageReview || provisional
            ? 'IDENTITY_REVIEW'
            : status === 'CORROBORATED'
              ? 'MULTI_ORIGIN'
              : status === 'OFFICIALLY_STATED'
                ? 'ATTRIBUTED'
                : 'UNVERIFIED';
    const milestone = (frame: (typeof frames)[number], claimIds: string[]) => ({
      sourceKnownAt: frame.record.recordedAt,
      eventKnownAt: max(frame.record.recordedAt, identity.createdAt),
      claimIds,
      recordHash: frame.record.hash,
    });
    let firstRumor: ReturnType<typeof milestone> | null = null,
      firstIndependentCorroboration: ReturnType<typeof milestone> | null = null,
      firstOfficialStatement: ReturnType<typeof milestone> | null = null;
    for (const frame of frames) {
      const members = frame.graph.nodes.filter((n) => membership.has(n.id));
      if (!members.length) continue;
      const roots = scoreFor(
        frame.graph,
        members.map((n) => n.id),
        identity.id,
      );
      const rumor = members.filter(
        (n) => n.publicationType === 'UNVERIFIED_RUMOR' || n.polarity === 'UNCERTAIN',
      );
      if (!firstRumor && rumor.length)
        firstRumor = milestone(
          frame,
          rumor.map((n) => n.id),
        );
      const independent = roots.groups.filter(
        (g) =>
          g.affirmative &&
          g.rootClaimIds.some(
            (id) => members.find((n) => n.id === id)?.reportingBasis === 'ASSERTED_ORIGINAL',
          ),
      );
      if (!firstIndependentCorroboration && independent.length >= 2)
        firstIndependentCorroboration = milestone(
          frame,
          independent.flatMap((g) => g.rootClaimIds),
        );
      const official = roots.groups.filter((g) => g.official).flatMap((g) => g.rootClaimIds);
      if (!firstOfficialStatement && official.length)
        firstOfficialStatement = milestone(frame, official);
    }
    const associated: ReturnType<
      typeof NewsEventViewSchema.parse
    >['events'][number]['history']['corrections'] = graph.timeline
      .filter((t) => t.kind !== 'OBSERVE' && t.claimIds.some((id) => membership.has(id)))
      .map((t) => ({
        knownAt: t.knownAt,
        kind: t.kind,
        recordHash: t.recordHash,
        operator: t.operator,
        reason: t.reason,
      }));
    const subjectNames = [
        ...new Set(
          nodes.flatMap((n) => {
            const c = claims.get(n.id)?.candidate;
            return (
              c?.entities
                .filter(
                  (e) => e.evidence.start === c.subject?.start && e.evidence.end === c.subject?.end,
                )
                .map((e) => normal(e.name)) ?? []
            );
          }),
        ),
      ],
      eventTypes = new Set(nodes.map((n) => claims.get(n.id)!.candidate.eventType));
    const assets: ReturnType<typeof NewsEventViewSchema.parse>['events'][number]['assets'] = [];
    for (const n of nodes)
      for (const a of claims.get(n.id)!.candidate.affectedAssets) {
        const old = assets.find((v) => v.relationship === 'MENTION_ONLY' && v.symbol === a.symbol);
        if (old) {
          if (!old.claimIds.includes(n.id)) old.claimIds.push(n.id);
        } else
          assets.push({
            symbol: a.symbol,
            relationship: 'MENTION_ONLY',
            knownAt: max(n.knownAt, identity.createdAt),
            claimIds: [n.id],
            ruleHash: null,
            reference: null,
            rationale: 'Explicit text mention; no exposure or price direction inferred.',
          });
      }
    for (const r of records) {
      const a = r.action;
      if (
        a.kind === 'MAP_ASSET' &&
        subjectNames.includes(normal(a.subject)) &&
        a.eventTypes.some((t) => eventTypes.has(t))
      ) {
        assets.push({
          symbol: a.symbol,
          relationship: a.relationship,
          knownAt: max(r.recordedAt, identity.createdAt, ...nodes.map((n) => n.knownAt)),
          claimIds: nodes.map((n) => n.id),
          ruleHash: r.hash,
          reference: a.reference,
          rationale: r.reason,
        });
        if (r.recordedAt >= identity.createdAt)
          associated.push({
            knownAt: r.recordedAt,
            kind: 'MAP_ASSET',
            recordHash: r.hash,
            operator: r.operator,
            reason: r.reason,
          });
      }
      if (
        r.resolution.parents.some((p) => p.id === identity.id) ||
        r.resolution.children.some((c) => c.id === identity.id)
      )
        associated.push({
          knownAt: r.recordedAt,
          kind: a.kind,
          recordHash: r.hash,
          operator: r.operator,
          reason: r.reason,
        });
    }
    associated.sort((a, b) =>
      a.knownAt < b.knownAt ? -1 : a.knownAt > b.knownAt ? 1 : a.recordHash < b.recordHash ? -1 : 1,
    );
    const firstKnownAt = identity.createdAt,
      lastUpdatedAt = max(
        identity.createdAt,
        ...nodes.map((n) => n.knownAt),
        ...associated.map((c) => c.knownAt),
        ...unassigned.map((d) => d.identity.createdAt),
      ),
      earliestObservation = nodes.length
        ? nodes.map((n) => n.firstObservedAt).sort()[0]!
        : identity.createdAt,
      expectation = records
        .filter(
          (r) =>
            r.action.kind === 'EXPECT' &&
            r.recordedAt <= earliestObservation &&
            nodes.some(
              (n) =>
                n.eligible &&
                n.anchorKey === normal(r.action.kind === 'EXPECT' ? r.action.anchorKey : ''),
            ) &&
            r.action.kind === 'EXPECT' &&
            subjectNames.includes(normal(r.action.subject)) &&
            eventTypes.has(r.action.eventType),
        )
        .at(-1);
    let surprise: ReturnType<typeof NewsEventViewSchema.parse>['events'][number]['surprise'] = {
      marker: 'UNKNOWN',
      expectationHash: null,
      rationale:
        'No comparable expectation recorded before first receipt; no market surprise inferred.',
    };
    if (
      expectation &&
      expectation.action.kind === 'EXPECT' &&
      !lineageReview &&
      !disputed &&
      active.some((n) => n.polarity === 'AFFIRMED') &&
      eventTypes.size === 1 &&
      subjectNames.length === 1
    ) {
      const quantities = claims.get(nodes[0]!.id)!.candidate.amounts,
        expected = expectation.action.amounts,
        units = quantities.map((q) => q.unit).sort(),
        expectedUnits = expected.map((q) => q.unit).sort(),
        comparable =
          quantities.every((q) => q.value !== null) &&
          canonicalHash(units) === canonicalHash(expectedUnits),
        normalizeAmounts = (v: { value: string; unit: string }[]) =>
          v
            .map((q) => ({ value: decimal(q.value), unit: q.unit }))
            .sort((a, b) => (canonicalJson(a) < canonicalJson(b) ? -1 : 1));
      surprise = {
        marker: !comparable
          ? 'NOT_COMPARABLE'
          : canonicalHash(
                normalizeAmounts(quantities.map((q) => ({ value: q.value!, unit: q.unit! }))),
              ) === canonicalHash(normalizeAmounts(expected))
            ? 'SCHEDULED_MATCH'
            : 'EXPECTATION_MISMATCH',
        expectationHash: expectation.hash,
        rationale:
          'Comparison to a pre-receipt declared expectation only; not a price surprise or probability.',
      };
    }
    const lookback =
        utcNanoseconds(UtcTimestampSchema.parse(firstKnownAt)) -
        BigInt(config.noveltyWindowHours) * 3600000000000n,
      prior = graph.nodes.filter(
        (n) =>
          !membership.has(n.id) &&
          n.eligible &&
          n.knownAt < firstKnownAt &&
          utcNanoseconds(n.knownAt) >= lookback &&
          eventTypes.has(claims.get(n.id)!.candidate.eventType) &&
          claims
            .get(n.id)!
            .candidate.entities.some(
              (e) => subjectNames.includes(normal(e.name)) && e.kind !== 'ASSET',
            ),
      ),
      latestChange = graph.timeline
        .filter((t) => t.claimIds.some((id) => membership.has(id)))
        .at(-1),
      newNodes = latestChange ? nodes.filter((n) => latestChange.claimIds.includes(n.id)) : [],
      dependent = (n: NewsGraphNode) =>
        n.reportingBasis === 'DEPENDENT' ||
        graph.edges.some(
          (e) => e.from === n.id && !['SAME_ARTICLE', 'SAME_ORIGIN_GROUP'].includes(e.relationship),
        );
    const abstentionReasons: string[] = [];
    if (!def.active) abstentionReasons.push('SUPERSEDED_EVENT');
    if (!active.length) abstentionReasons.push('NO_ACTIVE_POINT_IN_TIME_EVIDENCE');
    if (disputed) abstentionReasons.push('DISPUTED');
    if (status === 'RETRACTED') abstentionReasons.push('WITHDRAWN');
    if (lineageReview || provisional) abstentionReasons.push('IDENTITY_REVIEW');
    if (grade === 'UNVERIFIED') abstentionReasons.push('UNVERIFIED');
    if (unassigned.length) abstentionReasons.push('UNASSIGNED_LATER_EVIDENCE');
    const replayEligible =
      def.active &&
      identity.kind !== 'UNASSIGNED' &&
      active.length > 0 &&
      unassigned.length === 0 &&
      nodes.every((n) => n.eligible);
    return {
      identity,
      active: def.active,
      supersededBy: def.supersededBy,
      status,
      firstKnownAt,
      lastUpdatedAt,
      availableAt: replayEligible ? lastUpdatedAt : null,
      replayEligible,
      confidence: {
        grade,
        explanation: [
          `Evidence status: ${status}; assertions and declared source independence are fallible.`,
          ...(lineageReview || provisional
            ? [
                'Identity is provisional or manually transformed; no automatic confidence promotion.',
              ]
            : []),
          ...(graph.review.some((r) => r.claimIds.some((id) => membership.has(id)))
            ? ['Open or acknowledged provenance review items remain part of the evidence.']
            : []),
        ],
        uncertaintyBand: {
          interpretation: 'UNAUTHENTICATED_ORIGIN_COUNT_NOT_PROBABILITY',
          minimumOrigins: 0,
          maximumOrigins: independence.affirmativeArticleOccurrences,
        },
      },
      independence,
      history: {
        firstRumor,
        firstIndependentCorroboration,
        firstOfficialStatement,
        corrections: associated,
        sourceReviewHashes: [
          ...new Set(nodes.flatMap((n) => claims.get(n.id)!.result.input.article.correctionHashes)),
        ].sort(),
      },
      assets,
      novelty: {
        pattern:
          lineageReview || provisional
            ? 'UNKNOWN'
            : prior.length
              ? 'REPEATED_PATTERN'
              : 'FIRST_SEEN_IN_CORPUS',
        priorEventIds: [...new Set(prior.map((n) => n.clusterId))].sort(),
        updateKind: !latestChange
          ? 'UNKNOWN'
          : latestChange.kind === 'ACKNOWLEDGE'
            ? 'REVIEW_ONLY'
            : latestChange.kind !== 'OBSERVE'
              ? 'CORRECTION'
              : newNodes.length && newNodes.every(dependent)
                ? 'REPOST_ONLY'
                : 'NEW_REPORT',
        rationale: `Observed-corpus pattern within ${config.noveltyWindowHours} hours, not global novelty or market impact.`,
      },
      surprise,
      abstentionReasons,
    };
  });
  return NewsEventViewSchema.parse({
    schemaVersion: 'news-event-view.v1',
    execution: 'DISABLED',
    decisionAt,
    graphHeadHash: graph.journalHeadHash,
    metadataHeadHash: records.at(-1)?.hash ?? newsEventGenesis,
    config,
    graph,
    events,
  });
}
