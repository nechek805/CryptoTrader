import { TechnicalFeatureConfigSchema, TechnicalFeatureDefinitionSchema } from '@crypto/contracts';
import { deepFreeze } from '@crypto/core';

export function technicalFeatureCatalog(input: unknown) {
  const c = TechnicalFeatureConfigSchema.parse(input),
    definitions = [
      {
        featureId: 'sma',
        formula: `mean(last ${c.smaPeriod} closes including anchor)`,
        inputs: ['close'],
        warmupBars: c.smaPeriod,
        historyPolicy: 'FIXED_WINDOW',
        units: 'PRICE',
      },
      {
        featureId: 'ema',
        formula: `alpha=2/(${c.emaPeriod}+1); seed SMA of first ${c.emaPeriod} consecutive closes; EMA=alpha*close+(1-alpha)*previous; reset after gaps`,
        inputs: ['close'],
        warmupBars: c.emaPeriod,
        historyPolicy: 'CONSECUTIVE_SEGMENT_FROM_DECLARED_START',
        units: 'PRICE',
      },
      ...c.returnHorizonsBars.map((h) => ({
        featureId: `return_${h}`,
        formula: `anchor.close / close[anchor-${h} bars] - 1; require consecutive path`,
        inputs: ['close'],
        warmupBars: h + 1,
        historyPolicy: 'FIXED_WINDOW',
        units: 'FRACTION',
      })),
      {
        featureId: 'rolling_volatility',
        formula: `population standard deviation of ${c.volatilityPeriod} adjacent log(close/previousClose) returns; unannualized`,
        inputs: ['close'],
        warmupBars: c.volatilityPeriod + 1,
        historyPolicy: 'FIXED_WINDOW',
        units: 'FRACTION',
      },
      {
        featureId: 'atr',
        formula: `TR=max(high-low,abs(high-previousClose),abs(low-previousClose)); seed mean of ${c.atrPeriod} TRs, then Wilder ((previousATR*(${c.atrPeriod}-1))+TR)/${c.atrPeriod}; reset after gaps`,
        inputs: ['high', 'low', 'close'],
        warmupBars: c.atrPeriod + 1,
        historyPolicy: 'CONSECUTIVE_SEGMENT_FROM_DECLARED_START',
        units: 'PRICE',
      },
      {
        featureId: 'relative_volume',
        formula: `anchor.volume / mean(previous ${c.relativeVolumePeriod} base volumes excluding anchor)`,
        inputs: ['volume'],
        warmupBars: c.relativeVolumePeriod + 1,
        historyPolicy: 'FIXED_WINDOW',
        units: 'DIMENSIONLESS',
      },
      {
        featureId: 'z_score',
        formula: `(anchor.close - mean(previous ${c.zScorePeriod} closes)) / populationStd(previous closes); exclude anchor from reference`,
        inputs: ['close'],
        warmupBars: c.zScorePeriod + 1,
        historyPolicy: 'FIXED_WINDOW',
        units: 'DIMENSIONLESS',
      },
      {
        featureId: 'breakout_upper',
        formula: `max(high of previous ${c.breakoutPeriod} bars excluding anchor)`,
        inputs: ['high'],
        warmupBars: c.breakoutPeriod + 1,
        historyPolicy: 'FIXED_WINDOW',
        units: 'PRICE',
      },
      {
        featureId: 'breakout_lower',
        formula: `min(low of previous ${c.breakoutPeriod} bars excluding anchor)`,
        inputs: ['low'],
        warmupBars: c.breakoutPeriod + 1,
        historyPolicy: 'FIXED_WINDOW',
        units: 'PRICE',
      },
      {
        featureId: 'candle_gap',
        formula:
          'anchor.open / previous.close - 1; missing candle slots are separately recorded in coverage',
        inputs: ['open', 'close'],
        warmupBars: 2,
        historyPolicy: 'FIXED_WINDOW',
        units: 'FRACTION',
      },
    ].map((d) =>
      TechnicalFeatureDefinitionSchema.parse({
        ...d,
        version: 'technical-features.v1',
        availabilityLag: 'VARIABLE_SOURCE_LAG_MAX_INPUT_AVAILABLE_AT_COMPUTE_LAG_UNMODELED',
        nanPolicy: 'NULL_WITH_REASON_NEVER_NAN_OR_INFINITY',
      }),
    );
  deepFreeze(definitions);
  return definitions;
}
