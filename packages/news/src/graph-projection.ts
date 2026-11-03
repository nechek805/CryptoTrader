import { z } from 'zod';
import {
  NewsGraphConfigSchema,
  NewsGraphViewSchema,
  NewsIndependenceScoreSchema,
  NewsGraphNodeSchema,
  NewsGraphEdgeSchema,
  UtcTimestampSchema,
} from '@crypto/contracts';
import type {
  NewsExtractionResult,
  NewsGraphNode,
  NewsGraphEdge,
  NewsGraphRecord,
} from '@crypto/contracts';
import { canonicalHash, canonicalJson, deterministicId } from '@crypto/core';
import { canonicalNewsUrl } from './dedup.js';

export const newsGraphGenesis = canonicalHash({ schemaVersion: 'news-graph-chain.v1' });
export function defaultNewsGraphConfig() {
  return NewsGraphConfigSchema.parse({
    schemaVersion: 'news-graph-config.v1',
    algorithmVersion: 'news-independence.v1',
    nearDuplicateThresholdBps: 9500,
    minSharedTokens: 8,
    maxExtractions: 100,
    maxNodes: 1000,
  });
}
const normal = (v: string) => v.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const maximum = (...v: string[]) => UtcTimestampSchema.parse(v.sort().at(-1));
function decimal(v: string | null) {
  return v === null
    ? null
    : v
        .replace(/(\.\d*?)0+$/, '$1')
        .replace(/\.$/, '')
        .replace(/^-0$/, '0');
}
function tokens(v: string) {
  return new Set(normal(v).match(/[\p{L}\p{N}]+/gu) ?? []);
}
function similar(a: string, b: string, minimum: number, threshold: number) {
  const left = tokens(a),
    right = tokens(b),
    common = [...left].filter((t) => right.has(t)).length;
  return common >= minimum && common * 10000 >= new Set([...left, ...right]).size * threshold;
}
function nodeFor(
  result: NewsExtractionResult,
  claim: NewsExtractionResult['claims'][number],
  record: NewsGraphRecord,
): NewsGraphNode {
  const { candidate } = claim,
    article = result.input.article,
    source = result.input.source,
    text =
      result.input.field === 'TITLE'
        ? article.version.document.title
        : article.version.document.approvedSnippet!,
    found = [
      ...candidate.evidence.text.matchAll(
        /(?<![\p{L}\p{N}])(?:case|дело)\s+([a-z][a-z0-9-]{2,39})(?![\p{L}\p{N}])/giu,
      ),
    ],
    unique = new Set(found.map((m) => normal(m[1]!))),
    match = unique.size === 1 ? found[0] : undefined,
    anchor = match
      ? {
          start: candidate.evidence.start + match.index,
          end: candidate.evidence.start + match.index + match[0].length,
          text: match[0],
        }
      : null,
    subject =
      candidate.entities.find(
        (e) =>
          e.evidence.start === candidate.subject?.start &&
          e.evidence.end === candidate.subject?.end,
      )?.name ?? null,
    precise = ['DAY', 'MINUTE', 'SECOND'].includes(candidate.eventTime.granularity),
    broad = {
      eventType: candidate.eventType,
      predicate: candidate.predicate,
      subject: subject === null ? null : normal(subject),
      time: {
        granularity: candidate.eventTime.granularity,
        value: candidate.eventTime.at ?? candidate.eventTime.evidence?.text ?? null,
      },
      amounts: candidate.amounts
        .map((a) => ({ value: decimal(a.value), unit: a.unit, kind: a.kind }))
        .sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b), 'en')),
      assets: [...new Set(candidate.affectedAssets.map((a) => a.symbol))].sort(),
    },
    broadKey = canonicalHash(broad),
    anchorKey =
      anchor &&
      subject &&
      precise &&
      candidate.amounts.every((a) => a.value !== null && a.unit !== null)
        ? normal(match![1]!)
        : null,
    clusterId = deterministicId(
      'news-event-cluster',
      anchorKey
        ? { anchor: anchorKey, broadKey }
        : { provisional: article.version.entityId, broadKey },
    ),
    official =
      source.publicationType === 'OFFICIAL_SECURITY'
        ? /officially stated|официально заявило/iu.exec(candidate.evidence.text)
        : null,
    original =
      source.publicationType === 'INDEPENDENT_REPORTING'
        ? /independently reported|observed first-hand|независимо сообщило/iu.exec(
            candidate.evidence.text,
          )
        : null,
    cue = official ?? original,
    reportingBasis = official
      ? 'OFFICIAL_PRIMARY'
      : original
        ? 'ASSERTED_ORIGINAL'
        : source.publicationType === 'SYNDICATED'
          ? 'DEPENDENT'
          : 'UNKNOWN';
  return {
    id: claim.id,
    clusterId,
    extractionHash: canonicalHash(result),
    articleId: article.version.entityId,
    articleVersionId: article.version.versionId,
    sourceId: source.id,
    sourceHash: article.version.sourceHash,
    independenceGroup: source.independenceGroup,
    publicationType: source.publicationType,
    canonicalUrl: canonicalNewsUrl(article.version.document.canonicalUrl),
    field: result.input.field,
    anchor,
    anchorKey,
    broadKey,
    text,
    polarity: candidate.polarity,
    reportingBasis,
    basisEvidence: cue
      ? {
          start: candidate.evidence.start + cue.index,
          end: candidate.evidence.start + cue.index + cue[0].length,
          text: cue[0],
        }
      : null,
    firstObservedAt: article.version.document.firstObservedAt,
    extractedAt: result.processedAt,
    knownAt: record.recordedAt,
    articleProcessedAt: article.version.processedAt,
    eligible:
      claim.canonical.researchUse === 'ELIGIBLE' &&
      claim.canonical.availableAt !== null &&
      claim.canonical.availableAt <= record.recordedAt,
    active: true,
    retracted: false,
  };
}

