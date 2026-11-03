# ADR 0021: Versioned counterfactual backtests with causal marks and explicit unknowns

Status: accepted, 2026-11-01. Scope: Module 08, Iteration 3.

Wrap existing replay and spot execution with a strict self-contained manifest and
versioned execution assumptions. Freeze source/config/scenario identity; assert a
predeclared assumption time without claiming authenticated prospective registration.
Support one explicit spot series and cash-started BASELINE account per counterfactual.
Run strategy, cash and quantity-matched buy-and-hold independently with identical
starting capital, feed, window, sizing policy and execution constraints.

Register only neutral/buy-and-hold controls and synthetic losing/leaking diagnostics.
Use the existing immutable Strategy/ReplayContext and explicit candidate/risk/order
bridge; preserve executor vetoes and command-before-price matching. Trusted custom
factories must match descriptors and rerun identically. Unsupported depth/funding,
absent timed news and scenarios with no eligible candles fail rather than inventing
inputs. Future reads remain fatal before report publication.

Evaluate predeclared fee/spread/slippage/latency/omission scenarios without selecting
the best result. Assert identical gross and non-improving net PnL for higher-fee-only
cases with identical fill paths and known marks. Label changed execution/unknown marks
instead of falsely attributing return changes to fees. Retain negative outcomes.

Compute exact FIFO closed lots, fees, gross/net returns, equity, exposure, duration
positioned and two-way turnover. Mark only known valid fresh closes at reported cutoffs;
exclude run-end arrivals, retain historical revision timing, and leave stale/delisted/
renamed holdings unknown. Do not impute zero liquidation prices. Unknown equity makes
drawdown/exposure maxima unknown; report sampled rather than invented intrabar risk.

Atomically publish synced JSON/Markdown/manifest/hash bundles; fully replay semantics
and regenerate summaries when verifying. Preserve source provenance, policy versions,
raw fills/journals/skips and old schemas/artifacts. No new third-party version, SQL
migration, live trading, broad risk engine, ML or statistical alpha claim is introduced.
Publish Strategy, ExecutionSimulator and BacktestReport for 09–13 and stop before
Module 09, Iteration 1.
