import { z } from 'zod';
import {
  DatasetPanelManifestSchema,
  DatasetPanelRequestSchema,
  PanelFeatureCellSchema,
} from './dataset-panel.js';
import { TechnicalFeatureConfigSchema } from './technical-features.js';
import {
  HashSchema,
  IdSchema,
  NonNegativeDecimalSchema,
  SeedSchema,
  UtcTimestampSchema,
} from './primitives.js';
export const MarketClassSchema = z.enum(['DOWN', 'HOLD', 'UP']);
export type MarketClass = z.infer<typeof MarketClassSchema>;
export const MlFeatureNameSchema = z.enum([
  'technical.return_1',
  'technical.return_2',
  'technical.sma',
  'technical.ema',
  'technical.relative_volume',
  'technical.z_score',
  'technical.rolling_volatility',
  'technical.atr',
]);
export const MarketMlConfigSchema = z
  .strictObject({
    schemaVersion: z.literal('market-ml-config.v1'),
    horizonBars: z.number().int().min(1).max(100),
    abstentionReturnBps: NonNegativeDecimalSchema,
    featureColumns: z.array(MlFeatureNameSchema).min(1).max(8),
    randomSeed: SeedSchema,
    epochs: z.number().int().min(1).max(1000),
    learningRate: z.number().gt(0).max(1),
    l2: z.number().min(0).max(10),
    minimumTrainRows: z.number().int().min(6).max(2000),
    minimumValidationRows: z.number().int().min(3).max(2000),
    minimumTestRows: z.number().int().min(3).max(2000),
    fitCutoff: UtcTimestampSchema,
    calibrationCutoff: UtcTimestampSchema,
    generatedAt: UtcTimestampSchema,
    confidenceThreshold: z.number().min(0.5).max(1),
    directionalMargin: z.number().min(0).max(1),
    maxFeatureAgeSeconds: z.number().int().min(1).max(3600),
  })
  .superRefine((v, c) => {
    if (
      new Set(v.featureColumns).size !== v.featureColumns.length ||
      Number(v.abstentionReturnBps) > 10000 ||
      v.fitCutoff >= v.calibrationCutoff ||
      v.calibrationCutoff > v.generatedAt
    )
      c.addIssue({ code: 'custom', message: 'Invalid feature, band or cutoff policy' });
  });
export type MarketMlConfig = z.infer<typeof MarketMlConfigSchema>;
export const MlProbabilitiesSchema = z
  .tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1)])
  .refine(
    (p) => Math.abs(p.reduce((a, b) => a + b, 0) - 1) < 1e-10,
    'Probabilities must sum to one',
  );
export const MlForecastSchema = z.strictObject({
  probabilities: MlProbabilitiesSchema,
  predictedClass: MarketClassSchema,
  action: z.enum(['LONG', 'SHORT', 'HOLD']),
  reason: z.enum(['DIRECTIONAL', 'CLASS_HOLD', 'LOW_CONFIDENCE', 'MISSING_FEATURE']),
  score: z.number().min(-1).max(1),
});
export type MlForecast = z.infer<typeof MlForecastSchema>;
const catalog = z
  .array(z.strictObject({ name: MlFeatureNameSchema, definitionHash: HashSchema }))
  .min(1)
  .max(8);
export const MarketMlModelSchema = z
  .strictObject({
    schemaVersion: z.literal('market-ml-model.v1'),
    id: IdSchema,
    algorithm: z.literal('FULL_BATCH_MULTINOMIAL_LOGISTIC_V1'),
    execution: z.literal('DISABLED'),
    codeVersion: z.string().min(1).max(200),
    runtime: z.literal('node-24.22.2/ieee754-binary64.v1'),
    availableAt: UtcTimestampSchema,
    config: MarketMlConfigSchema,
    sourcePanel: DatasetPanelManifestSchema,
    splitHash: HashSchema,
    featureSchema: catalog,
    featureConfig: TechnicalFeatureConfigSchema,
    intervalSeconds: z.number().int().positive(),
    historyStartCloseAt: UtcTimestampSchema,
    instrumentKeys: z.array(IdSchema).min(1).max(20),
    scaler: z.strictObject({
      fitSplit: z.literal('TRAIN'),
      rowIds: z.array(IdSchema).min(6).max(2000),
      means: z.array(z.number()),
      scales: z.array(z.number().positive()),
      clip: z.literal(8),
      hash: HashSchema,
    }),
    training: z.strictObject({
      rowIds: z.array(IdSchema).min(6).max(2000),
      rowsHash: HashSchema,
      maxLabelAvailableAt: UtcTimestampSchema,
      classCounts: z.tuple([
        z.number().int().nonnegative(),
        z.number().int().nonnegative(),
        z.number().int().nonnegative(),
      ]),
      initialLoss: z.number().nonnegative(),
      finalLoss: z.number().nonnegative(),
      weights: z.array(z.array(z.number())).length(3),
      biases: z.tuple([z.number(), z.number(), z.number()]),
    }),
    calibration: z.strictObject({
      method: z.literal('VALIDATION_TEMPERATURE_GRID_V1'),
      fitSplit: z.literal('VALIDATION'),
      rowIds: z.array(IdSchema).min(3).max(2000),
      rowsHash: HashSchema,
      maxLabelAvailableAt: UtcTimestampSchema,
      temperatures: z.tuple([z.literal(0.5), z.literal(1), z.literal(2), z.literal(4)]),
      temperature: z.number().positive(),
      trials: z
        .array(
          z.strictObject({ temperature: z.number().positive(), logLoss: z.number().nonnegative() }),
        )
        .length(4),
    }),
  })
  .superRefine((m, c) => {
    const n = m.featureSchema.length;
    if (
      m.scaler.means.length !== n ||
      m.scaler.scales.length !== n ||
      m.training.weights.some((w) => w.length !== n) ||
      m.availableAt !== m.config.generatedAt ||
      m.training.maxLabelAvailableAt > m.config.fitCutoff ||
      m.calibration.maxLabelAvailableAt > m.config.calibrationCutoff
    )
      c.addIssue({
        code: 'custom',
        message: 'Model dimension, availability or fitting cutoff mismatch',
      });
  });