/** Fraction of supported independent affirmative origins, never a confidence probability. */
export function evidenceIndependenceScore(nodeInput: unknown, edgeInput: unknown) {
  const nodes = z.array(NewsGraphNodeSchema).max(1000).parse(nodeInput),
    edges = z.array(NewsGraphEdgeSchema).max(10000).parse(edgeInput);
  if (
    new Set(nodes.map((n) => n.id)).size !== nodes.length ||
    new Set(nodes.map((n) => n.clusterId)).size > 1 ||
    edges.some((e) => !nodes.some((n) => n.id === e.from) || !nodes.some((n) => n.id === e.to))
  )
    throw new Error('Invalid independence graph');
  const parent = new Map(nodes.map((n) => [n.id, n.id]));
  const root = (id: string): string => {
    let r = id;
    while (parent.get(r) !== r) r = parent.get(r)!;
    while (parent.get(id) !== id) {
      const next = parent.get(id)!;
      parent.set(id, r);
      id = next;
    }
    return r;
  };
  for (const e of edges)
    if (parent.has(e.from) && parent.has(e.to)) parent.set(root(e.from), root(e.to));
  const owners = new Map<string, string>();
  for (const n of nodes)
    for (const key of [
      `article:${n.articleId}`,
      `origin:${n.independenceGroup}`,
      `url:${n.canonicalUrl}`,
    ]) {
      const prior = owners.get(key);
      if (prior) parent.set(root(n.id), root(prior));
      else owners.set(key, n.id);
    }
  const grouped = new Map<string, NewsGraphNode[]>();
  for (const n of nodes) {
    const key = root(n.id),
      group = grouped.get(key) ?? [];
    group.push(n);
    grouped.set(key, group);
  }
  const dependent = new Set(
    edges
      .filter((e) => !['SAME_ARTICLE', 'SAME_ORIGIN_GROUP'].includes(e.relationship))
      .map((e) => e.from),
  );
  const groups = [...grouped.values()]
    .map((group) => {
      const roots = group.filter(
          (n) =>
            n.active &&
            n.eligible &&
            !n.retracted &&
            !dependent.has(n.id) &&
            ['ASSERTED_ORIGINAL', 'OFFICIAL_PRIMARY'].includes(n.reportingBasis),
        ),
        affirmative = roots.some((n) => n.polarity === 'AFFIRMED');
      return {
        id: deterministicId('news-origin', group.map((n) => n.id).sort()),
        claimIds: group.map((n) => n.id).sort(),
        sourceIds: [...new Set(group.map((n) => n.sourceId))].sort(),
        rootClaimIds: roots.map((n) => n.id).sort(),
        affirmative,
        official: roots.some(
          (n) => n.polarity === 'AFFIRMED' && n.reportingBasis === 'OFFICIAL_PRIMARY',
        ),
      };
    })
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const occurrences = new Set(
      nodes
        .filter((n) => n.active && n.eligible && !n.retracted && n.polarity === 'AFFIRMED')
        .map((n) => n.articleId),
    ).size,
    origins = groups.filter((g) => g.affirmative).length;
  return NewsIndependenceScoreSchema.parse({
    valueBps: occurrences === 0 ? 0 : Math.floor((origins * 10000) / occurrences),
    interpretation: 'ORIGIN_FRACTION_NOT_PROBABILITY',
    affirmativeArticleOccurrences: occurrences,
    independentAffirmativeOrigins: origins,
    groups,
  });
}

