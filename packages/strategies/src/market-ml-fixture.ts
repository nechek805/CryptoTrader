import {
  MarketBarSchema,
  DatasetPanelInputSchema,
  DatasetPanelRequestSchema,
  MarketMlConfigSchema,
} from '@crypto/contracts';
import { canonicalHash, fromEpoch } from '@crypto/core';
import {
  crossFeatureFixture,
  technicalFeatureFixture,
  buildTechnicalFeatureArtifact,
} from '@crypto/research';
/** Fixed fictional cycles; never sampled market data, tuned parameters or investment evidence. */
export function marketMlFixture() {
  const at = (s: number) => fromEpoch(1767225600n + BigInt(s), 'seconds'),
    raw = crossFeatureFixture(),
    assets = ['BTC', 'ETH', 'SOL'] as const,
    keys = assets.map((asset) => `cross:SPOT:${asset}`),
    bindings = raw.input.bindings.filter((b) => keys.includes(b.instrumentKey)),
    config = {
      ...technicalFeatureFixture().request.config,
      smaPeriod: 4,
      emaPeriod: 4,
      volatilityPeriod: 4,
      atrPeriod: 4,
      relativeVolumePeriod: 4,
      zScorePeriod: 4,
      breakoutPeriod: 4,
      returnHorizonsBars: [1, 2],
      minimumBaseVolume: '1',
    };
  const technicalArtifacts = bindings.map((binding) => {
    const template = raw.input.technical.bars.find(
        (b) => b.instrumentId === binding.series.instrumentId && b.marketType === 'SPOT',
      )!,
      base = { BTC: 100, ETH: 50, SOL: 20 }[binding.series.asset as (typeof assets)[number]],
      deltas = [2, 2, 1, 0, 0, -1, -2, -2, -1, 0, 0, 1];
    let price = base;
    const bars = Array.from({ length: 96 }, (_, i) => {
      price += deltas[i % 12]!;
      return MarketBarSchema.parse({
        ...template,
        id: `synthetic:ml:${binding.series.asset}:bar:${i + 1}`,
        openAt: at(i * 60),
        closeAt: at((i + 1) * 60),
        availableAt: at((i + 1) * 60),
        open: String(price),
        high: String(price),
        low: String(price),
        close: String(price),
        volume: String(1000 + (i % 4) * 100),
        sourceVersion: 'synthetic-market-ml.v1',
        provenance: {
          ...template.provenance,
          capturedAt: at((i + 1) * 60),
          sourceVersion: 'synthetic-market-ml.v1',
          parentIds: [
            canonicalHash({
              asset: binding.series.asset,
              i,
              price,
              recipe: 'synthetic-market-ml.v1',
            }),
          ],
        },
      });
    });
    return buildTechnicalFeatureArtifact(
      { schemaVersion: 'technical-feature-dataset.v1', bars },
      {
        schemaVersion: 'technical-feature-request.v1',
        series: binding.series,
        intervalSeconds: 60,
        historyStartCloseAt: at(60),
        featureAsOf: Array.from({ length: 96 }, (_, i) => at((i + 1) * 60)),
        generatedAt: at(6000),
        config,
      },
      'synthetic:market-ml-source.v1',
    );
  });
  const input = DatasetPanelInputSchema.parse({
    schemaVersion: 'dataset-panel-input.v1',
    market: {
      ...raw.input.market,
      instruments: raw.input.market.instruments.filter((m) => keys.includes(m.instrumentKey)),
      observations: [],
    },
    bindings,
    groups: keys.map((key) => ({
      schemaVersion: 'panel-group-revision.v1',
      id: `${key}:ml-group:1`,
      instrumentKey: key,
      revision: 1,
      groupId: 'synthetic:market-ml-cohort',
      effectiveFrom: at(0),
      observedAt: at(0),
      availableAt: at(0),
      availabilityBasis: 'OBSERVED',
      researchUse: 'ELIGIBLE',
      provenance: {
        origin: 'FIXTURE',
        sourceIds: ['synthetic:cross'],
        parentIds: [canonicalHash(key)],
        sourceVersion: 'synthetic-market-ml.v1',
        capturedAt: at(0),
        rawTimestamp: null,
      },
    })),
    technicalArtifacts,
    crossArtifacts: [],
    proposedFeatures: [],
  });
  const request = DatasetPanelRequestSchema.parse({
    schemaVersion: 'dataset-panel-request.v1',
    instrumentKeys: keys,
    columns: ['technical.return_1', 'technical.return_2', 'technical.relative_volume'],
    intervalSeconds: 60,
    splits: {
      train: { from: at(600), to: at(2700) },
      validation: { from: at(2700), to: at(4200) },
      test: { from: at(4200), to: at(5640) },
    },
    embargoSeconds: 120,
    horizonsBars: [2],
    labelPublicationLagSeconds: 5,
    labelsAsOf: at(6000),
    generatedAt: at(6000),
    missingPolicy: 'KEEP_NULLS',
    membership: 'POINT_IN_TIME_LISTED',
    cohortDisclosure:
      'SYNTHETIC BTC/ETH/SOL cyclic prices, fixed three-symbol teaching cohort. Not historical market coverage or evidence of profitability.',
  });
  const mlConfig = MarketMlConfigSchema.parse({
    schemaVersion: 'market-ml-config.v1',
    horizonBars: 2,
    abstentionReturnBps: '25',
    featureColumns: request.columns,
    randomSeed: 42,
    epochs: 300,
    learningRate: 0.1,
    l2: 0.01,
    minimumTrainRows: 30,
    minimumValidationRows: 12,
    minimumTestRows: 12,
    fitCutoff: at(2699),
    calibrationCutoff: at(4199),
    generatedAt: at(6000),
    confidenceThreshold: 0.6,
    directionalMargin: 0.15,
    maxFeatureAgeSeconds: 120,
  });
  return { input, request, config: mlConfig };
}
