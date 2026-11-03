import {
  MarketMlInferenceSchema,
  MlForecastSchema,
  MarketStrategySourceSchema,
  utcNanoseconds,
} from '@crypto/contracts';
import type { MlForecast } from '@crypto/contracts';
import { canonicalHash, deepFreeze } from '@crypto/core';
import { technicalFeatureCatalog } from '@crypto/research';
import { validateMarketModel } from './market-ml-training.js';
import { forecast, probabilities } from './market-ml-math.js';
import type { Vector3 } from './market-ml-math.js';
import type { MarketStrategy } from './market-baselines.js';
import { MarketEligibility } from './eligibility.js';
import { z } from 'zod';
import { IdSchema, UtcTimestampSchema, compareDecimal } from '@crypto/contracts';
const stateSchema = z.strictObject({
  modelId: IdSchema,
  lastCloseAt: UtcTimestampSchema.nullable(),
  lastForecast: MlForecastSchema.nullable(),
  reason: z.string().min(1).max(100),
});
export function inferMarketModel(modelInput: unknown, input: unknown): MlForecast {
  const m = validateMarketModel(modelInput),
    q = MarketMlInferenceSchema.parse(input);
  if (q.decisionAt < m.availableAt) throw new Error('Model unavailable at decision time');
  if (
    q.featureAsOf > q.decisionAt ||
    utcNanoseconds(q.decisionAt) - utcNanoseconds(q.featureAsOf) >
      BigInt(m.config.maxFeatureAgeSeconds) * 1000000000n ||
    !m.instrumentKeys.includes(q.instrumentKey)
  )
    throw new Error('Future/stale feature clock or unknown instrument');
  if (
    q.features.length !== m.featureSchema.length ||
    q.features.some(
      (f, i) =>
        f.name !== m.featureSchema[i]!.name ||
        f.definitionHash !== m.featureSchema[i]!.definitionHash ||
        f.sourceKind !== 'TECHNICAL' ||
        f.dependency !== 'MARKET' ||
        (f.maxInputAvailableAt !== null && f.maxInputAvailableAt > q.featureAsOf) ||
        (f.maxInputEventAt !== null && f.maxInputEventAt > q.featureAsOf),
    )
  )
    throw new Error('Inference feature schema or time leakage');
  if (
    q.features.some(
      (f) =>
        f.maxInputEventAt !== null &&
        utcNanoseconds(q.featureAsOf) - utcNanoseconds(f.maxInputEventAt) >
          BigInt(m.config.maxFeatureAgeSeconds) * 1000000000n,
    )
  )
    throw new Error('Stale inference input evidence');
  const missing = q.features.some(
    (f) =>
      f.value === null ||
      f.status !== 'READY' ||
      f.inputBarIds.length === 0 ||
      f.maxInputAvailableAt === null ||
      f.maxInputEventAt === null,
  );
  const values = q.features.map((f) => Number(f.value));
  if (!missing && values.some((v) => !Number.isFinite(v) || Math.abs(v) > 1e12))
    throw new Error('Unsupported inference numeric range');
  const prior = m.training.classCounts.map(
    (n) => (n + 1) / (m.training.rowIds.length + 3),
  ) as Vector3;
  const result = MlForecastSchema.parse(
    forecast(missing ? prior : probabilities(m, values), m.config, missing),
  );
  deepFreeze(result);
  return result;
}
/** Candidate adapter has no label/training API and no news/execution context. */
export function createMarketMlStrategy(
  modelInput: unknown,
  sourceInput: unknown,
): () => MarketStrategy {
  const model = validateMarketModel(modelInput),
    source = MarketStrategySourceSchema.parse(sourceInput),
    catalog = technicalFeatureCatalog(model.featureConfig),
    eligibility = new MarketEligibility(source);
  if (
    source.intervalSeconds !== model.intervalSeconds ||
    source.historyStartCloseAt !== model.historyStartCloseAt ||
    !model.instrumentKeys.includes(source.instrumentKey)
  )
    throw new Error('ML strategy source/schema mismatch');
  const { market, ...sourceBinding } = source;
  const descriptor = {
    id: 'market:multinomial-logistic',
    version: '1',
    portfolio: source.portfolio,
    config: {
      modelId: model.id,
      featureSchemaHash: canonicalHash(model.featureSchema),
      source: sourceBinding,
      marketHash: canonicalHash(market),
    },
  };
  return () => ({
    descriptor,
    initialState: () => ({
      modelId: model.id,
      lastCloseAt: null,
      lastForecast: null,
      reason: 'INITIAL',
    }),
    onEvent: (event, ctx, state) => {
      if (
        event.kind !== 'MARKET_BAR' ||
        event.record.instrumentId !== source.series.instrumentId ||
        event.record.exchange !== source.series.exchange ||
        event.record.marketType !== source.series.marketType
      )
        return { state, candidates: [] };
      const now = ctx.clock.now(),
        bar = ctx.bar({ id: event.recordId, asOf: now });
      const old = stateSchema.parse(state);
      if (old.modelId !== model.id) throw new Error('ML state/model mismatch');
      if (old.lastCloseAt && bar.closeAt <= old.lastCloseAt) return { state, candidates: [] };
      let reason =
        now < model.availableAt
          ? 'MODEL_UNAVAILABLE'
          : !eligibility.bar(bar, now)
            ? 'SOURCE_INELIGIBLE'
            : compareDecimal(bar.volume, model.featureConfig.minimumBaseVolume) < 0
              ? 'LOW_BASE_VOLUME'
              : utcNanoseconds(now) - utcNanoseconds(bar.closeAt) >
                  BigInt(model.config.maxFeatureAgeSeconds) * 1000000000n
                ? 'STALE_FEATURE'
                : null;
      let predicted: MlForecast | null = null;
      const ids = new Set([bar.id]);
      if (reason === null) {
        const row = ctx.features({
          schemaVersion: 'technical-feature-query.v1',
          series: source.series,
          intervalSeconds: source.intervalSeconds,
          historyStartCloseAt: source.historyStartCloseAt,
          featureAsOf: now,
          config: model.featureConfig,
        });
        if (row.currentBarId !== bar.id) reason = 'ANCHOR_MISMATCH';
        const selected = model.featureSchema.map((f) => {
          const id = f.name.slice('technical.'.length),
            value = row.features.find((v) => v.featureId === id),
            definition = catalog.find((c) => c.featureId === id);
          if (!value || !definition) throw new Error('Registered inference feature unavailable');
          return {
            name: f.name,
            value: value.value,
            status: value.status,
            definitionHash: canonicalHash({
              definition,
              config: model.featureConfig,
              intervalSeconds: model.intervalSeconds,
            }),
            sourceKind: 'TECHNICAL' as const,
            dependency: 'MARKET' as const,
            sourceHashes: [row.datasetHash],
            inputBarIds: value.inputBarIds,
            maxInputAvailableAt: value.maxInputAvailableAt,
            maxInputEventAt: value.maxInputCloseAt,
          };
        });
        const history = ctx.bars({
            series: source.series,
            intervalSeconds: source.intervalSeconds,
            fromCloseAt: source.historyStartCloseAt,
            toCloseAt: bar.closeAt,
            asOf: now,
          }),
          byId = new Map(history.map((b) => [b.id, b]));
        for (const id of new Set(selected.flatMap((f) => f.inputBarIds))) {
          const b = byId.get(id);
          if (b) ids.add(id);
          if (!b || !eligibility.bar(b, now)) reason = 'HISTORICAL_INPUT_INELIGIBLE';
        }
        if (reason === null)
          predicted = inferMarketModel(model, {
            schemaVersion: 'market-ml-inference.v1',
            instrumentKey: source.instrumentKey,
            featureAsOf: now,
            decisionAt: now,
            features: selected,
          });
      }
      const next = {
        modelId: model.id,
        lastCloseAt: bar.closeAt,
        lastForecast: predicted,
        reason: reason ?? predicted!.reason,
      };
      return {
        state: next,
        candidates: [
          {
            symbol: source.series.instrumentId,
            side: predicted?.action ?? 'HOLD',
            horizon: { value: model.config.horizonBars * model.intervalSeconds, unit: 'seconds' },
            score: predicted
              ? { status: 'KNOWN', value: predicted.score }
              : { status: 'MISSING', reason: next.reason },
            calibration:
              predicted && predicted.reason !== 'MISSING_FEATURE'
                ? {
                    status: 'KNOWN',
                    value: {
                      modelVersion: model.id,
                      probability: Math.max(...predicted.probabilities),
                    },
                  }
                : { status: 'MISSING', reason: next.reason },
            rationaleIds: [...ids],
          },
        ],
      };
    },
  });
}
