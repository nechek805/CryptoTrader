# ADR 0030: Decision audits and diagnostic counterfactuals

Status: Accepted. Date: 2026-11-03. Scope: Module 11 Iteration 3.

Wrap each immutable risk result in a versioned DecisionRecord with exact source prefix,
source/evidence references, feature cutoff, regime, calibration artifact binding, complete
configuration hash and run-manifest link. Rebuild semantics when verifying the record.
Uncalibrated candidates receive a frozen discount; confidence never increases the hard
risk budget. Unknown or disallowed regimes veto. All explanations remain deterministic.

Compare no-risk/with-risk one-unit net markouts only as diagnostic counterfactuals, with
missing outcomes retained and strictly complete future outcome horizons. They are not
fills or account PnL and cannot feed producers. Track hindsight positive opportunities
vetoed, veto counts, signal conflicts, per-arm contribution and paired-day correlation.
Zero variance or fewer than three paired days leaves correlation unknown. Fusion
improvement remains unestablished without defensible out-of-sample evaluation.

Acceptance: strict typecheck, lint and 24 focused tests across risk/audit pass, including
seven decision-audit tests. Immutable records now hand off to Module 12. The user has
explicitly authorized continuation across all remaining iteration boundaries.
