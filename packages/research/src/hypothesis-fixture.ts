import {
  MarketBarSchema,
  HypothesisDatasetSchema,
  HypothesisCardContentSchema,
  HypothesisRegistryInputSchema,
  HypothesisRegistryRequestSchema,
} from '@crypto/contracts';
import type { HypothesisCard, NewsGraphRecord, HypothesisDataset } from '@crypto/contracts';
import { canonicalHash, MockClock, utc } from '@crypto/core';
import { byteHash, newsFixtureRegistry } from '@crypto/connectors';
import {
  NewsIngestStore,
  NewsReviewService,
  NewsClaimExtractor,
  DeterministicNewsClaimAdapter,
  defaultNewsExtractionConfig,
  NewsGraphService,
  NewsEventService,
  defaultNewsGraphConfig,
  defaultNewsEventConfig,
  buildNewsEventSnapshot,
} from '@crypto/news';
import { appendHypothesisCard } from './hypothesis-cards.js';
import { shift } from './event-control-math.js';

/** Locally authored fictional exchange incidents, rate announcements and listings. */
export async function hypothesisFixture() {
  const registry = await newsFixtureRegistry(),
    template = registry.sources[0]!,
    newsSnapshots: HypothesisDataset['newsSnapshots'] = [],
    marketBars: HypothesisDataset['marketBars'] = [],
    observations: HypothesisDataset['observations'] = [],
    cards: HypothesisCard[] = [],
    days = ['01', '02', '20', '21', '22'],
    topics = [
      {
        id: 'exchange',
        type: 'EXCHANGE_OUTAGE' as const,
        subject: 'Synthetic Exchange',
        phrase: 'exchange outage',
        hour: 9,
        percent: [-3, -2, -4, -2, -1],
        direction: 'DOWN' as const,
      },
      {
        id: 'rates',
        type: 'RATE_ANNOUNCEMENT' as const,
        subject: 'Synthetic Authority',
        phrase: 'rate announcement',
        hour: 12,
        percent: [0, 1, 0, 0, 0],
        direction: 'UP' as const,
      },
      {
        id: 'listings',
        type: 'LISTING' as const,
        subject: 'Synthetic Exchange',
        phrase: 'listing',
        hour: 15,
        percent: [2, 3, -1, 2, -3],
        direction: 'UP' as const,
      },
    ],
    series = {
      asset: 'ETH',
      exchange: 'synthetic:hypotheses',
      instrumentId: 'ETH/USDT',
      marketType: 'SPOT' as const,
    };
  for (const topic of topics) {
    const source = {
        ...template,
        id: `fixture:hypothesis:${topic.id}`,
        owner: `Synthetic ${topic.id} publisher`,
        independenceGroup: `synthetic:hypothesis:${topic.id}`,
        feedUrl: `https://${topic.id}.example.invalid/feed.xml`,
        articleOrigins: [`https://${topic.id}.example.invalid`],
      },
      store = new NewsIngestStore({ ...registry, sources: [source] }),
      clock = new MockClock('2026-01-01T00:00:00Z'),
      graphConfig = defaultNewsGraphConfig(),
      config = defaultNewsEventConfig(),
      records: NewsGraphRecord[] = [],
      graph = new NewsGraphService(graphConfig, [], clock, 'synthetic-hypothesis-news.v1', {
        append: (r) => {
          records.push(r);
          return Promise.resolve();
        },
      }),
      extractor = new NewsClaimExtractor(
        new DeterministicNewsClaimAdapter(),
        defaultNewsExtractionConfig(),
        clock,
        'synthetic-hypothesis-news.v1',
      ),
      points: { id: string; eventId: string; decisionAt: ReturnType<typeof utc> }[] = [];
    for (let i = 0; i < days.length; i++) {
      const observed = utc(`2026-01-${days[i]}T${String(topic.hour).padStart(2, '0')}:00:00Z`),
        processed = shift(observed, 1),
        id = `${topic.id}-${i}`,
        title = `${topic.subject} reported a ${topic.phrase} for case HYPO-${id} involving ETH and 10 USD on 2026-01-${days[i]}.`,
        raw = `<rss version="2.0"><channel><title>Synthetic hypothesis fixtures</title><language>en</language><item><guid>synthetic-${id}</guid><link>https://${topic.id}.example.invalid/${id}</link><title>${title}</title><pubDate>${observed}</pubDate></item></channel></rss>`;
      clock.advanceTo(observed);
      store.ingest({
        schemaVersion: 'news-capture.v1',
        sourceId: source.id,
        sourceVersion: source.version,
        feedUrl: source.feedUrl,
        origin: 'FIXTURE',
        observedAt: observed,
        processedAt: processed,
        availabilityEvidence: 'OBSERVED',
        raw,
        rawHash: byteHash(raw),
        rawRetention: 'RETAINED',
      });
      clock.advanceTo(processed);
      const article = new NewsReviewService(store, [], clock, 'synthetic-hypothesis-news.v1')
        .articles({ decisionAt: clock.now() })
        .articles.find((a) => a.version.providerItemId === `synthetic-${id}`)!;
      clock.advanceBy(1n, 'seconds');
      const extraction = await extractor.extract({
        schemaVersion: 'news-extraction-input.v1',
        source,
        article,
        field: 'TITLE',
        dataCutoff: processed,
      });
      if (extraction.claims.length !== 1) throw new Error('Synthetic hypothesis extraction failed');
      clock.advanceBy(1n, 'seconds');
      await graph.observe(extraction);
      const event = new NewsEventService(
        config,
        graphConfig,
        records,
        [],
        clock,
        'synthetic-hypothesis-news.v1',
      )
        .query({ decisionAt: clock.now() })
        .events.find((e) => e.identity.claimIds.includes(extraction.claims[0]!.id))!;
      if (!event) throw new Error('Synthetic hypothesis event missing');
      const decisionAt = shift(observed, 60);
      points.push({ id: `synthetic:${id}`, eventId: event.identity.id, decisionAt });
      for (let minute = 0; minute <= 5; minute++) {
        const at = shift(decisionAt, minute * 60),
          close = minute === 5 ? 100 + topic.percent[i]! : 100;
        marketBars.push(
          MarketBarSchema.parse({
            schemaVersion: 'market-bar.v1',
            id: `synthetic:hypothesis-bar:${id}:${minute}`,
            exchange: series.exchange,
            instrumentId: series.instrumentId,
            marketType: 'SPOT',
            interval: { value: 1, unit: 'minutes' },
            openAt: shift(at, -60),
            closeAt: at,
            open: '100',
            close: String(close),
            high: String(Math.max(100, close)),
            low: String(Math.min(100, close)),
            volume: '100',
            availableAt: at,
            availabilityBasis: 'OBSERVED',
            researchUse: 'ELIGIBLE',
            sourceVersion: 'synthetic-hypotheses.v1',
            qualityFlags: ['SYNTHETIC'],
            provenance: {
              origin: 'FIXTURE',
              sourceIds: ['synthetic:hypothesis-prices'],
              parentIds: [canonicalHash({ id, minute, close })],
              sourceVersion: 'synthetic-hypotheses.v1',
              capturedAt: at,
              rawTimestamp: null,
            },
          }),
        );
      }
    }
    const snapshot = buildNewsEventSnapshot(
      graphConfig,
      records,
      [],
      config,
      { decisionAt: '2026-01-31T00:00:00Z', generatedAt: '2026-01-31T00:00:00Z' },
      'synthetic-hypothesis-news.v1',
    );
    newsSnapshots.push(snapshot);
    observations.push(
      ...points.map((p) => ({
        kind: 'POINT_IN_TIME' as const,
        ...p,
        snapshotHash: canonicalHash(snapshot),
      })),
    );
    observations.push({
      kind: 'HISTORICAL_DESCRIPTIVE',
      id: `synthetic:${topic.id}:archive`,
      eventId: `synthetic:${topic.id}:historical`,
      eventGroup: topic.type,
      decisionAt: utc(`2026-01-23T${String(topic.hour).padStart(2, '0')}:01:00Z`),
      researchUse: 'DESCRIPTIVE_ONLY',
      firstSeenQuality: 'UNKNOWN',
      availableAt: null,
      reason: 'Synthetic archive without defensible first-available timestamp.',
      provenance: {
        origin: 'FIXTURE',
        sourceIds: [`synthetic:${topic.id}:archive`],
        parentIds: [],
        sourceVersion: 'synthetic-hypotheses.v1',
        capturedAt: utc('2026-01-25T00:00:00Z'),
        rawTimestamp: null,
      },
    });
    const content = HypothesisCardContentSchema.parse({
      id: `synthetic:hypothesis:${topic.id}`,
      thesis: `Test the ${topic.direction.toLowerCase()} association of ${topic.phrase} reports with five-minute ETH returns.`,
      eventGroup: [topic.type],
      expectedDirection: topic.direction,
      series,
      horizonSeconds: 300,
      intervalSeconds: 60,
      roundTripCostBps: 10,
      assumptions: [
        'Entire news and price corpus is synthetic; no real pre-registration is asserted.',
        'UTC 24/7 exact-close decisions; no fill or causal interpretation.',
      ],
      selectionBiases: [
        'Hand-authored paths and selected event taxonomy do not represent real markets.',
        'Few separated lineage/window units; conditional bootstrap uncertainty only.',
      ],
      eligibility: { firstSeenQualities: ['OBSERVED', 'ARCHIVED_CAPTURE'], allowUnverified: true },
      samplePeriod: {
        selection: { from: '2026-01-01T00:00:00Z', to: '2026-01-10T00:00:00Z' },
        validation: { from: '2026-01-20T00:00:00Z', to: '2026-01-31T00:00:00Z' },
      },
      reuseDisclosure: null,
      tests: { primaryMetric: 'GROSS_RETURN', minimumIndependentUnits: 3, meanThreshold: '0' },
      claimType: 'ASSOCIATION',
      causalJustification: null,
      status: 'REGISTERED',
    });
    cards.push(
      appendHypothesisCard(
        cards,
        {
          expectedPreviousHash: null,
          author: 'synthetic:registrar',
          reason: 'Fictional freeze before the fictional validation period.',
          content,
        },
        '2026-01-10T00:00:00Z',
      ),
    );
  }
  const dataset = HypothesisDatasetSchema.parse({
      schemaVersion: 'hypothesis-dataset.v1',
      newsSnapshots,
      marketBars,
      observations,
    }),
    input = HypothesisRegistryInputSchema.parse({
      schemaVersion: 'hypothesis-registry-input.v1',
      cards,
      dataset,
    }),
    request = HypothesisRegistryRequestSchema.parse({
      schemaVersion: 'hypothesis-registry-request.v1',
      analysisAsOf: '2026-01-31T00:00:00Z',
      generatedAt: '2026-01-31T00:00:00Z',
      bootstrapSamples: 1000,
      seed: 42,
    });
  return { input, request };
}