export function projectNewsGraph(
  records: readonly NewsGraphRecord[],
  configInput: unknown,
  decisionAt: string,
) {
  const config = NewsGraphConfigSchema.parse(configInput),
    known = records.filter((r) => r.recordedAt <= decisionAt),
    nodesById = new Map<string, NewsGraphNode>(),
    latest = new Map<string, string>(),
    latestField = new Map<string, string>();
  for (const record of known)
    if (record.action.kind === 'OBSERVE') {
      const result = record.action.extraction,
        article = result.input.article.version;
      latest.set(
        article.entityId,
        maximum(latest.get(article.entityId) ?? '', article.processedAt),
      );
      const field = `${article.versionId}/${result.input.field}`;
      latestField.set(field, maximum(latestField.get(field) ?? '', result.processedAt));
      for (const claim of result.claims)
        if (!nodesById.has(claim.id)) nodesById.set(claim.id, nodeFor(result, claim, record));
    }
  const nodes = [...nodesById.values()].sort((a, b) =>
    a.knownAt < b.knownAt ? -1 : a.knownAt > b.knownAt ? 1 : a.id < b.id ? -1 : 1,
  );
  const review: ReturnType<typeof NewsGraphViewSchema.parse>['review'] = [];
  const addReview = (
    category: (typeof review)[number]['category'],
    claimIds: string[],
    clusterId: string | null,
    detail: string,
    at: string,
    identity: string | null = null,
  ) => {
    const item = {
      id: deterministicId('news-graph-review', {
        identity,
        category,
        claimIds: [...claimIds].sort(),
        clusterId,
      }),
      category,
      claimIds: [...claimIds].sort(),
      clusterId,
      detail,
      knownAt: UtcTimestampSchema.parse(at),
      status: 'OPEN' as const,
    };
    if (!review.some((r) => r.id === item.id)) review.push(item);
  };
  for (const n of nodes) {
    n.active =
      n.articleProcessedAt === latest.get(n.articleId) &&
      n.extractedAt === latestField.get(`${n.articleVersionId}/${n.field}`);
    if (!n.anchorKey)
      addReview(
        'AMBIGUOUS_IDENTITY',
        [n.id],
        n.clusterId,
        'No unique precise incident anchor; provisional article-local cluster.',
        n.knownAt,
      );
    if (n.reportingBasis === 'UNKNOWN')
      addReview(
        'UNKNOWN_ORIGIN',
        [n.id],
        n.clusterId,
        'No explicit original reporting or primary official statement cue.',
        n.knownAt,
      );
  }
  const edges: NewsGraphEdge[] = [],
    addEdge = (
      from: NewsGraphNode,
      to: NewsGraphNode,
      relationship: NewsGraphEdge['relationship'],
      evidence: NewsGraphEdge['evidence'],
      rationale: string,
      at?: string,
      manualRecordHash: string | null = null,
    ) => {
      if (from.id === to.id) return;
      const edge = {
        id: deterministicId('news-dependency', { from: from.id, to: to.id, relationship }),
        from: from.id,
        to: to.id,
        relationship,
        knownAt: maximum(from.knownAt, to.knownAt, at ?? ''),
        evidence,
        rationale,
        manualRecordHash,
      };
      if (!edges.some((e) => e.id === edge.id)) edges.push(edge);
    };
  const citations = new Set<string>();
  for (const from of nodes) {
    for (const match of from.text.matchAll(
      /(wire reprint of|rewrite of|quotes official|cites|attribution)\s+(https:\/\/[^\s<>";]+)/giu,
    )) {
      citations.add(from.id);
      const url = match[2]!.replace(/[.!?,)]+$/, ''),
        relation = (
          {
            'wire reprint of': 'WIRE_REPRINT',
            'rewrite of': 'REWRITE',
            'quotes official': 'QUOTED_OFFICIAL',
            cites: 'CITES',
            attribution: 'ATTRIBUTION',
          } as Record<string, NewsGraphEdge['relationship']>
        )[match[1]!.toLowerCase()]!,
        targets = nodes.filter(
          (n) => n.clusterId === from.clusterId && n.canonicalUrl === url && n.id !== from.id,
        ),
        target = targets
          .filter(
            (n) => relation !== 'QUOTED_OFFICIAL' || n.publicationType === 'OFFICIAL_SECURITY',
          )
          .at(0);
      if (!target)
        addReview(
          'UNRESOLVED_ATTRIBUTION',
          [from.id],
          from.clusterId,
          'Attribution URL has no known matching event evidence; no fetch or independent credit.',
          from.knownAt,
        );
      else
        addEdge(
          from,
          target,
          relation,
          { start: match.index, end: match.index + match[0].length, text: match[0] },
          'Explicit retained attribution URL.',
        );
    }
    if (citations.has(from.id)) from.reportingBasis = 'DEPENDENT';
  }
  for (let i = 0; i < nodes.length; i++)
    for (let j = 0; j < i; j++) {
      const a = nodes[i]!,
        b = nodes[j]!;
      if (a.clusterId !== b.clusterId) {
        if (a.broadKey === b.broadKey && (a.anchorKey === null || b.anchorKey === null))
          addReview(
            'POSSIBLE_MATCH',
            [a.id, b.id],
            null,
            'Typed fields match but incident identity is insufficient for automatic merge.',
            maximum(a.knownAt, b.knownAt),
          );
        if (a.anchorKey !== null && a.anchorKey === b.anchorKey)
          addReview(
            'DETAIL_CONFLICT',
            [a.id, b.id],
            null,
            'Shared incident label has different typed details; retain separate clusters for review.',
            maximum(a.knownAt, b.knownAt),
          );
        continue;
      }
      if (a.articleId === b.articleId || a.canonicalUrl === b.canonicalUrl)
        addEdge(a, b, 'SAME_ARTICLE', null, 'Same article identity or canonical URL.');
      else if (a.independenceGroup === b.independenceGroup)
        addEdge(a, b, 'SAME_ORIGIN_GROUP', null, 'Registry attributes a shared origin group.');
      else if (
        a.polarity === b.polarity &&
        similar(a.text, b.text, config.minSharedTokens, config.nearDuplicateThresholdBps)
      ) {
        addEdge(
          a,
          b,
          'INFERRED_SYNDICATION',
          null,
          'High lexical overlap within the same anchored event; conservative possible dependency.',
        );
        addReview(
          'INFERRED_SYNDICATION',
          [a.id, b.id],
          a.clusterId,
          'Inferred copy relationship reduces independent credit until provenance is better understood.',
          maximum(a.knownAt, b.knownAt),
        );
      }
    }
  for (const record of known)
    if (record.action.kind === 'REVIEW') {
      const action = record.action.decision;
      if (action.kind === 'LINK')
        addEdge(
          nodesById.get(action.from)!,
          nodesById.get(action.to)!,
          action.relationship,
          null,
          'Operator-recorded source dependency; see review ledger reason.',
          record.recordedAt,
          record.hash,
        );
      if (action.kind === 'RETRACT' || action.kind === 'RESTORE') {
        nodesById.get(action.claimId)!.retracted = action.kind === 'RETRACT';
        addReview(
          'RETRACTION',
          [action.claimId],
          nodesById.get(action.claimId)!.clusterId,
          'Retraction/restore retained as prospective operator evidence.',
          record.recordedAt,
        );
      }
    }
  // Directed citation cycles are evidence of uncertain lineage, never new origins.
  const adjacency = new Map(
    nodes.map((n) => [
      n.id,
      edges
        .filter(
          (e) => e.from === n.id && !['SAME_ARTICLE', 'SAME_ORIGIN_GROUP'].includes(e.relationship),
        )
        .map((e) => e.to),
    ]),
  );
  const visited = new Set<string>(),
    stack = new Set<string>();
  const walk = (id: string) => {
    if (stack.has(id)) {
      addReview(
        'CIRCULAR_ATTRIBUTION',
        [id],
        nodesById.get(id)!.clusterId,
        'Circular attribution has no defensible independent root.',
        maximum(...[...stack].map((key) => nodesById.get(key)!.knownAt)),
      );
      return;
    }
    if (visited.has(id)) return;
    visited.add(id);
    stack.add(id);
    for (const to of adjacency.get(id) ?? []) walk(to);
    stack.delete(id);
  };
  nodes.forEach((n) => walk(n.id));
  for (const record of known)
    if (record.action.kind === 'OBSERVE' && record.action.extraction.status === 'REVIEW_NEEDED')
      addReview(
        'EXTRACTION_REVIEW',
        record.action.extraction.claims.map((c) => c.id),
        null,
        'Extraction retained unresolved fields or no supported assertions.',
        record.recordedAt,
        record.hash,
      );
  const clusterIds = [...new Set(nodes.map((n) => n.clusterId))].sort();
  const clusters = clusterIds.map((id) => {
    const group = nodes.filter((n) => n.clusterId === id),
      localEdges = edges.filter(
        (e) => group.some((n) => n.id === e.from) && group.some((n) => n.id === e.to),
      ),
      independence = evidenceIndependenceScore(group, localEdges),
      active = group.filter((n) => n.active && n.eligible && !n.retracted),
      affirmed = group.filter((n) => n.polarity === 'AFFIRMED').map((n) => n.id),
      negated = group.filter((n) => n.polarity === 'NEGATED').map((n) => n.id),
      conflict =
        active.some((n) => n.polarity === 'AFFIRMED') &&
        active.some((n) => n.polarity === 'NEGATED'),
      retracted =
        independence.independentAffirmativeOrigins === 0 &&
        group.some((n) => n.retracted && n.polarity === 'AFFIRMED'),
      status = conflict
        ? 'DISPUTED'
        : retracted
          ? 'RETRACTED'
          : independence.groups.some((g) => g.official)
            ? 'OFFICIALLY_STATED'
            : independence.independentAffirmativeOrigins >= 2
              ? 'CORROBORATED'
              : 'UNVERIFIED';
    const contradictions =
      affirmed.length && negated.length
        ? [{ id: deterministicId('news-contradiction', id), affirmed, negated, active: conflict }]
        : [];
    if (conflict)
      addReview(
        'CONTRADICTION',
        active.map((n) => n.id),
        id,
        'Known affirmative and negated assertions conflict; status is disputed, not resolved truth.',
        maximum(...active.map((n) => n.knownAt)),
      );
    return {
      id,
      identity: group[0]!.anchorKey ? 'ANCHORED' : 'PROVISIONAL',
      claimIds: group.map((n) => n.id),
      activeClaimIds: active.map((n) => n.id),
      status,
      firstKnownAt: group[0]!.knownAt,
      independence,
      contradictions,
    };
  });
  const acknowledged = new Set(
    known.flatMap((r) =>
      r.action.kind === 'REVIEW' && r.action.decision.kind === 'ACKNOWLEDGE'
        ? [r.action.decision.reviewId]
        : [],
    ),
  );
  for (const item of review) if (acknowledged.has(item.id)) item.status = 'ACKNOWLEDGED';
  const timeline = known.map((r) => ({
    recordHash: r.hash,
    knownAt: r.recordedAt,
    kind: r.action.kind === 'OBSERVE' ? 'OBSERVE' : r.action.decision.kind,
    claimIds:
      r.action.kind === 'OBSERVE'
        ? r.action.extraction.claims.map((c) => c.id)
        : r.action.decision.kind === 'LINK'
          ? [r.action.decision.from, r.action.decision.to]
          : 'claimId' in r.action.decision
            ? [r.action.decision.claimId]
            : [],
    operator: r.action.kind === 'REVIEW' ? r.action.operator : null,
    reason: r.action.kind === 'REVIEW' ? r.action.reason : null,
  }));
  return NewsGraphViewSchema.parse({
    schemaVersion: 'news-graph-view.v1',
    execution: 'DISABLED',
    decisionAt,
    config,
    configHash: canonicalHash(config),
    journalHeadHash: known.at(-1)?.hash ?? newsGraphGenesis,
    nodes,
    edges,
    clusters,
    review,
    timeline,
  });
}
