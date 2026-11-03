import type {
  MarketMlPrediction,
  MarketMlReport,
  MarketMlModel,
  MarketClass,
  MarketMlConfig,
} from '@crypto/contracts';
import { SnapshotTechnicalFeatures } from '@crypto/research';
import { MarketStrategySourceSchema, compareDecimal } from '@crypto/contracts';
import { MarketEligibility } from './eligibility.js';
import type { DatasetPanelArtifact } from '@crypto/contracts';
import { classes, actionClass, forecast } from './market-ml-math.js';
type Probability = readonly number[];
function metrics(labels: MarketClass[], predicted: MarketClass[], ps: Probability[] | null) {
  const n = labels.length,
    confusion = classes.map(() => [0, 0, 0]);
  let correct = 0,
    active = 0,
    loss = 0,
    brier = 0;
  labels.forEach((label, i) => {
    const y = classes.indexOf(label),
      p = predicted[i]!;
    confusion[y]![classes.indexOf(p)]!++;
    if (label === p) correct++;
    if (p !== 'HOLD') active++;
    if (ps) {
      loss -= Math.log(Math.max(1e-15, ps[i]![y]!));
      brier += ps[i]!.reduce((s, v, k) => s + (v - (k === y ? 1 : 0)) ** 2, 0);
    }
  });
  return {
    rows: n,
    accuracy: n ? correct / n : null,
    actionCoverage: n ? active / n : null,
    logLoss: n && ps ? loss / n : null,
    brier: n && ps ? brier / n : null,
    confusion,
  };
}
export function evaluateMl(predictions: MarketMlPrediction[], config: MarketMlConfig) {
  const result: MarketMlReport['metrics'] = [],
    curves: MarketMlReport['calibrationCurves'] = [];
  for (const split of ['VALIDATION', 'TEST'] as const) {
    const rows = predictions.filter((r) => r.split === split),
      labels = rows.map((r) => r.label);
    for (const provider of [
      'ML',
      'UNCALIBRATED_ML',
      'TRAIN_CLASS_PRIOR',
      'ALWAYS_HOLD',
      'MA_2_4',
    ] as const) {
      const ps =
        provider === 'ML'
          ? rows.map((r) => r.ml.probabilities)
          : provider === 'UNCALIBRATED_ML'
            ? rows.map((r) => r.uncalibrated)
            : provider === 'TRAIN_CLASS_PRIOR'
              ? rows.map((r) => r.prior.probabilities)
              : null;
      const predicted = rows.map((r) =>
        provider === 'ML'
          ? actionClass(r.ml)
          : provider === 'UNCALIBRATED_ML'
            ? actionClass(forecast(r.uncalibrated, config, r.ml.reason === 'MISSING_FEATURE'))
            : provider === 'TRAIN_CLASS_PRIOR'
              ? actionClass(r.prior)
              : provider === 'ALWAYS_HOLD'
                ? r.neutral
                : r.ma,
      );
      result.push({ split, provider, metric: metrics(labels, predicted, ps) });
    }
    for (const [index, cls] of classes.entries())
      curves.push({
        split,
        class: cls,
        bins: Array.from({ length: 10 }, (_, bin) => {
          const selected = rows.filter(
            (r) => Math.min(9, Math.floor(r.ml.probabilities[index]! * 10)) === bin,
          );
          return {
            lower: bin / 10,
            upper: (bin + 1) / 10,
            count: selected.length,
            meanProbability: selected.length
              ? selected.reduce((s, r) => s + r.ml.probabilities[index]!, 0) / selected.length
              : null,
            observedFraction: selected.length
              ? selected.filter((r) => r.label === cls).length / selected.length
              : null,
          };
        }),
      });
  }
  return { metrics: result, calibrationCurves: curves };
}
/** A fixed symmetric 2/4 SMA direction rule, evaluated at exactly the held-out feature clock. */
export function maBaseline(a: DatasetPanelArtifact, model: MarketMlModel) {
  const audits = new Map(
    a.input.bindings.map((b) => [
      b.instrumentKey,
      new MarketEligibility(
        MarketStrategySourceSchema.parse({
          schemaVersion: 'market-strategy-source.v1',
          market: a.input.market,
          sourceId: b.sourceId,
          instrumentKey: b.instrumentKey,
          series: b.series,
          portfolio: 'BASELINE',
          intervalSeconds: model.intervalSeconds,
          historyStartCloseAt: model.historyStartCloseAt,
          maxBarDelayMs: 30000,
        }),
      ),
    ]),
  );
  const engines = a.input.technicalArtifacts.map((artifact) => ({
    artifact,
    engine: new SnapshotTechnicalFeatures(artifact.input),
  }));
  return (instrumentKey: string, featureAsOf: MarketMlPrediction['featureAsOf']): MarketClass => {
    const binding = a.input.bindings.find((b) => b.instrumentKey === instrumentKey)!;
    const source = engines.find(
      (v) =>
        v.artifact.request.series.instrumentId === binding.series.instrumentId &&
        v.artifact.request.series.exchange === binding.series.exchange &&
        v.artifact.request.series.marketType === binding.series.marketType,
    );
    if (!source) throw new Error('Mandatory MA baseline has no registered source');
    const value = (period: number) => {
      const row = source.engine.query({
          schemaVersion: 'technical-feature-query.v1',
          series: binding.series,
          intervalSeconds: model.intervalSeconds,
          historyStartCloseAt: source.artifact.request.historyStartCloseAt,
          featureAsOf,
          config: { ...source.artifact.request.config, smaPeriod: period },
        }),
        feature = row.features.find((f) => f.featureId === 'sma')!;
      if (
        feature.inputBarIds.some((id) => {
          const bar = source.artifact.input.bars.find((b) => b.id === id);
          return !bar || !audits.get(instrumentKey)!.bar(bar, featureAsOf);
        })
      )
        return null;
      return feature.value;
    };
    const fast = value(2),
      slow = value(4);
    return fast === null || slow === null
      ? 'HOLD'
      : compareDecimal(fast, slow) > 0
        ? 'UP'
        : compareDecimal(fast, slow) < 0
          ? 'DOWN'
          : 'HOLD';
  };
}
export function marketMlMarkdown(r: MarketMlReport) {
  return `# Market ML research\n\nRETROSPECTIVE OUT-OF-SAMPLE; execution DISABLED.\n\n${r.panelRequest.cohortDisclosure}\n\nModel: ${r.model.id}\n\nPanel: ${r.model.sourcePanel.id}; Parquet: ${r.model.sourcePanel.parquetHash}\n\nModel available at: ${r.model.availableAt}. Historical research cutoffs do not establish historical model availability.\n\nTRAIN-only scaling; validation temperature ${r.model.calibration.temperature}; untouched TEST. Classes DOWN/HOLD/UP; inclusive return band ${r.model.config.abstentionReturnBps} bps.\n\n| Split | Provider | Rows | Action accuracy | Action coverage | Log loss | Brier |\n| --- | --- | ---: | ---: | ---: | ---: | ---: |\n${r.metrics.map((m) => `| ${m.split} | ${m.provider} | ${m.metric.rows} | ${m.metric.accuracy} | ${m.metric.actionCoverage} | ${m.metric.logLoss} | ${m.metric.brier} |`).join('\n')}\n\nValidation curves are in-sample calibration diagnostics; TEST curves are held-out diagnostics. Ten bins per class, null empty bins; see report.json.\n\n${r.warnings.map((w) => `- ${w}`).join('\n')}\n`;
}
