import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename, dirname, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NewsPollConfigSchema, utcNanoseconds } from '@crypto/contracts';
import type { NewsPollConfig, NewsSource } from '@crypto/contracts';
import { MockClock, canonicalHash, utc } from '@crypto/core';
import {
  FixtureNewsProvider,
  newsFixtureRegistry,
  byteHash,
  NewsHttpError,
  NewsIngestError,
  newsRetryAfter,
  liveNewsConfig,
  parseLiveNewsCapture,
  parseNewsCapture,
  parseNewsTimestamp,
} from '@crypto/connectors';
import type { LiveNewsReader } from '@crypto/connectors';
import { NewsPollJournal, NewsPoller, canonicalNewsUrl, newsDuplicateView } from '@crypto/news';

const directories: string[] = [],
  journals: NewsPollJournal[] = [];
const fixtureProvider = new FixtureNewsProvider();
async function temporary() {
  const path = await mkdtemp(join(tmpdir(), 'crypto-news-poll-'));
  directories.push(path);
  return path;
}
afterEach(async () => {
  for (const journal of journals.splice(0)) await journal.close();
  for (const path of directories.splice(0)) {
    if (
      dirname(resolve(path)) !== resolve(tmpdir()) ||
      !basename(path).startsWith('crypto-news-poll-')
    )
      throw new Error('Unsafe cleanup');
    await rm(path, { recursive: true, force: true });
  }
});
async function config() {
  const registry = await newsFixtureRegistry();
  for (const source of registry.sources) {
    source.polling = { minIntervalSeconds: 1, maxRequestsPerDay: 10 };
    source.updateCadenceSeconds = 1;
  }
  return NewsPollConfigSchema.parse({
    schemaVersion: 'news-poll-config.v1',
    registry,
    gates: registry.sources.map((s) => ({
      sourceId: s.id,
      role: 'FIXTURE',
      reviewedAt: s.knownAt,
      expiresAt: '2026-01-10T00:00:00Z',
      references: ['https://example.invalid/locally-authored'],
      rationale: 'Synthetic test policy',
      citation: 'Locally authored synthetic fixtures',
    })),
    maxAttempts: 3,
    baseBackoffMs: 1000,
    maxBackoffMs: 10000,
    minGlobalIntervalMs: 250,
  });
}
async function acquire(directory: string, cfg: NewsPollConfig) {
  const journal = await NewsPollJournal.acquire(directory, cfg, 'synthetic-poll-test.v1');
  journals.push(journal);
  return journal;
}
function reader(
  clock: MockClock,
  choose: (source: NewsSource, call: number) => string = () => 'official-v1',
  transform?: (raw: string, source: NewsSource, call: number) => string,
) {
  let calls = 0;
  return {
    read: vi.fn<LiveNewsReader['read']>(async (source) => {
      calls++;
      const captured = await fixtureProvider.read({ fixtureId: choose(source, calls), source });
      const raw = transform ? transform(captured.raw, source, calls) : captured.raw;
      clock.advanceBy(5n, 'milliseconds');
      return {
        ...captured,
        raw,
        rawHash: byteHash(raw),
        observedAt: clock.now(),
        processedAt: clock.now(),
      };
    }),
  };
}

