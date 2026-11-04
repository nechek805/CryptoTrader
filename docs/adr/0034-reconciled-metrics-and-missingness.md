# ADR 0034: Reconciled metrics, calendar time and missingness

Status: Accepted. Date: 2026-11-03. Scope: Module 13 Iteration 1.

Measure verified paper journals and Module 08 backtests through a validated performance
contract. Preserve paper average-cost tranche attribution and backtest FIFO lots. Gross
Pnl means before paid fees but after execution price impact; report fees/slippage separately.
Use exact decimals for money and actual timestamp durations for exposure/time in market.

Undefined ratios are null and render N/A, never infinity. Missing or expired held-asset marks
make full drawdown/exposure unknown; retain observed drawdown as a disclosed lower bound.
Daily aggregation keeps partial-day and missing-coverage flags. Do not silently interpolate
past quote validity. Cash/holdings reconcile through the authoritative broker journal.

Acceptance: five hand-calculation/paper tests pass, including zero trades, zero losses,
negative equity rejection, nonuniform timestamps and stale marks. Combined with the seven
execution regressions, 12 focused tests pass and strict typecheck passes. Continuing to
Iteration 2 uncertainty, sensitivity and bias diagnostics.
