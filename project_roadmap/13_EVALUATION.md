# Module 13 — Quantitative Evaluation and Research Integrity

## Objective
Build a reporting pipeline that can show when a strategy fails, when apparent wins are noise and whether news adds incremental value to market-only signals.

## Dependencies
08 and 12 (plus 06 and 11 for event/fusion analyses).

## Iteration 1 Prompt — Reproducible Metrics
Compute total/net return, nominal PnL, trade count, profit factor with safe undefined handling, win rate, average win/loss, expectancy after fees, max drawdown, recovery factor, daily return volatility, turnover, slippage, time in market, exposure, event coverage, rejected signals and paper fill rates. Compare to cash and passive buy-and-hold over identical periods. Expose both per-trade and daily equity aggregates.

### Acceptance
Hand-calculated fixtures for zero trades, zero losses, negative equity attempt and nonuniform timestamps; undefined ratios display `N/A` not infinity; initial/final cash plus holdings reconciles with ledger.

## Iteration 2 Prompt — Statistical Uncertainty and Bias Checks
Report confidence intervals using block/bootstrap or methods that account for serial dependence and overlapping trades. Include sample size, number of experiments/hyperparameter trials, multiple-comparison correction or transparent warning, walk-forward and purged time splits. Test performance under fees/slippage multipliers and lagged entry. Add performance by asset, month, regime, news category and volatility tier; don't use ML test results to tune decisions without creating a new holdout.

### Acceptance
Too-few-trades report warns 'insufficient evidence'; shuffling dependent returns is not falsely called an independent bootstrap; a hypothetical strategy that relies entirely on one tail event is flagged.

## Iteration 3 Prompt — Attribution and Decision Memo
Generate a side-by-side, versioned four-arm report including gross/net contributions, paired daily differences, model calibration, disagreement analysis, news provenance failure modes, time-to-market after news, baseline comparisons and lessons learned. Write a concise final `Continue / Revise / Stop` decision memo based on **predeclared** thresholds and uncertainty, not top-line PnL alone. Keep all losing runs searchable.

### Acceptance
Report hyperlinks to exact experiment/signal/market/news evidence; missing or late news prominently labeled; no claim of statistically significant alpha without a defensible test.

## Handoff / Review Prompt
Deliver sample reports on deterministic toy datasets and one deliberately misleading profitable backtest. Explain why it does not prove alpha. Handoff frozen report schema to Module 14 and experiment protocol to Module 15.
