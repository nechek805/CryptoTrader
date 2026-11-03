# Module 07 — Market Features and Multi-Asset Regime Detection

## Objective
Create causal, reusable market features for technical baselines and ML models. Make all training and inference views point-in-time correct and cross-asset aware.

## Dependencies
03, 02. Use snapshots and avoid calling future candles or revising old inferences silently.

## Iteration 1 Prompt — Deterministic Technical Features
Implement EMA/SMA, returns at configurable horizons, rolling volatility, ATR, relative volume, rolling z-score, breakout bands, candle gap detector and liquidity quality flags. Ensure rolling indicators only use bars **closed and available** by feature timestamp. Build a feature registry describing formula, version, inputs, availability lag, warm-up period and NaN policy. Validate implementations against hand-calculated fixtures and reference library where permitted.

### Acceptance
Warm-up produces missing values, not fabricated zeros; no use of the current unfinished candle as a closed candle; timing and feature provenance audited on a fixture with delayed bars.

## Iteration 2 Prompt — Cross-Asset Features and Regimes
Add BTC-relative returns, rolling pairwise correlations, lead/lag features, market breadth, concentration proxies and regime flags (trending/ranging/high-volatility). Define point-in-time liquid-universe selection, fallback when instruments missing and timestamp tolerance for joins. Derivatives funding/open interest appear only as optional feature inputs with their own publication/availability times, not assumed to exist everywhere.

### Acceptance
Misaligned datasets cannot silently use later-known BTC features for ETH; missing historical listing handled correctly; regime classifier is deterministic and tested on synthetic trends/sideways jumps.

## Iteration 3 Prompt — Dataset Builder and Data Leakage Audit
Implement reproducible train/validation/test panel construction with symbol/group metadata, time-based splits, purge/embargo for overlapping labels and configured forecast horizons. Add missingness, duplicate, label leakage and survivorship reports; include dataset hashes and feature config. Provide stable Parquet exports and TypeScript client. If ML needs Python later, export typed Arrow/Parquet and define a strict artifact contract rather than rewriting this module in Python.

### Acceptance
A purposely leaking feature is detected in tests; overlapping-label train/test contamination is excluded; all feature rows list `maxInputAvailableAt <= featureAsOf`.

## Handoff / Review Prompt
Publish feature catalog, source coverage and training sample manifest. Identify which candidate features are unavailable for real-time usage. Handoff to 09 and 11.
