import { SeededRandom } from '@crypto/core';
import type { MarketClass, MarketMlConfig, MarketMlModel, MlForecast } from '@crypto/contracts';
export const classes = ['DOWN', 'HOLD', 'UP'] as const;
export type Vector3 = [number, number, number];
export function softmax(logits: readonly number[], temperature = 1): Vector3 {
  const maximum = Math.max(...logits),
    exp = logits.map((x) => Math.exp((x - maximum) / temperature)),
    sum = exp.reduce((a, b) => a + b, 0);
  const p = exp.map((x) => x / sum);
  if (p.length !== 3 || p.some((x) => !Number.isFinite(x)))
    throw new Error('Non-finite logistic probabilities');
  return [p[0]!, p[1]!, p[2]!];
}
export function transform(values: number[], means: number[], scales: number[]) {
  return values.map((v, i) => Math.max(-8, Math.min(8, (v - means[i]!) / scales[i]!)));
}
export function logits(weights: number[][], biases: readonly number[], x: readonly number[]) {
  return weights.map((w, k) => w.reduce((sum, v, j) => sum + v * x[j]!, biases[k]!));
}
export function logLoss(probs: readonly (readonly number[])[], ys: readonly number[]) {
  return probs.reduce((sum, p, i) => sum - Math.log(Math.max(1e-15, p[ys[i]!]!)), 0) / ys.length;
}
export function fitLogistic(xs: number[][], ys: number[], cfg: MarketMlConfig) {
  const width = xs[0]!.length,
    random = new SeededRandom(cfg.randomSeed),
    weights = classes.map(() => Array.from({ length: width }, () => (random.next() - 0.5) * 0.002)),
    biases: Vector3 = [0, 0, 0];
  const loss = () =>
    logLoss(
      xs.map((x) => softmax(logits(weights, biases, x))),
      ys,
    ) +
    (cfg.l2 * weights.flat().reduce((s, w) => s + w * w, 0)) / 2;
  const initialLoss = loss();
  for (let epoch = 0; epoch < cfg.epochs; epoch++) {
    const dw = classes.map(() => Array<number>(width).fill(0)),
      db = [0, 0, 0];
    for (let i = 0; i < xs.length; i++) {
      const x = xs[i]!,
        p = softmax(logits(weights, biases, x));
      for (let k = 0; k < 3; k++) {
        const error = p[k]! - (ys[i] === k ? 1 : 0);
        db[k] = db[k]! + error;
        for (let j = 0; j < width; j++) dw[k]![j] = dw[k]![j]! + error * x[j]!;
      }
    }
    for (let k = 0; k < 3; k++) {
      biases[k] = biases[k]! - (cfg.learningRate * db[k]!) / xs.length;
      for (let j = 0; j < width; j++)
        weights[k]![j] =
          weights[k]![j]! - cfg.learningRate * (dw[k]![j]! / xs.length + cfg.l2 * weights[k]![j]!);
    }
  }
  const finalLoss = loss();
  if (!Number.isFinite(finalLoss) || finalLoss > initialLoss + 1e-10)
    throw new Error('Logistic fit diverged; fixed configuration rejected');
  return { weights, biases, initialLoss, finalLoss };
}
export function forecast(probabilities: Vector3, cfg: MarketMlConfig, missing = false): MlForecast {
  // Deterministic ties prefer abstention, then DOWN; never infer a tie as confidence.
  let k = 1;
  for (const j of [0, 2]) if (probabilities[j]! > probabilities[k]!) k = j;
  const predictedClass = classes[k]!,
    reason = missing
      ? 'MISSING_FEATURE'
      : k === 1
        ? 'CLASS_HOLD'
        : probabilities[k]! < cfg.confidenceThreshold ||
            Math.abs(probabilities[2] - probabilities[0]) <= cfg.directionalMargin
          ? 'LOW_CONFIDENCE'
          : 'DIRECTIONAL';
  return {
    probabilities,
    predictedClass,
    action: reason === 'DIRECTIONAL' ? (k === 2 ? 'LONG' : 'SHORT') : 'HOLD',
    reason,
    score: missing ? 0 : probabilities[2] - probabilities[0],
  };
}
export function probabilities(
  model: MarketMlModel,
  values: number[],
  temperature = model.calibration.temperature,
) {
  return softmax(
    logits(
      model.training.weights,
      model.training.biases,
      transform(values, model.scaler.means, model.scaler.scales),
    ),
    temperature,
  );
}
export function actionClass(f: MlForecast): MarketClass {
  return f.action === 'LONG' ? 'UP' : f.action === 'SHORT' ? 'DOWN' : 'HOLD';
}
