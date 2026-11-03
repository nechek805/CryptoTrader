# @crypto/backtest

Module 08, Iteration 1 provides deterministic availability replay, callback-scoped
read-only queries, the Strategy API, no-trade control, candidate logs and audit snapshots.
See `docs/replay-kernel.md` at the repository root and run `pnpm replay fixture`.

Iteration 2 adds an explicit cash/spot fill simulator, reserved balances, costs,
protective exits and a balanced append-only journal. See `docs/spot-execution.md`
and run `pnpm replay spot-fixture`. This is simulated execution; live execution stays
disabled. Iteration 3 adds versioned backtest manifests, performance/coverage reports,
cash/buy-and-hold controls and bounded execution sensitivity scenarios. See
`docs/backtest-controls.md` and run `pnpm backtest fixture`. Module 09 strategy research
is the next boundary; no statistical alpha or live-trading claim is made.