describe('news poll scheduling and durable quotas', () => {
  it('records actual first receipt, parser availability, exact latency and updated versions', async () => {
    const cfg = await config(),
      clock = new MockClock('2026-01-01T00:01:00Z'),
      transport = reader(clock, (_s, n) => (n === 1 ? 'official-v1' : 'official-v2'));
    const journal = await acquire(await temporary(), cfg),
      poller = new NewsPoller(journal, transport, clock);
    expect(await poller.step(['fixture:official'])).toBe(true);
    const first = poller.store.state().documents[0]!;
    expect(first.document.firstObservedAt).toBe(utc('2026-01-01T00:01:00.005Z'));
    expect(first.document.publishedAt).toBe(utc('2026-01-01T00:00:00Z'));
    expect(journal.records[1]?.action).toMatchObject({
      kind: 'SUCCEEDED',
      networkLatencyNs: '5000000',
      processingLatencyNs: '0',
    });
    expect(await poller.step(['fixture:official'])).toBe(false);
    clock.advanceBy(1000n, 'milliseconds');
    await poller.step(['fixture:official']);
    const versions = poller.store.state().documents;
    expect(versions.map((v) => v.revision)).toEqual([1, 2]);
    expect(versions[1]?.document.firstObservedAt).toBe(first.document.firstObservedAt);
    expect(poller.report().deliveries).toBe(2);
  });
  it('preserves documents and first-seen state across restart with hash-only bodies', async () => {
    const cfg = await config(),
      source = cfg.registry.sources.find((s) => s.id === 'fixture:official')!;
    source.allowedFields = source.allowedFields.filter((f) => f !== 'snippet');
    source.licensing.permitsRawStorage = false;
    source.licensing.permitsSnippet = false;
    source.licensing.maxSnippetChars = 0;
    const directory = await temporary(),
      clock = new MockClock('2026-01-01T00:01:00Z'),
      transport = reader(clock),
      journal = await acquire(directory, cfg),
      poller = new NewsPoller(journal, transport, clock);
    await poller.step(['fixture:official']);
    const stateHash = poller.report().stateHash,
      firstSeen = poller.deliveries[0]!.observedAt;
    expect(await readFile(join(directory, 'poll.jsonl'), 'utf8')).not.toContain(
      'Locally invented security statement',
    );
    await journal.close();
    const resumed = new NewsPoller(await acquire(directory, cfg), transport, clock);
    expect(resumed.report().stateHash).toBe(stateHash);
    expect(resumed.deliveries[0]?.observedAt).toBe(firstSeen);
    expect(await resumed.step(['fixture:official'])).toBe(false);
    clock.advanceBy(1000n, 'milliseconds');
    await resumed.step(['fixture:official']);
    expect(resumed.store.state().documents).toHaveLength(1);
    expect(resumed.deliveries).toHaveLength(2);
  });
  it('honors 429 cooldown across restart without a hot retry loop', async () => {
    const cfg = await config(),
      directory = await temporary(),
      clock = new MockClock('2026-01-01T00:01:00Z');
    const transport = {
      read: vi.fn<LiveNewsReader['read']>().mockRejectedValue(new NewsHttpError(429, true, 60000)),
    };
    const journal = await acquire(directory, cfg),
      poller = new NewsPoller(journal, transport, clock);
    await poller.step(['fixture:official']);
    expect(transport.read).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 5; i++) expect(await poller.step(['fixture:official'])).toBe(false);
    await journal.close();
    const resumed = new NewsPoller(await acquire(directory, cfg), transport, clock);
    clock.advanceBy(59999n, 'milliseconds');
    expect(await resumed.step(['fixture:official'])).toBe(false);
    clock.advanceBy(1n, 'milliseconds');
    expect(await resumed.step(['fixture:official'])).toBe(true);
    expect(transport.read).toHaveBeenCalledTimes(2);
  });
  it('caps retries with exponential backoff and retains dead letters without automatic replay', async () => {
    const cfg = await config(),
      clock = new MockClock('2026-01-01T00:01:00Z'),
      transport = {
        read: vi.fn<LiveNewsReader['read']>().mockRejectedValue(new NewsIngestError('NETWORK')),
      };
    const poller = new NewsPoller(await acquire(await temporary(), cfg), transport, clock);
    await poller.step(['fixture:official']);
    clock.advanceBy(1000n, 'milliseconds');
    await poller.step(['fixture:official']);
    clock.advanceBy(1999n, 'milliseconds');
    expect(await poller.step(['fixture:official'])).toBe(false);
    clock.advanceBy(1n, 'milliseconds');
    await poller.step(['fixture:official']);
    expect(poller.report().deadLetters).toHaveLength(1);
    expect(transport.read).toHaveBeenCalledTimes(3);
    clock.advanceBy(3600n, 'seconds');
    expect(await poller.step(['fixture:official'])).toBe(false);
  });
  it('does not shorten server cooldowns to the configured exponential-backoff cap', async () => {
    const cfg = await config(),
      clock = new MockClock('2026-01-01T00:01:00Z'),
      transport = {
        read: vi
          .fn<LiveNewsReader['read']>()
          .mockRejectedValue(new NewsHttpError(429, true, 120000)),
      };
    const poller = new NewsPoller(await acquire(await temporary(), cfg), transport, clock);
    await poller.step(['fixture:official']);
    expect(poller.report().jobs.find((j) => j.sourceId === 'fixture:official')?.nextAt).toBe(
      utc('2026-01-01T00:03:00Z'),
    );
  });
  it('preserves a rolling 24-hour quota across restart and counts failed requests', async () => {
    const cfg = await config();
    cfg.registry.sources.find((s) => s.id === 'fixture:official')!.polling.maxRequestsPerDay = 1;
    const clock = new MockClock('2026-01-01T00:01:00Z'),
      transport = reader(clock),
      directory = await temporary(),
      journal = await acquire(directory, cfg),
      poller = new NewsPoller(journal, transport, clock);
    await poller.step(['fixture:official']);
    const last = clock.now();
    await journal.close();
    const resumed = new NewsPoller(await acquire(directory, cfg), transport, clock);
    clock.advanceBy(86399999n, 'milliseconds');
    expect(await resumed.step(['fixture:official'])).toBe(false);
    clock.advanceBy(1n, 'milliseconds');
    expect(await resumed.step(['fixture:official'])).toBe(true);
    expect(utcNanoseconds(clock.now()) - utcNanoseconds(last)).toBe(86400005000000n);
  });
  it('accounts for a reserved request interrupted before a result was persisted', async () => {
    const cfg = await config(),
      clock = new MockClock('2026-01-01T00:01:00Z'),
      directory = await temporary(),
      journal = await acquire(directory, cfg);
    await journal.append({
      kind: 'RESERVED',
      sourceId: 'fixture:official',
      cycleId: 'synthetic-cycle',
      attempt: 1,
      at: clock.now(),
    });
    await journal.close();
    const transport = reader(clock),
      resumedJournal = await acquire(directory, cfg),
      resumed = new NewsPoller(resumedJournal, transport, clock);
    await resumed.recoverInterrupted();
    expect(resumedJournal.records.at(-1)?.action).toMatchObject({
      kind: 'FAILED',
      reason: 'INTERRUPTED',
    });
    expect(await resumed.step(['fixture:official'])).toBe(false);
    clock.advanceBy(1000n, 'milliseconds');
    await resumed.step(['fixture:official']);
    expect(resumedJournal.records[2]?.action).toMatchObject({
      kind: 'RESERVED',
      attempt: 2,
      cycleId: 'synthetic-cycle',
    });
  });
  it.each([403, 451, 302])(
    'halts restricted/redirected source %i without retry',
    async (status) => {
      const cfg = await config(),
        clock = new MockClock('2026-01-01T00:01:00Z'),
        transport = {
          read: vi
            .fn<LiveNewsReader['read']>()
            .mockRejectedValue(new NewsHttpError(status, false, null)),
        };
      const poller = new NewsPoller(await acquire(await temporary(), cfg), transport, clock);
      await poller.step(['fixture:official']);
      expect(poller.report().deadLetters).toHaveLength(1);
      clock.advanceBy(600n, 'seconds');
      expect(await poller.step(['fixture:official'])).toBe(false);
    },
  );
  it('fails closed on expired approval, unknown sources and clock regression', async () => {
    const cfg = await config(),
      clock = new MockClock('2026-01-01T00:01:00Z'),
      transport = reader(clock),
      journal = await acquire(await temporary(), cfg),
      poller = new NewsPoller(journal, transport, clock);
    await expect(poller.step(['unknown'])).rejects.toThrow();
    expect(transport.read).not.toHaveBeenCalled();
    await poller.step(['fixture:official']);
    const backwards = new NewsPoller(journal, transport, {
      now: () => utc('2026-01-01T00:00:01Z'),
    });
    await expect(backwards.step(['fixture:official'])).rejects.toThrow();
    clock.advanceTo('2026-01-10T00:00:00Z');
    await expect(poller.step(['fixture:official'])).rejects.toThrow();
  });
  it('retains malformed feed failure without publishing partial documents', async () => {
    const cfg = await config(),
      clock = new MockClock('2026-01-01T00:01:00Z'),
      transport = reader(clock, () => 'malformed-xml'),
      poller = new NewsPoller(await acquire(await temporary(), cfg), transport, clock);
    await poller.step(['fixture:official']);
    expect(poller.store.state().documents).toHaveLength(0);
    expect(poller.report().deadLetters[0]).toMatchObject({ reason: 'FORMAT' });
  });
});

