# ADR 0035: Dependent uncertainty and frozen-candidate sensitivity

Status: Accepted. Date: 2026-11-03. Scope: Module 13 Iteration 2.

Use contiguous circular day-block resampling of paired daily arm differences. Retain
simultaneous dependence between arms by differencing before sampling; blocks must cover
the declared overlap horizon and observed holding durations. Require enough blocks/trades,
complete common coverage, nonzero variation and Monte Carlo tail resolution. Familywise
intervals cover the declared experiment/trial family only, not hidden searches. Purged
rolling audit splits retain an embargo covering the dependence block; no TEST refitting.

Flag a run dominated by one tail event, even if profitable. Missing categories/volatility
strata stay UNKNOWN. Reprice frozen source/candidates under predeclared fee, slippage and
latency stresses, recomputing only risk and execution with current scenario account state.
Candidate fingerprints must remain identical; higher costs can veto/change fills, so
alternative paths are retained rather than assuming net PnL is monotone across paths.

Acceptance: 11 metrics/statistics tests pass, including six uncertainty/sensitivity/backtest
tests. Strict typecheck passes. Continue to Iteration 3 four-arm attribution and frozen memo.
