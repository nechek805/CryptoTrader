# Frozen training data and simple market ML

Module 09 Iteration 2 adds bounded, deterministic multinomial logistic regression in
TypeScript. It consumes a verified frozen dataset-panel Parquet snapshot and emits
three probabilities, abstaining candidates and immutable model/research artifacts.
Fixtures are **SYNTHETIC**. There is no trading endpoint, model selection, parameter
search, forecast profitability claim or trained-on-real-market evidence.

## Commands and public interfaces

Use the README's pinned Node 24.22.2 / pnpm 10.34.9 runtime:

```powershell
pnpm ml fixture --out data/market-ml
pnpm ml train --panel <dataset-panel_directory> --config <config.json> --out data/market-ml-built
pnpm ml verify --directory <market-ml_directory> --panel <dataset-panel_directory>
pnpm ml report --directory <market-ml_directory> --panel <dataset-panel_directory>
pnpm ml reproduce --directory <market-ml_directory> --panel <dataset-panel_directory> --out data/market-ml-reproduced
pnpm ml infer --directory <market-ml_directory> --panel <dataset-panel_directory> --request <inference.json>
```

The fixture creates a frozen Parquet panel under the output's panels/ directory before
training. Other commands require the original verified panel, whose ID, artifact hash,
Parquet byte hash, rows hash, source/config hashes and clock policy are part of lineage.
Changed Parquet, sources, formulas or bundle contents fail verification. Reproduction
preserves the original software label; the current implementation must reproduce its
contents. Publication uses synced temporary files and an atomic immutable-directory rename.

Each bundle contains report.json, report.md, model.json, config.json, predictions.json
and bundle.json. Verification semantically rebuilds the panel, rereads Parquet, refits
the model and regenerates all five content files. A recomputed file checksum cannot
authorize fabricated summaries. Hashes prove content identity, not source authenticity.

`@crypto/strategies` exports `marketMlFixture`, `classifyMarketReturn`,
`trainMarketModel`, `validateMarketModel`, `inferMarketModel`, `createMarketMlStrategy`,
`writeMarketModel`, `verifyMarketModel` and `marketMlMarkdown`. Strict public Zod
contracts are in packages/contracts/src/market-ml.ts. Existing market providers and
costed cash/buy-and-hold/backtest artifacts keep their contracts and behavior.

## Labels, frozen splits and fitting clocks

Targets are the existing point-in-time panel's fixed-horizon close-to-close gross
returns. Full consecutive future-bar support, historical listing/mapping/precision and
publication/availability gates remain mandatory. For band b basis points:

- Return greater than b/10,000: UP.
- Return less than −b/10,000: DOWN.
- Both boundaries and their interior: HOLD.

These targets are separate from predictors and are never an inference field. They
are not returns at executable entry/exit prices. All selected input values come from
registered TECHNICAL/MARKET cells with known timestamps and exact formula fingerprints.
Proposed predictors, target dependencies, unsupported names and future watermarks fail.

TRAIN, VALIDATION and TEST dates are frozen in the panel. Existing panel exclusions
purge label support touching the next phase across all symbols/groups and retain the
post-boundary embargo. Training independently checks included-row identities, split
membership, label horizon/end/availability, embargo and fitting cutoffs. A label ending
or becoming available exactly at the holdout boundary is excluded. TRAIN labels must
be available by fitCutoff, strictly before validation starts; VALIDATION labels must
be available by calibrationCutoff, strictly before TEST starts. Generation must follow
the source snapshot and label freeze. TEST contributes no fitting statistics.

The historical report is explicitly **RETROSPECTIVE_OUT_OF_SAMPLE**. Research cutoffs
are operator assertions, not evidence that the model existed historically. The model's
declared availableAt equals generatedAt, and inference rejects any earlier decision.
For real subsequent inputs, publication/availability timestamps require defensible
observed evidence. Synthetic timestamps exist only on the fictional fixture clock.

## Model and numerical policy

The model estimates classes in fixed order DOWN, HOLD, UP. It uses full-batch softmax
logistic regression: linear logits, numerically stabilized softmax and mean categorical
cross-entropy plus L2/2 times squared weights. Biases are unpenalized. There is no
minibatch order, native BLAS, asynchronous gradient accumulation or third-party ML
runtime. Mulberry32 seeds small initial weights; biases start at zero. Canonical row
order is feature time, instrument key, then row ID using code-point comparisons.

TRAIN-only complete rows determine population means and standard deviations. Constant
columns use scale one. Transformed values are clipped to [−8, 8] for all phases using
that frozen scaler; missing values are never replaced by zero. TRAIN/VALIDATION rows
with missing predictors are excluded from fitting and listed in the audit. Held-out
missing rows remain visible: HOLD with an explicitly marked TRAIN-prior fallback
probability vector. All observed finite raw feature magnitudes must be at most 10^12.

