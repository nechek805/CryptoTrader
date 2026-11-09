import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { LiveNewsStore } from '../packages/db/src/live-news-store.js';
import { initialLiveNewsSources } from '../packages/news/src/live-source-catalog.js';
import { LiveNewsSourceInput } from '../packages/contracts/src/live-news.js';
import { buildLiveNewsApi } from '../apps/api/src/live-news-api.js';
import { createNewsQueues, reconcileNewsSchedules } from '../apps/api/src/live-news-queue.js';
import type { LiveNewsQueues } from '../apps/api/src/live-news-queue.js';
import type { LiveNewsSource } from '../packages/contracts/src/live-news.js';
import type { LiveFeedItem } from '../packages/connectors/src/live-news-feed.js';
import { collectLiveNews } from '../packages/news/src/live-news-collector.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  'live news PostgreSQL journal and permissions',
  () => {
    let store: LiveNewsStore, source: LiveNewsSource, now: number;
    const item: LiveFeedItem = {
      providerItemId: 'synthetic-1',
      title: 'Synthetic SOL fixture headline',
      url: 'https://news.example.test/one',
      excerpt: 'Synthetic evidence.',
      language: 'en',
      publishedAt: 1,
      publisherUpdatedAt: null,
      timestampStatus: 'VALID',
    };
    beforeEach(async () => {
      now = Date.now();
      store = new LiveNewsStore(
        process.env.TEST_DATABASE_URL!,
        'crypto_news_test_' + randomUUID().replaceAll('-', ''),
      );
      await store.migrate();
      source = {
        ...initialLiveNewsSources(now).find((s) => s.id === 'federal-reserve')!,
        id: 'fixture-source',
        name: 'Synthetic fixture source',
        independenceGroup: 'fixture-source',
        feedUrl: 'https://news.example.test/feed',
        articleOrigins: ['https://news.example.test'],
      };
      await store.seed([source]);
    });
    afterEach(async () => {
      await store.pool.query(`DROP SCHEMA ${store.schema} CASCADE`);
      await store.close();
    });
    async function ingest(time = now, input = item) {
      const claim = await store.claimPoll(source.id, source.revision, time);
      expect(claim).not.toBeNull();
      return store.completePoll(
        claim!,
        { items: [input], feedHash: 'synthetic-feed-hash', rejected: 0, fetchedAt: time + 1 },
        time + 2,
      );
    }
    it('collects the registered XRPL listing through the journal without overwriting operator settings on reseed', async () => {
      const xrpl = initialLiveNewsSources(now).find((s) => s.id === 'xrpl-blog')!;
      await store.seed([xrpl]);
      const transport = vi.fn().mockResolvedValue({
        status: 200,
        bytes: Buffer.from(
          '<html><h5><a href="/blog/2026/synthetic-update">Synthetic XRP protocol update</a></h5></html>',
        ),
      });
      expect(await collectLiveNews(store, xrpl.id, 1, transport)).toMatchObject({
        skipped: false,
        newVersions: 1,
        received: 1,
      });
      expect(transport).toHaveBeenCalledWith('https://xrpl.org/blog', {
        mime: ['text/html'],
        maxBytes: 2097152,
      });
      const page = await store.articles({ source: xrpl.id });
      expect(page.items[0]!.version).toMatchObject({
        publishedAt: null,
        captureKind: 'INITIAL_SNAPSHOT',
        independenceGroup: 'xrplf',
        excerpt: '',
      });
      await store.saveSource(
        xrpl.id,
        LiveNewsSourceInput.strip().parse({
          ...xrpl,
          enabled: false,
          notes: 'Synthetic operator choice',
        }),
        1,
      );
      await store.seed(initialLiveNewsSources(now));
      expect(await store.source(xrpl.id)).toMatchObject({
        revision: 2,
        enabled: false,
        notes: 'Synthetic operator choice',
      });
    });
    it('requires manual AI for undated initial archives while allowing newly observed undated updates', async () => {
      const [initial] = await ingest(now, {
        ...item,
        publishedAt: null,
        timestampStatus: 'MISSING',
      });
      const [live] = await ingest(now + 61000, {
        ...item,
        url: 'https://news.example.test/new',
        publishedAt: null,
        timestampStatus: 'MISSING',
      });
      expect(await store.pendingAi()).not.toContain(initial);
      expect(await store.pendingAi()).toContain(live);
      // Manual review remains available; it does not create a publication timestamp.
      const reservation = await store.reserveAi(
        initial!,
        'synthetic-profile',
        100,
        'fixture',
        now + 62000,
      );
      expect('requestId' in reservation).toBe(true);
    });
    it('deduplicates repeat polls and retains immutable revisions with original first seen', async () => {
      const first = await ingest();
      expect(first).toHaveLength(1);
      expect(await ingest(now + 61000)).toHaveLength(0);
      const revised = await ingest(now + 122000, {
        ...item,
        title: 'Synthetic revised SOL fixture headline',
      });
      expect(revised).toHaveLength(1);
      const versions = await store.versions((await store.version(first[0]!))!.articleId);
      expect(versions).toHaveLength(2);
      expect(versions[0]!.firstSeenAt).toBe(now + 1);
      expect(versions[0]!.availableAt).toBe(now + 122002);
      expect(versions[0]!.publishedAt).toBe(1);
      await expect(
        store.pool.query(`UPDATE ${store.schema}.article_versions SET revision=99`),
      ).rejects.toThrow('Immutable news evidence');
    });
    it('fences disabled or changed source generations and keeps their configuration history', async () => {
      const claim = await store.claimPoll(source.id, 1, now);
      expect(claim).not.toBeNull();
      const config = LiveNewsSourceInput.strip().parse({ ...source, enabled: false });
      await store.saveSource(source.id, config, 1);
      expect(
        await store.completePoll(
          claim!,
          { items: [item], feedHash: 'synthetic', rejected: 0, fetchedAt: now + 1 },
          now + 2,
        ),
      ).toEqual([]);
      expect((await store.articles({})).total).toBe(0);
      expect(await store.sourceHistory(source.id)).toHaveLength(2);
      expect(await store.claimPoll(source.id, 1, now + 90000)).toBeNull();
      await expect(store.saveSource(source.id, config, 1)).rejects.toThrow('SOURCE_CHANGED_RELOAD');
    });
    it('honors provider retry time and does not allow manual jobs to bypass it', async () => {
      const claim = await store.claimPoll(source.id, 1, now);
      await store.failPoll(claim!, 'HTTP_429', 429, 3600000, now + 1);
      expect(await store.claimPoll(source.id, 1, now + 3599999)).toBeNull();
      expect((await store.sources(now + 60000))[0]!.health).toMatchObject({
        lastError: 'HTTP_429',
        state: 'ERROR',
        requestsToday: 1,
      });
    });
    it('counts repeated publisher occurrences without declaring independent confirmation', async () => {
      await ingest();
      const second = { ...source, id: 'fixture-copy', independenceGroup: source.independenceGroup };
      await store.seed([second]);
      const claim = await store.claimPoll(second.id, 1, now);
      await store.completePoll(
        claim!,
        { items: [item], feedHash: 'synthetic-copy', rejected: 0, fetchedAt: now + 1 },
        now + 2,
      );
      const page = await store.articles({});
      expect(page.total).toBe(2);
      expect(page.items.every((a) => a.duplicateCount === 2)).toBe(true);
      expect(page.items.every((a) => a.analysis === null)).toBe(true);
    });
    it('reserves a durable daily AI budget and returns a committed success without another request', async () => {
      const [id] = await ingest(),
        [other] = await ingest(now + 61000, { ...item, url: 'https://news.example.test/two' });
      const first = await store.reserveAi(id!, 'fixture-profile', 1, 'fixture-input', now + 61010);
      expect('requestId' in first).toBe(true);
      expect(
        await store.reserveAi(other!, 'fixture-profile', 1, 'fixture-input', now + 61011),
      ).toMatchObject({ skip: 'DAILY_BUDGET' });
      if (!('requestId' in first)) throw new Error('Expected fixture reservation');
      await store.completeAi(id!, 'fixture-profile', {
        id: first.requestId,
        status: 'ANALYZED',
        result: {
          summary: 'Synthetic SOL fixture headline',
          assets: ['SOL'],
          eventType: 'OTHER',
          direction: 'UNCLEAR',
          severity: 'UNKNOWN',
          negated: false,
          evidenceQuotes: [item.title],
          uncertainties: [],
        },
        error: null,
        provider: 'synthetic://fixture',
        model: 'fixture',
        promptVersion: 'fixture',
        profileHash: 'fixture-profile',
        inputHash: 'fixture-input',
        responseHash: 'fixture-response',
        processedAt: now + 61012,
        availableAt: now + 61012,
        promptTokens: 1,
        completionTokens: 2,
        evidenceStatus: 'UNVERIFIED',
      });
      expect(
        await store.reserveAi(id!, 'fixture-profile', 1, 'fixture-input', now + 61013),
      ).toEqual({
        skip: 'ALREADY_ANALYZED',
      });
      expect(await store.aiBudget(now + 61013)).toBe(1);
    });
    it('protects source controls, rejects unsafe URLs and never returns credentials', async () => {
      const queues = {
        collect: { add: vi.fn().mockResolvedValue({ id: 'synthetic-job' }) },
        analyze: {},
      } as unknown as LiveNewsQueues;
      const security = {
        proxySecret: 'synthetic-proxy-000000000000000000000000',
        readerToken: 'synthetic-reader-0000000000000000000000',
        adminToken: 'synthetic-admin-00000000000000000000000',
        origins: ['https://workspace.example.test'],
      };
      const app = buildLiveNewsApi(store, queues, security);
      try {
        expect((await app.inject('/news/sources')).statusCode).toBe(401);
        const read = { authorization: 'Bearer ' + security.readerToken };
        const listed = await app.inject({ url: '/news/sources', headers: read });
        expect(listed.statusCode).toBe(200);
        expect(listed.body).not.toContain(security.proxySecret);
        const payload = LiveNewsSourceInput.strip().parse(source);
        expect(
          (
            await app.inject({
              url: '/news/sources',
              method: 'POST',
              headers: { ...read, origin: security.origins[0]! },
              payload,
            })
          ).statusCode,
        ).toBe(403);
        const admin = { 'x-crypto-proxy-auth': security.proxySecret, origin: security.origins[0]! };
        expect(
          (
            await app.inject({
              url: '/news/sources',
              method: 'POST',
              headers: { ...admin, origin: 'https://evil.test' },
              payload,
            })
          ).statusCode,
        ).toBe(403);
        expect(
          (
            await app.inject({
              url: '/news/sources',
              method: 'POST',
              headers: admin,
              payload: { ...payload, feedUrl: 'https://127.0.0.1/private' },
            })
          ).statusCode,
        ).toBe(400);
        expect(
          (await app.inject({ url: '/news/sources', method: 'POST', headers: admin, payload }))
            .statusCode,
        ).toBe(201);
      } finally {
        await app.close();
      }
    });
    it.skipIf(!process.env.TEST_REDIS_URL)(
      'persists one BullMQ scheduler per enabled source and removes disabled schedules',
      async () => {
        const suffix = randomUUID(),
          queues = createNewsQueues(process.env.TEST_REDIS_URL!, {
            collect: 'fixture-news-collect-' + suffix,
            analyze: 'fixture-news-analyze-' + suffix,
          });
        try {
          await reconcileNewsSchedules(store, queues);
          const first = await queues.collect.getJobSchedulers();
          expect(first).toHaveLength(1);
          await reconcileNewsSchedules(store, queues);
          const again = await queues.collect.getJobSchedulers();
          expect(again).toHaveLength(1);
          expect(again[0]!.next).toBe(first[0]!.next);
          await store.saveSource(
            source.id,
            LiveNewsSourceInput.strip().parse({ ...source, enabled: false }),
            1,
          );
          await reconcileNewsSchedules(store, queues);
          expect(await queues.collect.getJobSchedulers()).toHaveLength(0);
        } finally {
          await queues.collect.obliterate({ force: true });
          await queues.analyze.obliterate({ force: true });
          await queues.close();
        }
      },
      30000,
    );
  },
);
