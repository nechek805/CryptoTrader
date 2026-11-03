# Market robustness, trial accounting and handoff

Module 09 Iteration 3 adds predeclared stress experiments, durable attempt journals,
costed rule/ML comparisons, risk-adjusted net rankings, conditional uncertainty and
immutable selection/archive receipts. Default evidence is **SYNTHETIC** and cannot
promote a model. Zero selected candidates is an allowed scientific outcome.

## Commands

Use the README's pinned Node 24.22.2 / pnpm 10.34.9 runtime:

```powershell
pnpm robustness fixture --out data/market-robustness
pnpm robustness fixture --parent <prior_report_directory> --out data/market-robustness-next
pnpm robustness run --plan <plan.json> --out data/market-robustness-built
pnpm robustness run --plan <continued_plan.json> --parent <prior_report_directory> --out data/market-robustness-next
pnpm robustness verify --directory <market-robustness_directory>
pnpm robustness report --directory <market-robustness_directory>
pnpm robustness reproduce --directory <market-robustness_directory> --parent <prior_report_if_any> --out data/market-robustness-reproduced
```

Fixture execution first freezes two Parquet panels and four model bundles using the
existing verified TRAIN/VALIDATION pipeline. It then freezes the robustness plan and
logs all planned cells before executing the first one. Custom plans contain frozen
model weights and source-panel identities; these models can separately be refitted
and verified with `pnpm ml verify --directory <model_directory> --panel <panel_directory>`.
Robustness verification replays the frozen producers and executions; it does not
silently retrain or select weights from the scenario results.

## Predeclared design and model versions

The sparse fixture has twelve scenarios: all nine BTC/ETH/SOL × TREND/WHIPSAW/REVERSAL
base cells, BTC whipsaw with higher costs, ETH reversal with a volatility shift, and
SOL trend with both. All assets share the declared window and initial virtual cash
1,000, with a fixed target of one owned asset unit. Higher costs use 0.3% taker fees,
30 bps spread and 15 bps slippage instead of 0.1%, 10 bps and 5 bps. Volatility stress
multiplies fictional deviations from the starting price by 2.5. It is not a full
factorial design or a sampled historical market universe.

Each scenario retains the original 96-bar synthetic training history, four bridge
candles and twelve forward fixture candles. Model publication is declared at second
6,000; the evaluation window begins one nanosecond later and ends at second 6,721.
This clock is fictional. Declared dates and sequence numbers do not authenticate
actual wall-clock preregistration or historical model availability.

Eight producer versions run on every scenario, for **96 attempted cells**:

| Trial            | Change                                                                 |
| ---------------- | ---------------------------------------------------------------------- |
| MA_2_4           | Fixed 2/4 SMA crossover                                                |
| MA_3_5           | 3/5 period perturbation linked to MA_2_4                               |
| BREAKOUT_4_2     | Fixed prior-window breakout                                            |
| ZSCORE_4         | Fixed z-score reversion                                                |
| ML_H2_CONTROL    | Reproduction of the two-bar / 25-bps synthetic ML configuration        |
| ML_H3_FULL       | New three-bar / 125-bps label version, with a new panel/model identity |
| ML_H3_NO_RETURN2 | Retrained strict feature subset on the same three-bar panel            |
| ML_H3_L2_002     | L2 0.02 perturbation of ML_H3_FULL's 0.01                              |

The three-bar label band is fixed before these scenarios run. The two-bar model's
original expiry can precede the simulator's first eligible full-candle fill. It remains
visible as an unexecuted control; its signal lifetime is never extended. The three-bar
model uses a separately frozen [2,3]-horizon panel and fresh TRAIN-only fitting and
validation calibration. Feature ablation refits the smaller scaler/weights; it never
zeros a column inside an unchanged model. Parameter changes create new identities.
All imported four-value calibration grids remain in the attempt-family disclosure.

## Candidates, controls and execution

The structural `MarketSignalProvider` interface and the existing constructor value are
both exported by @crypto/strategies. The port exposes descriptor, initialState and
strategy; existing constructor calls retain their configuration/state/feature behavior.
ML uses its published causal candidate adapter with unchanged availability, metadata,
source, freshness and formula gates.

Original forecast replay candidates remain immutable. A separately identified ML
projection maps LONG to a long target, and SHORT or abstention to flat. It preserves
the original expiry, links the original candidate, and records the projection policy.
Post-receipt target sizing uses actual simulated inventory and existing pending-order,
cash, notional, lot and expiry vetoes. There is no borrowed short, leverage or order API.
Zero fills are explicit and cannot count as active evidence for selection.

Cash and buy-and-hold have the same source, initial cash, target quantity, costs and
timing as each strategy. Their independent immutable simulation evidence is computed
once per scenario and referenced by all producers. No mutable account is shared.
Per-cell evidence retains original replay, projected targets, execution commands,
fills, ledger, trades, source bars, known-at equity, costs and fingerprints.

## Ranking, uncertainty and selection

Every planned cell, including failures and unknown marks, appears in the report.
The predeclared score is:

`mean terminal net return − worst sampled drawdown − max(0, −empirical cell CVaR05)`