describe('occurrence-preserving news dependency evidence', () => {
  it('canonicalizes tracking and fragment aliases while retaining publisher identifiers', () => {
    expect(canonicalNewsUrl('https://example.com/a?z=2&utm_source=copy&id=7&a=1#comments')).toBe(
      'https://example.com/a?a=1&id=7&z=2',
    );
    expect(canonicalNewsUrl('https://example.com/a?id=7')).not.toBe(
      canonicalNewsUrl('https://example.com/a?id=8'),
    );
    expect(() => canonicalNewsUrl('http://example.com/a')).toThrow();
  });
  it('keeps syndicated occurrences and attributes sources without counting independent facts', async () => {
    const cfg = await config(),
      synd = cfg.registry.sources.find((s) => s.id === 'fixture:syndicated')!;
    synd.articleOrigins.push('https://official.example.invalid');
    synd.independenceGroup = 'owner:synthetic-security';
    const clock = new MockClock('2026-01-01T00:01:00Z'),
      transport = reader(
        clock,
        (s) => (s.id === 'fixture:official' ? 'official-v1' : 'syndicated'),
        (raw, s) =>
          s.id === 'fixture:official'
            ? raw
            : raw.replace(
                'https://synd.example.invalid/copies/1',
                'https://official.example.invalid/notices/1?utm_source=synd',
              ),
      );
    const poller = new NewsPoller(await acquire(await temporary(), cfg), transport, clock);
    await poller.step(['fixture:official']);
    const before = clock.now();
    clock.advanceBy(250n, 'milliseconds');
    await poller.step(['fixture:syndicated']);
    expect(poller.store.state().documents).toHaveLength(2);
    expect(poller.deliveries).toHaveLength(2);
    const view = poller.report().duplicateView;
    expect(view.groups).toHaveLength(1);
    expect(view.groups[0]).toMatchObject({
      sourceIds: ['fixture:official', 'fixture:syndicated'],
      confirmedFacts: 0,
      possibleDependency: true,
    });
    expect(view.groups[0]?.independenceGroups).toHaveLength(1);
    expect(newsDuplicateView(poller.deliveries, before).groups[0]?.deliveryIds).toHaveLength(1);
  });
  it('retains provider ID aliases and possible text matches as separate deliveries', async () => {
    const cfg = await config(),
      clock = new MockClock('2026-01-01T00:01:00Z'),
      transport = reader(
        clock,
        () => 'official-v1',
        (raw, _s, n) =>
          n === 1
            ? raw
            : raw.replace('security-1', 'security-2').replace('/notices/1', '/notices/2'),
      );
    const poller = new NewsPoller(await acquire(await temporary(), cfg), transport, clock);
    await poller.step(['fixture:official']);
    clock.advanceBy(1000n, 'milliseconds');
    await poller.step(['fixture:official']);
    expect(poller.store.state().documents).toHaveLength(2);
    expect(poller.report().duplicateView.groups).toHaveLength(1);
    expect(poller.deliveries[0]?.entityId).not.toBe(poller.deliveries[1]?.entityId);
  });
  it('permits tracking-only URL changes on an update while preserving original URLs', async () => {
    const cfg = await config(),
      clock = new MockClock('2026-01-01T00:01:00Z'),
      transport = reader(
        clock,
        () => 'official-v1',
        (raw, _s, n) => (n === 1 ? raw : raw.replace('/notices/1', '/notices/1?utm_medium=feed')),
      );
    const poller = new NewsPoller(await acquire(await temporary(), cfg), transport, clock);
    await poller.step(['fixture:official']);
    clock.advanceBy(1000n, 'milliseconds');
    await poller.step(['fixture:official']);
    expect(poller.store.state().documents).toHaveLength(2);
    expect(poller.deliveries.map((d) => d.originalUrl)).not.toEqual(
      poller.deliveries.map((d) => d.canonicalUrl),
    );
    expect(poller.report().duplicateView.groups).toHaveLength(1);
  });
  it('does not durably accept a conflicting same-ID URL as a successful capture', async () => {
    const cfg = await config(),
      clock = new MockClock('2026-01-01T00:01:00Z'),
      transport = reader(
        clock,
        () => 'official-v1',
        (raw, _s, n) => (n === 1 ? raw : raw.replace('/notices/1', '/notices/different')),
      );
    const journal = await acquire(await temporary(), cfg),
      poller = new NewsPoller(journal, transport, clock);
    await poller.step(['fixture:official']);
    clock.advanceBy(1000n, 'milliseconds');
    await poller.step(['fixture:official']);
    expect(poller.report().deadLetters).toHaveLength(1);
    expect(journal.records.at(-1)?.action.kind).toBe('FAILED');
    expect(poller.store.state().documents).toHaveLength(1);
    expect(() => new NewsPoller(journal, transport, clock)).not.toThrow();
  });
});

