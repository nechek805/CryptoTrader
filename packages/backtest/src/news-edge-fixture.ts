import { Decimal } from 'decimal.js';
import {
  MarketBarSchema,
  NewsEdgeInputSchema,
  NewsEdgeInferenceRequestSchema,
} from '@crypto/contracts';
import type { HypothesisDataset, NewsGraphRecord, NewsEventRecord } from '@crypto/contracts';
import { canonicalHash, MockClock, utc, fromEpoch } from '@crypto/core';
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
import { defaultNewsSignalConfig, deriveNewsFreshness } from '@crypto/strategies';
import { marketBaselineFixture } from './market-fixture.js';
import { marketSource } from './market-backtest.js';
const D = Decimal.clone({ precision: 96 });
const shift = (s: string, seconds: number) =>
  fromEpoch(BigInt(Date.parse(s)) + BigInt(seconds) * 1000n, 'milliseconds');
/** Fictional corpus. Both the preregistration clock and return paths are authored fixtures. */
export async function newsEdgeFixture() {
  return buildNewsEdgeFixture(false);
}
/** Adds a fixed later TEST cohort without changing the original training recipe. */
export async function newsEdgeEvaluationFixture() {
  return buildNewsEdgeFixture(true);
}
async function buildNewsEdgeFixture(evaluation: boolean) {
  const registry = await newsFixtureRegistry(),
    template = registry.sources[0]!,
    dataset: HypothesisDataset = {
      schemaVersion: 'hypothesis-dataset.v1',
      newsSnapshots: [],
      marketBars: [],
      marketSnapshots: [],
      observations: [],
    };
  const controls: string[] = [],
    queries: ReturnType<typeof NewsEdgeInferenceRequestSchema.parse>[] = [];
  const recipes = [
    {
      id: 'incident',
      type: 'SECURITY_INCIDENT' as const,
      phrase: 'security incident',
      asset: 'BTC' as const,
      hour: '09',
      sign: -1,
    },
    {
      id: 'positive',
      type: 'LISTING' as const,
      phrase: 'listing',
      asset: 'ETH' as const,
      hour: '15',
      sign: 1,
    },
  ];
  const series = (asset: string) => ({
    asset,
    exchange: 'synthetic:news-edge',
    instrumentId: `${asset}/USDT`,
    marketType: 'SPOT' as const,
  });
  const benchmark = series('SOL');
  for (const recipe of recipes) {
    const sources = ['one', 'two'].map((id) => ({
      ...template,
      id: `synthetic:edge:${recipe.id}:${id}`,
      owner: `Synthetic ${recipe.id} ${id}`,
      independenceGroup: `synthetic:edge:${recipe.id}:${id}`,
      publicationType: 'INDEPENDENT_REPORTING' as const,
      feedUrl: `https://${id}.example.invalid/feed.xml`,
      articleOrigins: [`https://${id}.example.invalid`],
      knownAt: utc('2025-12-01T00:00:00Z'),
    }));
    const store = new NewsIngestStore({
      ...registry,
      providers: registry.providers.map((p) => ({ ...p, knownAt: utc('2025-12-01T00:00:00Z') })),
      sources,
    });
    const clock = new MockClock('2025-12-31T00:00:00Z'),
      graphConfig = defaultNewsGraphConfig(),
      config = defaultNewsEventConfig(),
      graphRecords: NewsGraphRecord[] = [],
      metadataRecords: NewsEventRecord[] = [];
    const graph = new NewsGraphService(graphConfig, [], clock, 'synthetic:news-edge-source.v1', {
      append: (r) => {
        graphRecords.push(r);
        return Promise.resolve();
      },
    });
    const metadata = new NewsEventService(
      config,
      graphConfig,
      graphRecords,
      metadataRecords,
      clock,
      'synthetic:news-edge-source.v1',
      {
        append: (r) => {
          metadataRecords.push(r);
          return Promise.resolve();
        },
      },
    );
    await metadata.decide({
      schemaVersion: 'news-event-decision.v1',
      expectedGraphHeadHash: metadata.graphHeadHash(),
      expectedHeadHash: metadata.headHash(),
      operator: 'synthetic:edge-registrar',
      reason: 'Synthetic direct asset context declared before receipts.',
      action: {
        kind: 'MAP_ASSET',
        subject: 'Synthetic Vault',
        eventTypes: [recipe.type],
        symbol: recipe.asset,
        relationship: 'DIRECT',
        reference: 'fixture://news-edge/direct',
      },
    });
    const extractor = new NewsClaimExtractor(
      new DeterministicNewsClaimAdapter(),
      defaultNewsExtractionConfig(),
      clock,
      'synthetic:news-edge-source.v1',
    );
    const points: { id: string; eventId: string; decisionAt: ReturnType<typeof utc> }[] = [];
    const times = ['01', '03', '05', '07', '09', '11', '20', '22', '24', '28'].map(
      (day) => `2026-01-${day}T${recipe.hour}:00:57Z`,
    );
    if (evaluation)
      times.push(
        `2026-01-30T${recipe.hour}:00:57Z`,
        ...['01', '03', '05', '07'].map((day) => `2026-02-${day}T${recipe.hour}:00:57Z`),
      );
    times.splice(2, 0, `2026-01-03T${String(Number(recipe.hour) + 3).padStart(2, '0')}:00:57Z`);
    for (const [i, observed] of times.entries()) {
      clock.advanceTo(observed);
      for (const [j, source] of sources.entries()) {
        let title =
          j === 0
            ? `Synthetic Vault independently reported a ${recipe.phrase} for case EDGE-${recipe.id}-${i} involving ${recipe.asset} and 2000000 USD on ${observed.slice(0, 10)}. Separate interviews supplied this report.`
            : `Synthetic Vault observed first-hand a ${recipe.phrase} for case EDGE-${recipe.id}-${i} involving ${recipe.asset} and 2000000 USD on ${observed.slice(0, 10)}. Different records support this account.`;
        if (evaluation && i === 13)
          title = `Synthetic Vault may have reported a ${recipe.phrase} for case EDGE-${recipe.id}-${i} involving ${recipe.asset} and 2000000 USD on ${observed.slice(0, 10)}.`;
        if (evaluation && i === 14 && j === 1)
          title = `Synthetic Vault did not report a ${recipe.phrase} for case EDGE-${recipe.id}-${i} involving ${recipe.asset} and 2000000 USD on ${observed.slice(0, 10)}.`;
        const raw = `<rss version="2.0"><channel><title>Synthetic edge corpus</title><language>en</language><item><guid>synthetic-edge-${i}-${j}</guid><link>https://${j === 0 ? 'one' : 'two'}.example.invalid/${recipe.id}/${i}</link><title>${title}</title><pubDate>${observed}</pubDate></item></channel></rss>`;
        store.ingest({
          schemaVersion: 'news-capture.v1',
          sourceId: source.id,
          sourceVersion: source.version,
          feedUrl: source.feedUrl,
          origin: 'FIXTURE',
          observedAt: utc(observed),
          processedAt: shift(observed, 1),
          availabilityEvidence: 'OBSERVED',
          raw,
          rawHash: byteHash(raw),
          rawRetention: 'RETAINED',
        });
      }
      clock.advanceTo(shift(observed, 2));
      const extracted: Awaited<ReturnType<NewsClaimExtractor['extract']>>[] = [];
      for (const [j, source] of sources.entries()) {
        const article = new NewsReviewService(store, [], clock, 'synthetic:news-edge-source.v1')
          .articles({ decisionAt: clock.now() })
          .articles.find((a) => a.version.providerItemId === `synthetic-edge-${i}-${j}`)!;
        extracted.push(
          await extractor.extract({
            schemaVersion: 'news-extraction-input.v1',
            source,
            article,
            field: 'TITLE',
            dataCutoff: shift(observed, 1),
          }),
        );
      }
      clock.advanceTo(shift(observed, 3));
      for (const e of extracted) {
        if (e.claims.length !== 1) throw new Error('Synthetic news edge extraction failed');
        await graph.observe(e);
      }
      const event = new NewsEventService(
        config,
        graphConfig,
        graphRecords,
        metadataRecords,
        clock,
        'synthetic:news-edge-source.v1',
      )
        .query({ decisionAt: clock.now() })
        .events.find((e) => e.identity.claimIds.includes(extracted[0]!.claims[0]!.id))!;
      const decisionAt = shift(observed, 63),
        point = { id: `synthetic:edge:${recipe.id}:${i}`, eventId: event.identity.id, decisionAt };
      points.push(point);
      const preRelative =
        evaluation && i === 12 ? String(recipe.sign * 0.1) : i % 2 === 0 ? '0.002' : '-0.002';
      const addWindow = (anchor: ReturnType<typeof utc>, control: boolean, suffix: string) => {
        for (const asset of [recipe.asset, 'SOL'])
          for (let minute = -5; minute <= 5; minute++) {
            const isBenchmark = asset === 'SOL',
              pre = isBenchmark ? new D('0.001') : new D('0.001').plus(preRelative);
            let close = new D(100);
            if (minute < 0) close = new D(100).div(new D(1).plus(pre.mul(-minute).div(5)));
            if (minute > 0) {
              const benchmarkReturn = new D('0.002').mul(minute).div(5);
              let target = control
                ? benchmarkReturn.plus(new D('0.001').mul(minute).div(5))
                : new D(recipe.sign).mul(
                    minute === 1
                      ? '0.001'
                      : new D('0.001').plus(
                          new D('0.020')
                            .plus(new D(i % 3).mul('0.002'))
                            .minus('0.001')
                            .mul(minute - 1)
                            .div(4),
                        ),
                  );
              if (evaluation && !control && i === 11) target = target.neg();
              if (evaluation && !control && i === 12) target = new D(0);
              close = new D(100).mul(new D(1).plus(isBenchmark ? benchmarkReturn : target));
            }
            const at = shift(anchor, minute * 60),
              price = close.toDecimalPlaces(36).toFixed();
            dataset.marketBars.push(
              MarketBarSchema.parse({
                schemaVersion: 'market-bar.v1',
                id: `synthetic:edge-price:${recipe.id}:${i}:${suffix}:${asset}:${minute}`,
                exchange: series(asset).exchange,
                instrumentId: series(asset).instrumentId,
                marketType: 'SPOT',
                interval: { value: 1, unit: 'minutes' },
                openAt: shift(at, -60),
                closeAt: at,
                open: '100',
                high: D.max(100, close).toDecimalPlaces(36).toFixed(),
                low: D.min(100, close).toDecimalPlaces(36).toFixed(),
                close: price,
                volume: '1000',
                availableAt: at,
                availabilityBasis: 'OBSERVED',
                researchUse: 'ELIGIBLE',
                sourceVersion: 'synthetic-news-edge.v1',
                qualityFlags: ['SYNTHETIC'],
                provenance: {
                  origin: 'FIXTURE',
                  sourceIds: ['synthetic:edge-prices'],
                  parentIds: [
                    canonicalHash({ recipe: recipe.id, i, suffix, asset, minute, price }),
                  ],
                  sourceVersion: 'synthetic-news-edge.v1',
                  capturedAt: at,
                  rawTimestamp: null,
                },
              }),
            );
          }
      };
      addWindow(decisionAt, false, 'event');
      for (const [n, seconds] of [-7200, -3600].entries()) {
        const c = shift(decisionAt, seconds);
        controls.push(c);
        addWindow(c, true, `control-${n}`);
      }
    }
    const snapshot = buildNewsEventSnapshot(
      graphConfig,
      graphRecords,
      metadataRecords,
      config,
      {
        decisionAt: evaluation ? '2026-02-10T00:00:00Z' : '2026-02-01T00:00:00Z',
        generatedAt: evaluation ? '2026-02-10T00:00:00Z' : '2026-02-01T00:00:00Z',
      },
      'synthetic:news-edge-source.v1',
    );
    dataset.newsSnapshots.push(snapshot);
    dataset.observations.push(
      ...points.map((p) => ({
        ...p,
        kind: 'POINT_IN_TIME' as const,
        snapshotHash: canonicalHash(snapshot),
      })),
    );
    dataset.observations.push({
      kind: 'HISTORICAL_DESCRIPTIVE',
      id: `synthetic:edge:${recipe.id}:archive`,
      eventId: `synthetic:edge:${recipe.id}:unreliable`,
      eventGroup: recipe.type,
      decisionAt: utc(`2026-01-23T${recipe.hour}:02:00Z`),
      researchUse: 'DESCRIPTIVE_ONLY',
      firstSeenQuality: 'UNKNOWN',
      availableAt: null,
      reason: 'Synthetic archive without a defensible first receipt.',
      provenance: {
        origin: 'FIXTURE',
        sourceIds: ['synthetic:edge-archive'],
        parentIds: [],
        sourceVersion: 'synthetic-news-edge.v1',
        capturedAt: utc('2026-01-25T00:00:00Z'),
        rawTimestamp: null,
      },
    });
    const m = marketBaselineFixture(recipe.asset),
      source = { ...marketSource(m), portfolio: 'NEWS_ONLY' as const },
      templateBar = m.backtest.input.replay.bars[0]!;
    for (const p of evaluation
      ? points.filter((p) => p.decisionAt >= utc('2026-01-28T00:00:00Z'))
      : [points.at(-1)!]) {
      const stale = evaluation && p.id.endsWith(':15'),
        barAt = stale ? shift(p.decisionAt, -61) : p.decisionAt;
      const freshnessBar = MarketBarSchema.parse({
        ...templateBar,
        id: `synthetic:edge:freshness:${recipe.id}`,
        openAt: shift(barAt, -60),
        closeAt: barAt,
        availableAt: barAt,
        provenance: { ...templateBar.provenance, capturedAt: barAt },
      });
      queries.push(
        NewsEdgeInferenceRequestSchema.parse({
          schemaVersion: 'news-edge-inference.v1',
          hypothesisId: `synthetic:edge:${recipe.id}:first`,
          snapshot,
          query: {
            schemaVersion: 'news-signal-query.v1',
            decisionAt: p.decisionAt,
            eventId: p.eventId,
            symbol: `${recipe.asset}/USDT`,
            freshness: deriveNewsFreshness({
              schemaVersion: 'news-freshness-request.v1',
              source,
              bars: [freshnessBar],
              decisionAt: p.decisionAt,
              maximumAgeSeconds: 60,
            }),
          },
          roundTripCostBps: 10,
        }),
      );
    }
  }
  const admission = {
    ...defaultNewsSignalConfig(),
    declaredAt: utc('2025-12-31T00:00:00Z'),
    requireExpectationMismatch: false,
  };
  const input = NewsEdgeInputSchema.parse({
    schemaVersion: 'news-edge-input.v1',
    dataset,
    plan: {
      schemaVersion: 'news-edge-plan.v1',
      algorithmVersion: 'matched-news-block-means.v1',
      declaredAt: '2025-12-31T00:00:00Z',
      training: { from: '2026-01-01T00:00:00Z', to: '2026-01-15T00:00:00Z' },
      validation: { from: '2026-01-20T00:00:00Z', to: '2026-01-26T00:00:00Z' },
      analysisAsOf: '2026-01-26T00:00:00Z',
      availableAt: '2026-01-26T00:05:00Z',
      decisionLagSeconds: 60,
      intervalSeconds: 60,
      horizonsSeconds: [60, 300],
      preWindowSeconds: 300,
      benchmark,
      controlAnchors: controls.filter((t) => t < utc('2026-01-26T00:00:00Z')),
      minimumMatchedControls: 2,
      preMoveCaliper: '0.00001',
      minimumTrainingUnits: 5,
      minimumValidationUnits: 3,
      roundTripCostBps: 10,
      uncertaintyBufferBps: 25,
      bootstrapSamples: 2000,
      seed: 42,
      admission,
      hypotheses: recipes.flatMap((r) => [
        {
          id: `synthetic:edge:${r.id}:first`,
          eventType: r.type,
          recurrence: 'FIRST_SEEN_IN_CORPUS',
          series: series(r.asset),
        },
        {
          id: `synthetic:edge:${r.id}:repeat`,
          eventType: r.type,
          recurrence: 'REPEATED_PATTERN',
          series: series(r.asset),
        },
      ]),
    },
  });
  return { input, queries };
}
