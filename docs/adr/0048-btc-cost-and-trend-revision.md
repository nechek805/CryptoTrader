# ADR 0048: Preserve the BTC baseline and compare one cost-aware trend revision

The user requested trade-level diagnosis, an improved algorithm and a rerun comparable
with the original −70.70 USDT result. The selected snapshot remains unchanged: 4,416
real hourly BTCUSDT candles, 2026-05-04 07:00 to 2026-11-04 07:00 UTC, end exclusive.
The original report and v1 engine source are preserved. A compatibility replay in the
new engine must reproduce every original decision, fill, summary and journal hash.

Diagnosis found weak net trade expectancy and substantial turnover costs. Fifty closed
trades returned −72.5291887919 USDT; the remaining open-position contribution was
+1.8266326628 USDT. Fees were 100.5465538291 USDT, with another 50.2799367 USDT of
adverse slippage embedded in fill prices. Thirty-two trades held for at most twelve
hours returned −118.7617581136 USDT. This supports testing fewer weak entries, without
claiming that the observed loss decomposition proves a causal market relationship.

One candidate was declared before inspecting its rerun: retain MA20/MA50, ATR14,
2 ATR stop, 3 ATR target, original fees/slippage, sizing and cash limits; require:

- A fresh bullish crossover after sufficient context, without initial bullish entry.
- Close above MA200 and MA200 greater than its level 24 completed hours earlier.
- Target distance at least three times estimated round-trip fee plus slippage costs,
  checked both at decision and at the following opening price.

The revision uses 224 completed hours for context. No thresholds were searched or
changed to improve the observed results. Implementation/replay QA is not another
independent model trial. The frozen candidate count is one revision plus the original.

The old engine remains a compatibility reference in its original source file. A separate
versioned engine supports original-compatible and filtered modes plus explicit research
windows. Meaningful tests enforce original identity, causal features, fresh crossovers,
trend/cost blocks, opening-gap rejection, risk/cost caps, adverse-first exits, bounded
window trading, balance resets, attribution and deterministic replay. Original-compatible
window behavior is checked against the original engine over the full snapshot.

Two chronological checks restart with 10,000 USDT and empty positions while using only
past candles for feature context. The first uses two thirds of the snapshot; the second
uses its final third. Original entry eligibility at an independent window start is
retained; v2 requires a fresh crossover. Window results therefore are not additive.
The data had already been seen, so these are exploratory diagnostics, not untouched
holdout validation. This follows the concern about repeated historical selection in
[Bailey et al., The Probability of Backtest Overfitting](https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf).

The revision reduces historical loss and turnover but remains slightly negative. Its
later chronological check also loses money, with only four trades. No forward strategy
or previously frozen experiment is promoted or rewritten. Cash remains a benchmark.
Historical availability stays UNKNOWN and fills remain retrospective assumptions.

The local dashboard can run the comparison, inspect either immutable version, display
loss attribution and chronological checks, and export the comparison. Startup verifies
cached comparisons against current deterministic replay. New downloads invalidate the
active comparison, while retaining older files. API selection and comparison remain
authenticated local research operations with existing Origin and rate-limit checks.

See [the full results](../btc-strategy-revision-2026-11-04.md).
