# ADR 0023: Frozen logistic models and temporal calibration

Date: 2026-11-01

Status: Accepted

## Context

Module 09 Iteration 2 needs fixed-horizon supervised labels, simple reproducible ML,
frozen purged temporal splits, calibration lineage, HOLD and naive/rule comparisons.
Module 07 already provides verified point-in-time feature panels, future-label support,
global purge/embargo, immutable Parquet and semantic source reconstruction.

## Decision

Reuse verified dataset panels as the sole training entry point. Translate fixed-horizon
gross returns into DOWN/HOLD/UP using a symmetric inclusive abstention band. Recheck
label availability, boundary touches, embargo, fitting cutoffs and registered predictors.
Train an explicit bounded full-batch multinomial logistic model in TypeScript. Fixed
row order, Mulberry32 initialization and pinned Node binary64 arithmetic make this
small optimizer reproducible without adding an ML dependency or Python/container logic.
Test gradients against finite differences and retain objective/coverage failures.

Fit population scalers on complete TRAIN rows only, freeze them and clip standardized
inputs to eight. Do not impute missing values. Validation alone selects temperature
from four predeclared values; retain every trial. TEST never fits preprocessing,
coefficients, thresholds or calibration. Record per-class reliability bins and all
negative held-out diagnostics alongside TRAIN-prior, neutral and fixed MA rule baselines.
Do not confuse classification metrics with costed financial performance.

Publish immutable model/config/prediction/report bundles bound to full source-panel,
Parquet, row, feature and software identity. Verification refits against the original
verified Parquet and regenerates content. Reproduction retains stored software labels;
labels and hashes are provenance, not signatures or authentication.

Historical out-of-sample reports are retrospective assessments. Fitting cutoffs are
asserted research clocks; they do not establish model availability. Set declared model
availability to generation, reject earlier numerical inference, and gate candidate
replay against that clock as well as feature/source freshness. The candidate adapter
never reads training labels, news or broker/account state, and binds source metadata
and the declared history origin. Every non-qualifying decision abstains explicitly.

## Consequences

This is a small transparent numerical implementation with a fixed optimizer budget,
not a general ML framework or guaranteed converged estimator. Reproduction is scoped
to the pinned Node runtime. Small correlated synthetic samples cannot demonstrate
calibration or alpha. In the fixed fixture, temperature fitting improves validation
loss but worsens TEST loss; preserve this result instead of selecting on TEST.

No SQL migration or third-party version changes are needed. Existing deterministic
costed strategies and artifact formats remain unchanged. Parameter searches, rankings,
statistical robustness and model promotion remain Module 09 Iteration 3/later work.
