# Module 08 — Causal Replay and Realistic Backtesting

## Objective
Build a deterministic event-driven backtester before optimizing strategies. Its execution realism is more important than speed or attractive returns.

## Dependencies
02, 03. Strategy interface should be compatible with news and market candidate producers developed later.

## Iteration 1 Prompt — Deterministic Replay Kernel
Build `Clock`, event scheduler, read-only feature/query context and `Strategy.onEvent` API. Advance by ordered `availableAt` with stable tie-breaking. Strategy queries may never see future bars/news. Add repeatable seed, event order logs, run manifest, snapshots and a simple no-trade control strategy. Record candidates including HOLD and their exact `dataCutoff`. Do not create real exchange API order calls.

### Acceptance
Replaying the same input hash twice yields identical candidates and state; attempts to query future data fail loudly; clock ordering test covers simultaneous events, delays and late-arriving corrections.

## Iteration 2 Prompt — Fill, Costs and Portfolio Ledger
Implement virtual market/limit orders and an append-only double-entry-like accounting ledger. Handle balances, reserved cash/assets, fees, spreads, slippage, partial fill policy, order cancellation, latency, tick/lot sizes, and unavailable fills. For OHLCV-only data use conservative fill rules and report ambiguity when stop and take-profit both lie within one candle; default to adverse/worst-case path or exclude ambiguous instances. Support cash and spot first, derivatives simulated later behind explicit flag with funding, margin and liquidation rules.

### Acceptance
No negative unreserved cash, no double fills, cost of round-trip matches an independent hand calculation, worst-case same-bar tests, fill trace and ledger reconcile at each timestep.

## Iteration 3 Prompt — Research Controls and Sensitivity
Add execution assumptions as versioned manifests; stress-test fee/slippage/latency and missing candle scenarios. Compare results against buy-and-hold and cash; expose trade records, equity curve, exposure, turnover, gross and net return. Add `backtest run --manifest ...` producing JSON + Markdown report, and a reproduction command. Reject any strategy with unavailable data fields instead of inventing values.

### Acceptance
Increasing nonnegative fees cannot improve identical executed-trade gross PnL; future-leak fixture fails before report; skipped fills and unknown market depth are disclosed. Include at least one deliberately unprofitable test strategy.

## Handoff / Review Prompt
Audit execution assumptions and time leaks, not just profitability. Publish `Strategy`, `ExecutionSimulator` and `BacktestReport` contracts for Modules 09–13. Keep real trading strictly unavailable.
