import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { NewsCaptureSchema, NewsRegistrySchema, NewsSourceSchema } from '@crypto/contracts';
import type { NewsCapture } from '@crypto/contracts';
import {
  byteHash,
  FixtureNewsProvider,
  isPublicNewsAddress,
  newsFixtureRegistry,
  newsHttpTarget,
  newsHttpsUrl,
  parseNewsCapture,
  parseNewsTimestamp,
  readNewsHttps,
} from '@crypto/connectors';
import { canonicalHash, utc } from '@crypto/core';
import { NewsIngestStore, NewsRegistry } from '@crypto/news';

const provider = new FixtureNewsProvider();
async function fixture(id = 'official-v1') {
  const registry = await newsFixtureRegistry(),
    entry = (await provider.list()).find((v) => v.id === id)!;
  const source = new NewsRegistry(registry).source(entry.sourceId, entry.observedAt);
  return { registry, source, capture: await provider.read({ fixtureId: id, source }) };
}
function changed(capture: NewsCapture, raw: string): NewsCapture {
  return NewsCaptureSchema.parse({ ...capture, raw, rawHash: byteHash(raw) });
}
async function allFixtures() {
  const store = new NewsIngestStore(await newsFixtureRegistry());
  for (const entry of await provider.list())
    store.ingest(
      await provider.read({
        fixtureId: entry.id,
        source: store.registry.source(entry.sourceId, entry.observedAt),
      }),
    );
  return store;
}
async function liveSource() {
  const { source } = await fixture();
  return NewsSourceSchema.parse({
    ...source,
    accessMethod: 'PUBLIC_HTTPS',
    providerId: 'test-rss',
    licensing: { ...source.licensing, policy: 'METADATA_ONLY', approvedForLive: true },
  });
}
function fakeHttp(
  body: string,
  statusCode = 200,
  headers: Record<string, string> = { 'content-type': 'application/rss+xml' },
) {
  let captured: RequestOptions | undefined;
  const client = new EventEmitter();
  const response = Object.assign(new PassThrough(), { statusCode, headers });
  Object.assign(client, {
    end: () => undefined,
    destroy: () => {
      client.emit('close');
    },
  });
  const transport = vi.fn(
    (_url: URL, options: RequestOptions, onResponse: (response: IncomingMessage) => void) => {
      captured = options;
      queueMicrotask(() => {
        onResponse(response as unknown as IncomingMessage);
        response.end(body);
        client.emit('close');
      });
      return client as unknown as ClientRequest;
    },
  );
  return { transport, options: () => captured };
}

describe('declarative source registry', () => {
  it('contains disabled optional adapters, source licensing and dependency groups', async () => {
    const registry = await newsFixtureRegistry();
    expect(registry.providers.filter((p) => p.enabled).map((p) => p.kind)).toEqual(['FIXTURE']);
    expect(registry.providers.some((p) => p.kind === 'GDELT' && !p.enabled)).toBe(true);
    const group = registry.sources.filter((s) => s.independenceGroup === 'wire:synthetic-report');
    expect(group.map((s) => s.publicationType)).toEqual(['INDEPENDENT_REPORTING', 'SYNDICATED']);
    expect(registry.sources.every((s) => s.licensing.approvedForLive === false)).toBe(true);
  });
  it('rejects unknown feeds and unobserved source versions by default', async () => {
    const { registry, source, capture } = await fixture(),
      store = new NewsIngestStore(registry);
    expect(() => store.registry.feed('https://unknown.example/feed', capture.observedAt)).toThrow();
    expect(() => store.registry.source(source.id, utc('2025-12-31T23:59:59Z'))).toThrow();
    expect(() => store.ingest({ ...capture, sourceId: 'unknown' })).toThrow();
    expect(() => store.ingest({ ...capture, feedUrl: source.feedUrl + '?another=1' })).toThrow();
    expect(() => store.ingest({ ...capture, sourceVersion: 99 })).toThrow();
  });
  it('rejects inconsistent licensing, duplicate versions and provider/source mismatches', async () => {
    const { registry, source } = await fixture();
    expect(
      NewsSourceSchema.safeParse({
        ...source,
        licensing: { ...source.licensing, permitsSnippet: false },
      }).success,
    ).toBe(false);
    expect(
      () => new NewsRegistry({ ...registry, sources: [...registry.sources, source] }),
    ).toThrow();
    expect(
      () => new NewsRegistry({ ...registry, sources: [{ ...source, providerId: 'unknown' }] }),
    ).toThrow();
    expect(
      () =>
        new NewsRegistry({
          ...registry,
          sources: [{ ...source, feedUrl: 'https://localhost/feed' }],
        }),
    ).toThrow();
    expect(
      () =>
        new NewsRegistry({
          ...registry,
          sources: [{ ...source, articleOrigins: ['https://official.example.invalid/articles'] }],
        }),
    ).toThrow();
    expect(NewsRegistrySchema.safeParse({ ...registry, apiKey: 'no' }).success).toBe(false);
  });
  it('keeps old source policy visible before a later revision and refuses policy races', async () => {
    const { registry, source, capture } = await fixture();
    const next = {
      ...source,
      version: 2,
      knownAt: utc('2026-01-01T00:01:00.500Z'),
      reliabilityNotes: 'Updated synthetic policy',
    };
    const store = new NewsIngestStore({ ...registry, sources: [...registry.sources, next] });
    expect(store.registry.source(source.id, capture.observedAt).version).toBe(1);
    expect(() => store.ingest(capture)).toThrow();
  });
});