export type MarketMlModel = z.infer<typeof MarketMlModelSchema>;
export const MarketMlInferenceSchema = z.strictObject({
  schemaVersion: z.literal('market-ml-inference.v1'),
  instrumentKey: IdSchema,
  featureAsOf: UtcTimestampSchema,
  decisionAt: UtcTimestampSchema,
  features: z.array(PanelFeatureCellSchema).min(1).max(8),
});
export const MarketMlPredictionSchema = z.strictObject({
  rowId: IdSchema,
  instrumentKey: IdSchema,
  featureAsOf: UtcTimestampSchema,
  split: z.enum(['VALIDATION', 'TEST']),
  label: MarketClassSchema,
  labelAvailableAt: UtcTimestampSchema,
  inputHash: HashSchema,
  ml: MlForecastSchema,
  uncalibrated: MlProbabilitiesSchema,
  prior: MlForecastSchema,
  neutral: MarketClassSchema,
  ma: MarketClassSchema,
});
export type MarketMlPrediction = z.infer<typeof MarketMlPredictionSchema>;
const metric = z.strictObject({
  rows: z.number().int().nonnegative(),
  accuracy: z.number().min(0).max(1).nullable(),
  actionCoverage: z.number().min(0).max(1).nullable(),
  logLoss: z.number().nonnegative().nullable(),
  brier: z.number().nonnegative().nullable(),
  confusion: z.array(z.array(z.number().int().nonnegative()).length(3)).length(3),
});
export const MarketMlReportSchema = z.strictObject({
  schemaVersion: z.literal('market-ml-report.v1'),
  execution: z.literal('DISABLED'),
  mode: z.literal('RETROSPECTIVE_OUT_OF_SAMPLE'),
  model: MarketMlModelSchema,
  modelHash: HashSchema,
  panelRequest: DatasetPanelRequestSchema,
  audit: z.strictObject({
    panelIncluded: z.number().int().nonnegative(),
    trainRows: z.number().int().nonnegative(),
    validationRows: z.number().int().nonnegative(),
    testRows: z.number().int().nonnegative(),
    missingFeatureRows: z.array(IdSchema),
    panelPurged: z.number().int().nonnegative(),
    panelEmbargoed: z.number().int().nonnegative(),
    labelPolicy: z.literal('FIXED_HORIZON_RETURN_SYMMETRIC_BAND_INCLUSIVE_HOLD_V1'),
    scalerPolicy: z.literal('TRAIN_ONLY_NO_IMPUTATION_CLIP_8'),
    fittingClock: z.literal('ASSERTED_RESEARCH_CUTOFFS_ACTUAL_AVAILABILITY_IS_GENERATED_AT'),
  }),
  predictions: z.array(MarketMlPredictionSchema).max(4000),
  predictionHash: HashSchema,
  metrics: z
    .array(
      z.strictObject({
        split: z.enum(['VALIDATION', 'TEST']),
        provider: z.enum(['ML', 'UNCALIBRATED_ML', 'TRAIN_CLASS_PRIOR', 'ALWAYS_HOLD', 'MA_2_4']),
        metric,
      }),
    )
    .length(10),
  calibrationCurves: z
    .array(
      z.strictObject({
        split: z.enum(['VALIDATION', 'TEST']),
        class: MarketClassSchema,
        bins: z
          .array(
            z.strictObject({
              lower: z.number(),
              upper: z.number(),
              count: z.number().int().nonnegative(),
              meanProbability: z.number().nullable(),
              observedFraction: z.number().nullable(),
            }),
          )
          .length(10),
      }),
    )
    .length(6),
  warnings: z.array(z.string()),
});
export type MarketMlReport = z.infer<typeof MarketMlReportSchema>;
export const MarketMlBundleSchema = z.strictObject({
  schemaVersion: z.literal('market-ml-bundle.v1'),
  id: IdSchema,
  reportHash: HashSchema,
  files: z.strictObject({
    reportJson: HashSchema,
    reportMarkdown: HashSchema,
    modelJson: HashSchema,
    configJson: HashSchema,
    predictionsJson: HashSchema,
  }),
});
