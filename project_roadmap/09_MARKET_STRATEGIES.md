# Module 09 — Market-Only Strategy Research

## Objective
Develop strategies that never consult news. Evaluate statistical market patterns with separate out-of-sample tests and transparent code.

## Dependencies
07, 08. All strategies output immutable `SignalCandidate`s; never directly submit real orders.

## Iteration 1 Prompt — Interpretable Baselines
Implement `CASH/HOLD`, buy-and-hold comparator, moving-average crossover, breakout and z-score mean reversion strategies with configurable parameters and explicit eligibility/exit policies. Include an always-neutral baseline, a long-only and a symmetric long/short fixture strategy. Use risk-invariant entry sizing interface, not hidden leverage. Backtest BTC/ETH/SOL synthetic regimes with costs and point-in-time feature access.

### Acceptance
Known synthetic trends produce expected signals; no repeated duplicate entry each bar; sideways whipsaw loses after costs as expected; equivalent backtest manifests reproduce outputs bit-for-bit.

## Iteration 2 Prompt — Training Data and Simple ML
Implement time-series supervised labels at fixed horizons with abstention band. Start with logistic regression or gradient-boosting only if supported reliably; keep deterministic rule strategies as mandatory baselines. If TypeScript ML tooling is insufficient, propose an isolated Python `scikit-learn`/LightGBM training container exporting ONNX + JSON feature schema, trained on frozen Parquet snapshots; Node/TS remains inference/orchestration authority. Freeze temporal splits, purge overlaps, record calibration curves and model lineage. Never fit scalers on test data.

### Acceptance
Re-running fixed seed and snapshot yields same prediction data; out-of-sample split leakage test passes; model outputs probabilities or scores with calibrated interpretation and a HOLD option; a naive baseline is reported alongside ML.

## Iteration 3 Prompt — Robustness and Regime Testing
Backtest across multiple symbols, distinct market regimes, costs, volatility shifts, feature ablations and parameter perturbations. Detect data snooping by logging all attempted trials and using multiple-comparison-aware selection. Model changes must create a new version/forward experiment, not rewrite old signal logs. Include a ranking by **risk-adjusted net performance** and uncertainty, without calling any model definitively profitable.

### Acceptance
Parameter instability and underperformance are visible; report drawdown and loss tails; no cherry-picked best chart without test-count disclosure. Export `MarketSignalProvider` interface.

## Handoff / Review Prompt
Select at most 1–2 candidate models for the forward test based on a predeclared selection rule; archive discarded models. Handoff immutable model and feature fingerprints to Module 11.
