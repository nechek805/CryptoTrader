import { MarketMlConfigSchema, MarketMlModelSchema, MarketMlReportSchema } from '@crypto/contracts';
import type { MarketMlModel, MarketMlPrediction, MarketMlConfig } from '@crypto/contracts';
import { canonicalHash, deepFreeze, deterministicId } from '@crypto/core';
import { verifyDatasetPanel, technicalFeatureCatalog } from '@crypto/research';
import {
  classes,
  fitLogistic,
  transform,
  softmax,
  logits,
  logLoss,
  forecast,
  probabilities,
} from './market-ml-math.js';
import type { Vector3 } from './market-ml-math.js';
import { prepareMlRows, fittingRowsHash } from './market-ml-data.js';
import { evaluateMl, maBaseline } from './market-ml-report.js';
export function validateMarketModel(input: unknown) {
  if (process.versions.node !== '24.22.2')
    throw new Error('Model runtime must be pinned Node 24.22.2');
  const m = MarketMlModelSchema.parse(input),
    { id, ...body } = m;
  if (
    id !== deterministicId('market-logistic', body) ||
    canonicalHash({
      rowIds: m.scaler.rowIds,
      means: m.scaler.means,
      scales: m.scaler.scales,
      clip: 8,
    }) !== m.scaler.hash ||
    canonicalHash(m.scaler.rowIds) !== canonicalHash(m.training.rowIds)
  )
    throw new Error('Model/scaler integrity mismatch');
  const catalog = technicalFeatureCatalog(m.featureConfig);
  if (
    canonicalHash(m.featureSchema.map((f) => f.name)) !== canonicalHash(m.config.featureColumns) ||
    m.featureSchema.some((f) => {
      const definition = catalog.find((d) => `technical.${d.featureId}` === f.name);
      return (
        !definition ||
        canonicalHash({
          definition,
          config: m.featureConfig,
          intervalSeconds: m.intervalSeconds,
        }) !== f.definitionHash
      );
    }) ||
    new Set(m.training.rowIds).size !== m.training.rowIds.length ||
    new Set(m.calibration.rowIds).size !== m.calibration.rowIds.length ||
    m.calibration.rowIds.some((id) => m.training.rowIds.includes(id))
  )
    throw new Error('Model feature catalog or split identity mismatch');
  deepFreeze(m);
  return m;
}
/** Directory entry point always verifies the frozen Parquet and its semantically rebuilt sources. */
export async function trainMarketModel(
  directory: string,
  configInput: unknown,
  codeVersion: string,
) {
  if (process.versions.node !== '24.22.2')
    throw new Error('Training runtime must be pinned Node 24.22.2');
  const verified = await verifyDatasetPanel(directory);
  return fitVerifiedPanel(verified, MarketMlConfigSchema.parse(configInput), codeVersion);
}
function fitVerifiedPanel(
  v: Awaited<ReturnType<typeof verifyDatasetPanel>>,
  cfg: MarketMlConfig,
  codeVersion: string,
) {
  const a = v.artifact,
    rows = prepareMlRows(a, v.rows, cfg),
    train = rows.filter((r) => r.row.split === 'TRAIN' && r.values !== null),
    cal = rows.filter((r) => r.row.split === 'VALIDATION' && r.values !== null),
    test = rows.filter((r) => r.row.split === 'TEST');
  if (
    train.length < cfg.minimumTrainRows ||
    cal.length < cfg.minimumValidationRows ||
    test.length < cfg.minimumTestRows
  )
    throw new Error('Insufficient frozen train/validation/test coverage');
  const featureSchema = cfg.featureColumns.map((name) => {
    const f = a.featureCatalog.find((f) => f.name === name);
    if (!f) throw new Error('Unknown fitted feature definition');
    return { name, definitionHash: f.definitionHash };
  });
  if (
    a.input.crossArtifacts.length ||
    !a.input.technicalArtifacts.length ||
    a.input.technicalArtifacts.some(
      (t) =>
        canonicalHash(t.request.config) !==
          canonicalHash(a.input.technicalArtifacts[0]!.request.config) ||
        t.request.historyStartCloseAt !==
          a.input.technicalArtifacts[0]!.request.historyStartCloseAt,
    )
  )
    throw new Error('ML v1 requires one shared technical formula configuration');
  const means = cfg.featureColumns.map(
      (_, j) => train.reduce((sum, r) => sum + r.values![j]!, 0) / train.length,
    ),
    scales = means.map(
      (mean, j) =>
        Math.sqrt(train.reduce((sum, r) => sum + (r.values![j]! - mean) ** 2, 0) / train.length) ||
        1,
    );
  const xs = train.map((r) => transform(r.values!, means, scales)),
    ys = train.map((r) => classes.indexOf(r.label)),
    classCounts: Vector3 = [0, 0, 0];
  for (const y of ys) classCounts[y] = classCounts[y]! + 1;
  if (classCounts.some((n) => n < 2))
    throw new Error('At least two TRAIN examples of every class are required');
  const fit = fitLogistic(xs, ys, cfg),
    valXs = cal.map((r) => transform(r.values!, means, scales)),
    valYs = cal.map((r) => classes.indexOf(r.label)),
    temperatures = [0.5, 1, 2, 4] as const;
  const trials = temperatures.map((temperature) => ({
    temperature,
    logLoss: logLoss(
      valXs.map((x) => softmax(logits(fit.weights, fit.biases, x), temperature)),
      valYs,
    ),
  }));
  const best = [...trials].sort(
    (a, b) =>
      a.logLoss - b.logLoss ||
      Math.abs(Math.log(a.temperature)) - Math.abs(Math.log(b.temperature)),
  )[0]!;
  const scaler = {
    fitSplit: 'TRAIN' as const,
    rowIds: train.map((r) => r.row.id),
    means,
    scales,
    clip: 8 as const,
    hash: canonicalHash({ rowIds: train.map((r) => r.row.id), means, scales, clip: 8 }),
  };
  const body = {
    schemaVersion: 'market-ml-model.v1' as const,
    algorithm: 'FULL_BATCH_MULTINOMIAL_LOGISTIC_V1' as const,
    execution: 'DISABLED' as const,
    codeVersion,
    runtime: 'node-24.22.2/ieee754-binary64.v1' as const,
    availableAt: cfg.generatedAt,
    config: cfg,
    sourcePanel: v.manifest,
    splitHash: canonicalHash(a.request.splits),
    featureSchema,
    featureConfig: a.input.technicalArtifacts[0]!.request.config,
    intervalSeconds: a.request.intervalSeconds,
    historyStartCloseAt: a.input.technicalArtifacts[0]!.request.historyStartCloseAt,
    instrumentKeys: a.request.instrumentKeys,
    scaler,
    training: {
      ...fit,
      rowIds: train.map((r) => r.row.id),
      rowsHash: fittingRowsHash(train),
      maxLabelAvailableAt: train
        .map((r) => r.labelAvailableAt)
        .sort()
        .at(-1)!,
      classCounts,
    },
    calibration: {
      method: 'VALIDATION_TEMPERATURE_GRID_V1' as const,
      fitSplit: 'VALIDATION' as const,
      rowIds: cal.map((r) => r.row.id),
      rowsHash: fittingRowsHash(cal),
      maxLabelAvailableAt: cal
        .map((r) => r.labelAvailableAt)
        .sort()
        .at(-1)!,
      temperatures: [...temperatures],
      temperature: best.temperature,
      trials,
    },
  };
  const model: MarketMlModel = validateMarketModel({
      ...body,
      id: deterministicId('market-logistic', body),
    }),
    prior = classCounts.map((n) => (n + 1) / (train.length + 3)) as Vector3,
    baseline = maBaseline(a, model);
  const predictions: MarketMlPrediction[] = rows
    .filter((r) => r.row.split !== 'TRAIN')
    .map((r) => {
      const raw = r.values === null ? prior : probabilities(model, r.values, 1),
        p = r.values === null ? prior : probabilities(model, r.values);
      return {
        rowId: r.row.id,
        instrumentKey: r.row.instrumentKey,
        featureAsOf: r.row.featureAsOf,
        split: r.row.split as 'VALIDATION' | 'TEST',
        label: r.label,
        labelAvailableAt: r.labelAvailableAt,
        inputHash: canonicalHash({ features: r.row.features, sourceHashes: r.row.sourceHashes }),
        ml: forecast(p, cfg, r.values === null),
        uncalibrated: raw,
        prior: forecast(prior, cfg),
        neutral: 'HOLD',
        ma: baseline(r.row.instrumentKey, r.row.featureAsOf),
      };
    });
  const report = MarketMlReportSchema.parse({
    schemaVersion: 'market-ml-report.v1',
    execution: 'DISABLED',
    mode: 'RETROSPECTIVE_OUT_OF_SAMPLE',
    model,
    modelHash: canonicalHash(model),
    panelRequest: a.request,
    audit: {
      panelIncluded: v.rows.length,
      trainRows: train.length,
      validationRows: cal.length,
      testRows: test.length,
      missingFeatureRows: rows.filter((r) => r.values === null).map((r) => r.row.id),
      panelPurged: a.audit.purgedCount,
      panelEmbargoed: a.audit.embargoedCount,
      labelPolicy: 'FIXED_HORIZON_RETURN_SYMMETRIC_BAND_INCLUSIVE_HOLD_V1',
      scalerPolicy: 'TRAIN_ONLY_NO_IMPUTATION_CLIP_8',
      fittingClock: 'ASSERTED_RESEARCH_CUTOFFS_ACTUAL_AVAILABILITY_IS_GENERATED_AT',
    },
    predictions,
    predictionHash: canonicalHash(predictions),
    ...evaluateMl(predictions, cfg),
    warnings: [
      'Historical predictions are retrospective held-out research, not signals known before actual model publication. Research cutoffs are operator assertions; availableAt equals generatedAt.',
      'Class probabilities estimate fixed-horizon gross return bands, not execution returns, profitability, trade confidence or independent calibrated guarantees.',
      'Training/scaling use TRAIN only. Validation alone chooses temperature from four predeclared values; TEST never fits parameters, scaler, thresholds or calibration.',
      'Empty calibration bins remain null; validation curves reuse the calibration sample. Correlated time-series rows and small synthetic samples do not establish calibration or generalization.',
      'Missing features are excluded from fitting. Held-out missing rows abstain with an explicitly marked TRAIN-prior probability fallback; no zero-value imputation.',
      'Mandatory TRAIN class prior, ALWAYS_HOLD and fixed symmetric MA 2/4 direction baselines share held-out rows. These are classification diagnostics, not costed trading PnL; existing deterministic costed baselines remain mandatory.',
      'All four calibration trials are retained. No hyperparameter search, regime ranking, best model selection, live execution or short borrowing is performed.',
      'Reproducibility is scoped to the pinned Node runtime and canonical row order; model software labels and hashes are provenance, not authentication.',
    ],
  });
  deepFreeze(report);
  return report;
}