describe('bounded XML/JSON fixture parsing and temporal evidence', () => {
  it('normalizes RSS/Atom timezone offsets, language and sub-millisecond updates', async () => {
    const rss = await fixture(),
      atom = await fixture('independent');
    expect(parseNewsCapture(rss.source, rss.capture).items[0]?.publishedAt).toBe(
      utc('2026-01-01T00:00:00Z'),
    );
    const parsed = parseNewsCapture(atom.source, atom.capture);
    expect(parsed.items.map((v) => v.language)).toEqual(['ru', 'en']);
    expect(parsed.items[0]?.updatedAt).toBe(utc('2026-01-01T00:01:30.123456789Z'));
    expect(parsed.items[1]?.publishedAt).toBe(null);
    expect(parsed.items[1]?.timestampStatus).toBe('MISSING');
  });
  it('preserves updated headlines, first observation, hash and prior point-in-time views', async () => {
    const store = await allFixtures(),
      versions = store.state().documents.filter((d) => d.document.sourceId === 'fixture:official');
    expect(versions.map((v) => v.revision)).toEqual([1, 2]);
    expect(versions[0]?.document.firstObservedAt).toBe(versions[1]?.document.firstObservedAt);
    expect(versions[0]?.contentHash).not.toBe(versions[1]?.contentHash);
    expect(versions[1]?.previousVersionId).toBe(versions[0]?.versionId);
    expect(
      store
        .documentsAt({ decisionAt: '2026-01-01T00:05:00Z', mode: 'ELIGIBLE' })
        .find((v) => v.publicationType === 'OFFICIAL_SECURITY')?.revision,
    ).toBe(1);
    expect(
      store
        .documentsAt({ decisionAt: '2026-01-01T00:05:01Z', mode: 'ELIGIBLE' })
        .find((v) => v.publicationType === 'OFFICIAL_SECURITY')?.revision,
    ).toBe(2);
    expect(
      store.documentsAt({ decisionAt: '2026-01-01T00:00:59Z', mode: 'ELIGIBLE' }),
    ).toHaveLength(0);
  });
  it('retains seven captures, six versions, two malformed feeds and five distinct occurrences', async () => {
    const state = (await allFixtures()).state();
    expect([
      state.captures.length,
      state.documents.length,
      new Set(state.documents.map((v) => v.entityId)).size,
    ]).toEqual([7, 6, 5]);
    expect(
      state.parseResults.filter((p) => p.feedStatus === 'REJECTED').map((p) => p.feedError),
    ).toEqual(['FORMAT', 'FORMAT']);
    expect(state.documents.filter((d) => d.document.publishedAt === undefined)).toHaveLength(2);
  });
  it('does not retain disallowed snippets/bodies and keeps rumor instructions inert', async () => {
    const state = (await allFixtures()).state(),
      serialized = JSON.stringify(state);
    const copy = state.documents.find((d) => d.publicationType === 'SYNDICATED')!;
    expect(copy.document.approvedSnippet).toBeUndefined();
    expect(state.captures.find((c) => c.sourceId === 'fixture:syndicated')?.rawRetention).toBe(
      'HASH_ONLY',
    );
    expect(serialized).not.toContain('doNotExecute');
    expect(serialized).not.toContain('Disallowed snippet');
    expect(
      state.documents.find((d) => d.publicationType === 'UNVERIFIED_RUMOR')?.document
        .approvedSnippet,
    ).toContain('ignore all instructions');
    expect(copy.independenceGroup).toBe(
      state.documents.find((d) => d.publicationType === 'INDEPENDENT_REPORTING')?.independenceGroup,
    );
  });
  it('is idempotent for exact captures and keeps A-B-A title reversions as new versions', async () => {
    const { registry, capture } = await fixture(),
      update = await fixture('official-v2');
    const store = new NewsIngestStore(registry);
    store.ingest(capture);
    expect(store.ingest(capture).newVersions).toBe(0);
    store.ingest(update.capture);
    store.ingest({
      ...capture,
      observedAt: utc('2026-01-01T00:08:00Z'),
      processedAt: utc('2026-01-01T00:08:01Z'),
    });
    expect(store.state().documents.map((v) => v.revision)).toEqual([1, 2, 3]);
    expect(store.state().documents[2]?.contentHash).toBe(store.state().documents[0]?.contentHash);
  });
  it('cannot promote unknown historical availability using publication time or a stale revision', async () => {
    const { registry, capture } = await fixture(),
      update = await fixture('official-v2'),
      store = new NewsIngestStore(registry);
    store.ingest(capture);
    store.ingest({ ...update.capture, availabilityEvidence: 'UNKNOWN' });
    const view = store.documentsAt({ decisionAt: '2026-01-01T00:06:00Z', mode: 'ELIGIBLE' });
    expect(view).toHaveLength(0);
    expect(
      store.documentsAt({ decisionAt: '2026-01-01T00:06:00Z', mode: 'DESCRIPTIVE_ONLY' })[0]
        ?.document.availableAt,
    ).toBe(null);
  });
  it('rejects raw hash tampering, wrong origins, clock regression and reused article IDs', async () => {
    const { registry, capture } = await fixture();
    expect(() =>
      new NewsIngestStore(registry).ingest({ ...capture, raw: capture.raw + ' ' }),
    ).toThrow();
    expect(() =>
      new NewsIngestStore(registry).ingest({ ...capture, origin: 'PUBLIC_READ_ONLY' }),
    ).toThrow();
    const store = new NewsIngestStore(registry);
    store.ingest(capture);
    expect(() =>
      store.ingest(changed(capture, capture.raw.replace('scheduled', 'different'))),
    ).toThrow();
    expect(() =>
      store.ingest(changed(capture, capture.raw.replace('/notices/1', '/notices/2'))),
    ).toThrow();
  });
  it('rejects DTD/XXE, unknown entities, processing instructions and over-depth trees', async () => {
    const { source, capture } = await fixture();
    for (const raw of [
      '<!DOCTYPE rss [<!ENTITY leak SYSTEM "file:///secret">]><rss/>',
      '<?xml-stylesheet href="https://127.0.0.1/x"?><rss/>',
      capture.raw.replace('scheduled', '&unknown;'),
      '<rss>' + '<a>'.repeat(17) + '</a>'.repeat(17) + '</rss>',
    ])
      expect(parseNewsCapture(source, changed(capture, raw)).feedStatus).toBe('REJECTED');
  });
  it('rejects foreign article origins, invalid dates and unapproved languages per item', async () => {
    const { source, capture } = await fixture();
    for (const [raw, reason] of [
      [
        capture.raw.replace(
          'https://official.example.invalid/notices/1',
          'https://127.0.0.1/private',
        ),
        'ARTICLE_URL',
      ],
      [capture.raw.replace('+0300', 'MSK'), 'TIMESTAMP'],
      [capture.raw.replace('<language>en</language>', '<language>xx</language>'), 'LANGUAGE'],
    ] as const)
      expect(parseNewsCapture(source, changed(capture, raw)).rejected[0]?.reason).toBe(reason);
  });
  it('enforces payload/item limits and snippet truncation without partial feed acceptance', async () => {
    const { source, capture } = await fixture();
    expect(
      parseNewsCapture({ ...source, limits: { ...source.limits, maxBytes: 128 } }, capture)
        .feedError,
    ).toBe('LIMIT');
    const limited = { ...source, licensing: { ...source.licensing, maxSnippetChars: 10 } };
    expect(parseNewsCapture(limited, capture).items[0]?.approvedSnippet?.length).toBe(10);
    const duplicated = capture.raw.replace(
      '</channel>',
      capture.raw.match(/<item>.*<\/item>/s)![0] + '</channel>',
    );
    expect(
      parseNewsCapture(
        { ...source, limits: { ...source.limits, maxItems: 1 } },
        changed(capture, duplicated),
      ).feedError,
    ).toBe('LIMIT');
  });
  it('returns immutable detached registry/document views and deterministic state hashes', async () => {
    const one = await allFixtures(),
      two = await allFixtures();
    expect(canonicalHash(one.state())).toBe(canonicalHash(two.state()));
    expect(Object.isFrozen(one.state().documents[0]?.document)).toBe(true);
    expect(() => {
      one.state().documents[0]!.document.title = 'mutated';
    }).toThrow();
  });
  it('rejects every occurrence of a conflicting duplicate provider ID', async () => {
    const { source, capture } = await fixture();
    const duplicate = capture.raw.replace(
      '</channel>',
      capture.raw.match(/<item>.*<\/item>/s)![0].replace('scheduled', 'changed') + '</channel>',
    );
    const parsed = parseNewsCapture(source, changed(capture, duplicate));
    expect(parsed.items).toHaveLength(0);
    expect(parsed.rejected.map((r) => r.reason)).toEqual(['DUPLICATE_ID', 'DUPLICATE_ID']);
  });
  it('ignores disallowed JSON fields before validation and content hashing', async () => {
    const { source, capture } = await fixture('syndicated');
    const raw = JSON.parse(capture.raw) as { items: { summary: unknown }[] };
    raw.items[0]!.summary = { instruction: 'untrusted disallowed data' };
    const parsed = parseNewsCapture(source, changed(capture, JSON.stringify(raw)));
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]?.contentHash).toBe(
      parseNewsCapture(source, capture).items[0]?.contentHash,
    );
  });
});

