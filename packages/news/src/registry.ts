import { NewsRegistrySchema, UtcTimestampSchema } from '@crypto/contracts';
import type { NewsSource, UtcTimestamp } from '@crypto/contracts';
import { canonicalJson, deepFreeze } from '@crypto/core';
import { NewsIngestError, validateNewsSourceUrls } from '@crypto/connectors';

export class NewsRegistry {
  #registry: ReturnType<typeof NewsRegistrySchema.parse>;
  constructor(input: unknown) {
    const registry = NewsRegistrySchema.parse(JSON.parse(canonicalJson(input)));
    if (new Set(registry.providers.map((p) => p.id)).size !== registry.providers.length)
      throw new NewsIngestError('REGISTRY');
    const identities = new Set<string>();
    for (const source of registry.sources) {
      const provider = registry.providers.find((p) => p.id === source.providerId);
      if (
        !provider ||
        provider.knownAt > source.knownAt ||
        (source.accessMethod === 'FIXTURE' && provider.kind !== 'FIXTURE') ||
        (source.accessMethod === 'PUBLIC_HTTPS' && provider.kind === 'FIXTURE')
      )
        throw new NewsIngestError('REGISTRY');
      validateNewsSourceUrls(source);
      const key = `${source.id}:${source.version}`;
      if (identities.has(key)) throw new NewsIngestError('REGISTRY');
      identities.add(key);
    }
    registry.providers.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    registry.sources.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.version - b.version));
    for (let i = 1; i < registry.sources.length; i++) {
      const prior = registry.sources[i - 1]!,
        next = registry.sources[i]!;
      if (
        prior.id === next.id &&
        (prior.knownAt >= next.knownAt || prior.providerId !== next.providerId)
      )
        throw new NewsIngestError('REGISTRY');
    }
    deepFreeze(registry);
    this.#registry = registry;
    Object.freeze(this);
  }
  snapshot() {
    return this.#registry;
  }
  source(sourceId: string, atInput: UtcTimestamp): NewsSource {
    const at = UtcTimestampSchema.parse(atInput);
    const source = this.#registry.sources
      .filter((s) => s.id === sourceId && s.knownAt <= at)
      .at(-1);
    const provider = this.#registry.providers.find((p) => p.id === source?.providerId);
    if (!source || !provider || !provider.enabled || provider.knownAt > at)
      throw new NewsIngestError('REGISTRY');
    return source;
  }
  feed(feedUrl: string, at: UtcTimestamp): NewsSource {
    const candidates = [...new Set(this.#registry.sources.map((s) => s.id))].flatMap((id) => {
      try {
        const source = this.source(id, at);
        return source.feedUrl === feedUrl ? [source] : [];
      } catch {
        return [];
      }
    });
    if (candidates.length !== 1) throw new NewsIngestError('REGISTRY');
    return candidates[0]!;
  }
}
