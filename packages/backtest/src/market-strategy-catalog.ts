import { BTC_PLAN, BTC_PLAN_V2, BTC_PLAN_V3, MarketCatalogSchema } from '@crypto/contracts';
export const MARKET_STRATEGY_CATALOG = MarketCatalogSchema.parse([
  {
    key: 'V1',
    name: 'MA crossover',
    description:
      'A broad trend-following baseline using 20-hour and 50-hour simple moving averages.',
    rules: [
      'Buy a bullish MA20/MA50 crossover, including a bullish first complete 50-hour window.',
      'Exit at a bearish crossover, 2 ATR stop or 3 ATR target.',
    ],
    intendedImprovement: 'A transparent baseline with more entry opportunities.',
    failureModes: [
      'Repeated short-lived crossovers can create whipsaw losses.',
      'Fees and slippage can consume a small price edge.',
      'No longer-term trend or reward-to-cost filter.',
    ],
    warmupHours: 50,
    reference: BTC_PLAN,
  },
  {
    key: 'V2',
    name: 'Trend and cost filters',
    description:
      'The baseline with a longer-term trend gate and minimum reward-to-cost requirement.',
    rules: [
      'Require a fresh bullish crossover, close above MA200, and MA200 higher than 24 hours earlier.',
      'Require the 3 ATR target distance to cover at least 3 times estimated round-trip costs; recheck at the next open.',
      'Keep the same stops, targets, fees and risk limits as v1.',
    ],
    intendedImprovement:
      'Avoid some weak-regime and cost-dominated entries; its improvement must be measured per asset.',
    failureModes: [
      'Weak signal candles can still trigger fast stop-outs.',
      'Filters may miss profitable moves and leave long periods in cash.',
      'The original BTC test remained slightly negative.',
    ],
    warmupHours: 224,
    reference: BTC_PLAN_V2,
  },
  {
    key: 'V3',
    name: 'Candle quality',
    description: 'V2 with two completed-candle entry-quality gates.',
    rules: [
      'Retain every v2 gate.',
      'Require the signal close in the upper half of a nonzero high-to-low range.',
      'Reject signal candles whose range exceeds 2 ATR14.',
    ],
    intendedImprovement:
      'Avoid some weak closes and unusually large impulse candles without raising position risk.',
    failureModes: [
      'It also rejects some winners.',
      'Few qualified trades make results uncertain.',
      'Its original BTC profit was small and failed the same-fill double-cost diagnostic.',
    ],
    warmupHours: 224,
    reference: BTC_PLAN_V3,
  },
]);