describe('strict publication timestamps', () => {
  it.each([
    '2026-01-01T00:00:00',
    '2026-02-30T00:00:00Z',
    '2026-01-01T00:00:00-00:00',
    '2026-01-01T00:00:00+14:01',
    '01 Jan 2026 00:00:00 MSK',
    'Fri, 01 Jan 2026 00:00:00 GMT',
    '1 Jan 26 00:00:00 GMT',
  ])('refuses ambiguous/invalid time %s', (value) => {
    expect(() => parseNewsTimestamp(value)).toThrow();
  });
  it('normalizes explicit offsets and preserves nine-digit precision', () => {
    expect(parseNewsTimestamp('2026-01-01T03:00:00.123456789+03:00')).toBe(
      utc('2026-01-01T00:00:00.123456789Z'),
    );
    expect(parseNewsTimestamp('31 Dec 2025 19:00:00 -0500')).toBe(utc('2026-01-01T00:00:00Z'));
  });
});

describe('safe news HTTP boundary', () => {
  it.each([
    'http://example.com/feed',
    'https://localhost/feed',
    'https://127.0.0.1/feed',
    'https://2130706433/feed',
    'https://[::ffff:127.0.0.1]/feed',
    'https://user:pass@example.com/feed',
    'https://example.com:8443/feed',
    'https://example.com/feed#x',
    'https://example.com/%2e%2e/private',
    'https://example.com\\@127.0.0.1/feed',
  ])('blocks unsafe URL %s', (value) => {
    expect(() => newsHttpsUrl(value)).toThrow();
  });
  it.each([
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '192.168.1.1',
    '100.64.0.1',
    '198.18.0.1',
    '192.0.2.1',
    '224.0.0.1',
    '::1',
    '::ffff:8.8.8.8',
    'fe80::1',
    'fc00::1',
    '2001:db8::1',
    '2002:7f00:1::1',
  ])('blocks non-public or tunnel address %s', (value) => {
    expect(isPublicNewsAddress(value)).toBe(false);
  });
  it('requires live approval and rejects mixed/private DNS answers before connecting', async () => {
    const { source } = await fixture(),
      live = await liveSource(),
      lookup = vi.fn().mockResolvedValue([
        { address: '8.8.8.8', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ]);
    await expect(newsHttpTarget(source, lookup)).rejects.toThrow();
    expect(lookup).not.toHaveBeenCalled();
    await expect(newsHttpTarget(live, lookup)).rejects.toThrow();
    expect(isPublicNewsAddress('8.8.8.8')).toBe(true);
    expect(isPublicNewsAddress('2606:4700:4700::1111')).toBe(true);
  });
  it('pins the validated address, TLS hostname and fixed request headers', async () => {
    const live = await liveSource(),
      fake = fakeHttp('bounded synthetic feed'),
      lookup = vi.fn().mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
    expect(
      (
        await readNewsHttps(live, undefined, { resolve: lookup, request: fake.transport })
      ).toString(),
    ).toBe('bounded synthetic feed');
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(fake.options()).toMatchObject({
      method: 'GET',
      agent: false,
      rejectUnauthorized: true,
      servername: 'official.example.invalid',
      headers: { 'accept-encoding': 'identity' },
    });
    const pinned = fake.options()!.lookup!,
      callback = vi.fn();
    pinned('ignored-rebinding-host', { all: true }, callback);
    expect(callback).toHaveBeenCalledWith(null, [{ address: '8.8.8.8', family: 4 }]);
    expect(lookup).toHaveBeenCalledTimes(1);
  });
  it('rejects redirects, compression, content types and oversized streaming bodies', async () => {
    const live = await liveSource(),
      resolve = () => Promise.resolve([{ address: '8.8.8.8', family: 4 }]);
    for (const fake of [
      fakeHttp('', 302),
      fakeHttp('', 200, { 'content-type': 'text/html' }),
      fakeHttp('', 200, { 'content-type': 'application/rss+xml', 'content-encoding': 'gzip' }),
      fakeHttp('x'.repeat(32769)),
    ])
      await expect(
        readNewsHttps(live, undefined, { resolve, request: fake.transport }),
      ).rejects.toThrow();
  });
  it('bounds DNS and stalled HTTP requests and respects an already aborted caller', async () => {
    const live = await liveSource(),
      bounded = { ...live, limits: { ...live.limits, timeoutMs: 100 } };
    await expect(newsHttpTarget(bounded, () => new Promise(() => undefined))).rejects.toThrow();
    const controller = new AbortController();
    controller.abort();
    const fake = fakeHttp('never fetched');
    await expect(
      readNewsHttps(bounded, controller.signal, { request: fake.transport }),
    ).rejects.toThrow();
    expect(fake.transport).not.toHaveBeenCalled();
    const client = new EventEmitter();
    Object.assign(client, {
      end: () => undefined,
      destroy: () => {
        client.emit('close');
      },
    });
    await expect(
      readNewsHttps(bounded, undefined, {
        resolve: () => Promise.resolve([{ address: '8.8.8.8', family: 4 }]),
        request: () => client as unknown as ClientRequest,
      }),
    ).rejects.toThrow();
  });
  it('runs the fixture CLI and rejects unsupported endpoint flags without reflecting values', async () => {
    const execute = promisify(execFile),
      result = await execute(process.execPath, [
        '--import',
        'tsx',
        'apps/cli/src/news.ts',
        'fixtures',
      ]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      origin: 'SYNTHETIC',
      captures: 7,
      versions: 6,
      documentCount: 5,
      rejectedFeeds: 2,
    });
    let stderr = '';
    try {
      await execute(process.execPath, [
        '--import',
        'tsx',
        'apps/cli/src/news.ts',
        'fixtures',
        '--url',
        'sensitive-input',
      ]);
    } catch (error) {
      if (error && typeof error === 'object' && 'stderr' in error) stderr = String(error.stderr);
    }
    expect(stderr).toContain('News command failed');
    expect(stderr).not.toContain('sensitive-input');
  });
});