describe('journal integrity and live enable gates', () => {
  it('versions the live parser and preserves unparseable dates as uncertainty without backdating', async () => {
    const cfg = await config(),
      source = cfg.registry.sources.find((s) => s.id === 'fixture:official')!;
    const original = await fixtureProvider.read({ fixtureId: 'official-v1', source });
    const raw = original.raw.replace('+0300', '-0000'),
      capture = { ...original, raw, rawHash: byteHash(raw) };
    expect(parseNewsCapture(source, capture).rejected[0]?.reason).toBe('TIMESTAMP');
    const parsed = parseLiveNewsCapture(source, capture);
    expect(parsed.schemaVersion).toBe('news-parse-result.v2');
    expect(parsed.items[0]).toMatchObject({ publishedAt: null, timestampStatus: 'UNCERTAIN' });
    expect(parsed.items[0]?.rawPublishedAt).toContain('-0000');
    // Synthetic feed with the two-digit year shape observed in the public CISA smoke.
    const shortYearRaw = original.raw.replace(
      /<pubDate>[^<]+<\/pubDate>/,
      '<pubDate>Fri, 30 Oct 26 12:00:00 +0000</pubDate>',
    );
    const shortYear = parseLiveNewsCapture(source, {
      ...original,
      raw: shortYearRaw,
      rawHash: byteHash(shortYearRaw),
    });
    expect(shortYear.rejected).toHaveLength(0);
    expect(shortYear.items[0]).toMatchObject({
      publishedAt: null,
      rawPublishedAt: 'Fri, 30 Oct 26 12:00:00 +0000',
      timestampStatus: 'UNCERTAIN',
    });
    const clock = new MockClock('2026-01-01T00:01:00Z'),
      transport = reader(
        clock,
        () => 'official-v1',
        (r) => r.replace('+0300', '-0000'),
      );
    const poller = new NewsPoller(await acquire(await temporary(), cfg), transport, clock);
    await poller.step(['fixture:official']);
    expect(poller.store.state().schemaVersion).toBe('news-store.v2');
    expect(poller.store.state().documents[0]?.document.publishedAt).toBeUndefined();
    expect(poller.store.state().documents[0]?.document.availableAt).toBe(clock.now());
    expect(poller.report().uncertainTimestamps).toBe(1);
  });
  it('uses only RFC-defined named timezone offsets in the live profile', () => {
    expect(parseNewsTimestamp('Fri, 30 Oct 2026 12:00:00 EDT', true)).toBe(
      utc('2026-10-30T16:00:00Z'),
    );
    expect(parseNewsTimestamp('Fri, 30 Oct 2026 12:00:00 EST', true)).toBe(
      utc('2026-10-30T17:00:00Z'),
    );
    expect(() => parseNewsTimestamp('Fri, 30 Oct 2026 12:00:00 MSK', true)).toThrow();
    expect(() => parseNewsTimestamp('Fri, 30 Oct 2026 12:00:00 -0000', true)).toThrow();
  });
  it('exclusively locks a session, detects tampering/truncation and refuses policy changes', async () => {
    const cfg = await config(),
      directory = await temporary(),
      journal = await acquire(directory, cfg);
    await expect(NewsPollJournal.acquire(directory, cfg, 'other-code')).rejects.toThrow();
    const clock = new MockClock('2026-01-01T00:01:00Z');
    await new NewsPoller(journal, reader(clock), clock).step(['fixture:official']);
    await journal.close();
    const path = join(directory, 'poll.jsonl'),
      body = await readFile(path, 'utf8');
    await expect(
      NewsPollJournal.acquire(directory, { ...cfg, maxAttempts: 2 }, 'test'),
    ).rejects.toThrow();
    await writeFile(path, body.replace('official', 'tampered'));
    await expect(NewsPollJournal.acquire(directory, cfg, 'test')).rejects.toThrow();
    await writeFile(path, body.slice(0, -1));
    await expect(NewsPollJournal.acquire(directory, cfg, 'test')).rejects.toThrow();
  });
  it('respects seconds/date Retry-After and refuses unbounded cooldowns', () => {
    expect(newsRetryAfter('120', 0)).toBe(120000);
    expect(
      newsRetryAfter('Thu, 01 Jan 2026 00:01:00 GMT', Date.parse('2026-01-01T00:00:00Z')),
    ).toBe(60000);
    expect(newsRetryAfter(undefined, 0)).toBe(60000);
    expect(() => newsRetryAfter('999999999', 0)).toThrow();
  });
  it('declares two fixed live sources, no snippets/raw storage and a shared issuer group', () => {
    const cfg = liveNewsConfig();
    expect(cfg.registry.sources).toHaveLength(2);
    expect(new Set(cfg.registry.sources.map((s) => s.independenceGroup)).size).toBe(1);
    expect(
      cfg.registry.sources.every(
        (s) => !s.licensing.permitsRawStorage && !s.licensing.permitsSnippet,
      ),
    ).toBe(true);
    expect(cfg.gates.map((g) => g.role)).toEqual(['OFFICIAL', 'AGGREGATION']);
    expect(canonicalHash(cfg)).toMatch(/^sha256:/);
  });
  it('rejects CLI live calls without the enable flag and refuses arbitrary endpoints', async () => {
    const execute = promisify(execFile);
    for (const flags of [[], ['--url', 'sensitive-input'], ['--enable-aggregation']])
      await expect(
        execute(process.execPath, ['--import', 'tsx', 'apps/cli/src/news.ts', 'poll', ...flags]),
      ).rejects.toThrow();
  });
});