CVaR05 is the mean of the lowest ceil(5% × cell count) terminal cell returns. For
twelve cells this is the worst cell, not a population loss-tail estimate. Scores are
not annualized Sharpe ratios. Incomplete/unknown risk data has null score/rank. Reports
also show underperformance against cash and buy-and-hold, fees and no-fill cases.
An inactive zero-return control can outrank losing models without becoming eligible.

Uncertainty targets **mean terminal net return**, not the penalized ranking score.
The runner samples equity at the common closed-candle calendar and terminal cutoff;
normalized increments reconcile to net return. It averages aligned increments across
all asset/regime/stress scenarios and draws the same circular time-block indices
jointly. Thus repeated assets and stress variants cannot inflate the time sample.
Default block length is three and resamples 4,096. Marginal 95% percentile intervals
are conditional diagnostics, not simultaneous intervals or population guarantees.

The one-sided centered-bootstrap p approximation counts resampled totals minus the
observed total exceeding the observed total, with a plus-one correction. It is absent
for fewer than eight blocks, flat increments, unknown equity or inadequate Monte Carlo
resolution. The twelve-bar fixture has too few blocks; p-values remain null.

The family is conservatively declared prior attempts plus every current producer/cell
attempt plus every imported model-calibration trial. Missing/prior/failed hypotheses
are padded with p=1 in a Holm step-down adjustment. The original 96-cell development
experiment had family size 161: 49 declared earlier baseline/calibration attempts,
96 current cells and 16 imported calibration trials. Continuing from its receipt
keeps that 161 floor and adds the new experiment's attempts instead of resetting it.
Exact tests/reproductions are validation, not hidden new parameter searches. External
unrecorded attempts and dishonest declared counts cannot be authenticated by hashes.

The block approach is informed by the [CMU time-series bootstrap notes](https://www.stat.cmu.edu/~cshalizi/uADA/15/lectures/28.pdf).
Multiple-comparison adjustment follows [Holm's original procedure](https://www.ime.usp.br/~abe/lista/pdf4R8xPVzCnX.pdf).
Holm's formal error control requires valid marginal p-values; these small-sample
bootstrap approximations do not establish that guarantee on nonstationary markets.

At most two versions may pass the fixed rule: complete active cases, three assets and
three regimes, positive score and lower net bound, Holm p ≤ 0.05, worst drawdown ≤ 10%,
and cell tail loss no worse than 5%. Synthetic evidence always fails promotion. All
rejections retain explicit reasons and immutable producer/feature fingerprints.
Passing this research rule would still require a new versioned forward experiment.

Parameter/ablation tables show parent version, shared cases, return sign flips, changed
signal events and largest absolute net-return delta. Identical execution under a small
perturbation is retained as stability evidence, rather than hidden or called alpha.

## Durable evidence and archive

Bundles contain plan.json, report.json, report.md, journal.jsonl, bundle.json and indexed
evidence files. Separate handoff/archive JSON receipts include Module 11 target,
selection reasons, fingerprints and discarded model/config snapshots. The journal
hash chain records all PLANNED cells first, then STARTED and COMPLETE/FAILED, then
FINALIZED. Sequence numbers are deterministic logical clocks. Each append is synced.
Storage failures abort publication rather than becoming successful/failed simulations.

Interrupted `.robustness-stage-*` directories deliberately retain the plan, journal and
completed evidence. A new write refuses to bypass such a stage in the same root;
review it explicitly instead of silently deleting or resetting observed attempts.
Complete bundles publish by atomic directory rename. Reuse compares all existing
content hashes. Verification regenerates every cell and its hash chain; re-signing a
forged file's checksum cannot substitute a changed journal or report.

Development v1 bundles stored archive/handoff content in report.json. Bundle v2 also
requires separately indexed receipts. Verification preserves the v1 evidence format;
continuations verify the parent, retain its family floor and require a new experiment
version. Old Module 07–09 artifact formats remain unchanged. Source-code labels and
hash chains prove content identity, not provider authenticity or external completeness.

For bounded repeated frozen trials, the feature engine caches only immutable rows
identified by the complete dataset and parsed query. Input validation, causal prefix
visibility, query budgets and trace generation remain in force. Limits are 256 rows,
256 bars/close slots per cached row, 256 KiB per row and 8 MiB total. Large histories
and failures are not cached. Changing a source value, cutoff, formula or prefix cannot
reuse another row's evidence.

## Handoff boundary

The development fixture completed 96 cells without runtime failures. Some three-bar
ML mean net returns were positive, but their drawdown/tail penalties made scores
negative. The inactive two-bar control had zero score and no executed edge. The fixed
MA variants showed changed signals and returns; the retrained ablation changed ML
performance. Sparse synthetic data and insufficient blocks disqualify every version.
All are archived; no model is called definitively profitable or promoted.

This iteration completes Module 09 tooling and exports its Module 11 fingerprints.
It does not implement NewsSignalProvider, fusion, general risk, paper promotion or live
execution. Next is exactly Module 10 Iteration 1 — Conservative Rules and Abstention.
