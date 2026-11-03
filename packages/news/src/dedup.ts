import { NewsDeliverySchema, UtcTimestampSchema, NewsDuplicateViewSchema } from '@crypto/contracts';
import type { NewsDelivery, NewsSource, ParsedNewsItem } from '@crypto/contracts';
import { canonicalHash, deterministicId, deepFreeze } from '@crypto/core';
import { newsHttpsUrl } from '@crypto/connectors';

/** Explicit tracking-only removal. Keep publisher content/query identifiers and HTTPS scheme. */
export function canonicalNewsUrl(input: string): string {
  const value = new URL(input);
  value.hash = '';
  const url = newsHttpsUrl(value.href);
  for (const key of [...url.searchParams.keys()])
    if (/^utm_/i.test(key) || ['fbclid', 'gclid', 'msclkid'].includes(key.toLowerCase()))
      url.searchParams.delete(key);
  const sorted = [...url.searchParams].sort(([ak, av], [bk, bv]) =>
    ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0,
  );
  url.search = '';
  for (const [key, value] of sorted) url.searchParams.append(key, value);
  return url.href;
}
export function approvedTextHash(item: ParsedNewsItem): string {
  return canonicalHash({
    language: item.language.toLowerCase(),
    title: item.title.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase(),
  });
}
/** Evidence groups are possible dependencies; matching metadata never verifies a fact. */
export function newsDuplicateView(input: readonly NewsDelivery[], decisionInput: string) {
  if (input.length > 5000) throw new Error('News delivery view limit');
  const decisionAt = UtcTimestampSchema.parse(decisionInput),
    deliveries = input
      .map((v) => NewsDeliverySchema.parse(v))
      .filter((v) => v.availableAt <= decisionAt);
  const parent = deliveries.map((_v, i) => i);
  const root = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r]!;
    while (parent[i] !== i) {
      const next = parent[i]!;
      parent[i] = r;
      i = next;
    }
    return r;
  };
  const urls = new Map<string, number>(),
    texts = new Map<string, number>();
  deliveries.forEach((d, i) => {
    for (const [map, key] of [
      [urls, d.canonicalUrl],
      [texts, d.approvedTextHash],
    ] as const) {
      const prior = map.get(key);
      if (prior !== undefined) parent[root(i)] = root(prior);
      else map.set(key, i);
    }
  });
  const grouped = new Map<number, NewsDelivery[]>();
  deliveries.forEach((d, i) => {
    const key = root(i),
      group = grouped.get(key) ?? [];
    group.push(d);
    grouped.set(key, group);
  });
  const groups = [...grouped.values()].map((group) => ({
    id: deterministicId('news-evidence-group', [...group].map((d) => d.id).sort()),
    firstObservedAt: group.map((d) => d.observedAt).sort()[0]!,
    deliveryIds: group.map((d) => d.id),
    sourceIds: [...new Set(group.map((d) => d.sourceId))].sort(),
    independenceGroups: [...new Set(group.map((d) => d.independenceGroup))].sort(),
    possibleDependency: group.length > 1,
    confirmedFacts: 0,
  }));
  const view = NewsDuplicateViewSchema.parse({
    schemaVersion: 'news-duplicate-view.v1',
    decisionAt,
    groups,
  });
  deepFreeze(view);
  return view;
}
export function validateRestoredItem(item: ParsedNewsItem, source: NewsSource) {
  const { schemaVersion, contentHash, ...content } = item;
  if (
    schemaVersion !== 'parsed-news-item.v1' ||
    canonicalHash(content) !== contentHash ||
    (item.approvedSnippet !== null &&
      (!source.allowedFields.includes('snippet') ||
        !source.licensing.permitsSnippet ||
        item.approvedSnippet.length > source.licensing.maxSnippetChars))
  )
    throw new Error('Invalid retained news metadata');
  if (
    (!source.allowedFields.includes('publishedAt') &&
      (item.publishedAt !== null || item.rawPublishedAt !== null)) ||
    (!source.allowedFields.includes('updatedAt') &&
      (item.updatedAt !== null || item.rawUpdatedAt !== null)) ||
    !source.languages.some((l) => l === item.language || l === item.language.split('-')[0])
  )
    throw new Error('Retained metadata exceeds policy');
}