Defaults: 300 epochs, learning rate 0.1, L2 0.01, seed 42, and minimum TRAIN/VALIDATION/
TEST coverage 30/12/12. Each TRAIN class needs at least two examples. Divergence or
non-finite results fail rather than publishing a fitted model. The bounded optimizer
does not promise convergence to an optimum. A finite-difference gradient test checks
the implementation. Numerical reproduction is scoped to pinned Node 24.22.2 with
IEEE-754 binary64; monetary accounting remains decimal-safe in the existing simulator.

Validation alone chooses one temperature from the predeclared [0.5, 1, 2, 4] grid by
lowest validation log loss, with ties preferring the value closest to one. All four
trials are retained. No TEST threshold, scaler, weight or temperature fitting occurs.
This is a fixed calibration procedure, not a trading parameter/model search.

The probability method follows standard [multiclass logistic regression](https://www.cs.utexas.edu/~gdurrett/courses/sp2024/lectures/lec3-4pp.pdf).
Temperature scaling is a post-fit technique described by
[Guo et al., 2017](https://proceedings.mlr.press/v70/guo17a.html). Its use here does not
establish that these synthetic probabilities are calibrated on real markets.

## Interpretation, HOLD and baselines

Probabilities sum to one and refer to the fixed-horizon gross-return classes, not trade
success or net PnL. The signed score is p(UP)−p(DOWN). The maximum-probability class must
be directional, meet confidenceThreshold (default 0.6), and have directional probability
separation strictly greater than directionalMargin (default 0.15). Otherwise action is
HOLD. Ties between UP and DOWN always abstain, including with zero configured margin.

Reports retain log loss with a 10^-15 probability floor, multiclass Brier sum, action
accuracy/confusion and action coverage for ML, uncalibrated ML, TRAIN class-prior,
ALWAYS_HOLD and fixed symmetric MA 2/4 direction baselines on identical held-out rows.
The prior is Laplace-smoothed TRAIN counts only and uses the same abstention rule.
The MA rule independently checks historical source/precision eligibility, has a fixed
30-second publication-delay budget and compares two registered SMA feature queries.
It is a classification baseline, not a newly costed trading strategy. Module 09
Iteration 1 costed deterministic baselines remain mandatory research controls.

Ten reliability bins per class are recorded separately for VALIDATION and TEST. Empty
bins contain null averages/frequencies. VALIDATION curves reuse the calibration sample
and are labelled accordingly. TEST diagnostics are held out. Correlated rows and tiny
fixtures do not provide confidence bounds, independent samples or a calibrated guarantee.

## Causal inference and candidates

`inferMarketModel` validates model identity, schema/order/formula fingerprints, instrument,
model availability, feature decision clocks, actual input watermarks and freshness.
Queries cannot include labels. Caller-supplied cells require trusted provenance;
this low-level numerical interface cannot authenticate their raw evidence by itself.

`createMarketMlStrategy` supplies the verified causal replay adapter. It has no news,
training, label or execution access. It requests the same registered technical formulas
from the delivered-prefix feature context and checks raw selected bars against historical
metadata and precision. The model and source must share their declared history origin,
interval and instrument cohort. Seeded EMA/ATR history therefore cannot be silently reset.
Low volume, invalid raw evidence, stale anchors and unavailable models yield HOLD with
explicit reasons. Late corrections do not produce duplicate decisions for consumed closes.

The replay kernel binds immutable SignalCandidate IDs, clocks and input rationale.
Calibration metadata refers to the predicted class's probability after validation
temperature scaling; the full vector and predicted class remain in snapshots. A HOLD
caused by low confidence does not mean its displayed maximum probability is p(HOLD).
Missing/model-unavailable predictions have explicitly absent calibration. SHORT is a
signal direction; it never creates borrowed inventory or an execution endpoint.

## Synthetic acceptance evidence and boundary

The fixed fixture has BTC/ETH/SOL prices starting at fictional 100/50/20 and 96 candles
per symbol. The repeated increments [2,2,1,0,0,−1,−2,−2,−1,0,0,1] and periodic volumes
are declared fixtures, not sampled observations or fitted recipes. Predictors are
one/two-bar returns and relative volume; the label horizon is two bars with a 25-bps
HOLD band, five-second label-publication lag and 120-second boundary embargo.

It yields 99 TRAIN, 63 VALIDATION and 66 TEST rows. The validation-selected temperature
0.5 **worsens TEST log loss** from about 0.70985 to 0.74643. This negative calibration
result is retained. Calibrated action accuracy is about 0.68182 with coverage 0.80303;
fixed MA action accuracy is about 0.54545. These are synthetic classification diagnostics,
not estimates of alpha, profitability or future performance.

Work is limited to 2,000 included rows, eight allowlisted technical columns, one shared
formula configuration/history origin, and eight million row×column×epoch units. Cross
features, real training, general ML libraries, ONNX export, ranking, parameter searches,
statistical selection and forward model promotion are deferred. TypeScript is sufficient
for this bounded model, so no Python training container is introduced. Stop before
Module 09 Iteration 3 — Robustness and Regime Testing.
