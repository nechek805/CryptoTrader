# ADR 0022: Market-only baseline targets and post-receipt sizing

Date: 2026-11-01

Status: Accepted

## Context

Module 09 Iteration 1 requires transparent market-only strategies, neutral and
buy-and-hold comparators, synthetic long/short signals and costed PIT backtests.
The existing Module 08 executor deliberately supports only owned cash/spot inventory.
Signal intent is distinct from fills: treating an entry as a filled position would
stack orders, oversell partial positions or hide cash rejection.

## Decision

Activate @crypto/strategies with strict versioned configurations for cash, buy-and-hold,
SMA/EMA crossover, breakout, z-score reversion and a synthetic symmetric MA diagnostic.
Providers cannot consult news or execution accounts. They emit immutable candidate
target codes with explicitly absent calibration and retain per-decision source/formula
audits. Warm-up, missingness, cooldown, max-hold and full historical metadata/grid
eligibility are explicit. Invalid windows cannot consume a crossover.

Use a separate fixed-quantity target sizing interface. A bounded execution-prefix
reconciliation at decision plus one nanosecond reads actual owned inventory, including
reservations. Pending orders block replacements; opposing targets cancel once. Each
target transition has one submit attempt; rejection/expiry is retained rather than
retried on every HOLD. Derive new execution-candidate identities linked to immutable
provider signals and prefix hashes. Existing spot cash, inventory, price and notional
checks retain final authority. Conservative full-window eligibility applies equally
to strategy and comparators.

Symmetric short targets are synthetic diagnostic signals only. Their artifact says
execution DISABLED; the costed spot runner rejects them. Adding borrowed shorts would
change Module 08 accounting and require a separate funding/borrow/margin specification.
No short financial performance is claimed.

Publish new market manifest/report/bundle contracts and semantic artifact rebuilding.
Do not alter old controls' defaults, hashes, artifact schemas or Markdown renderer.
Record the complete manifest in symmetric signal artifacts as well. Use predeclared
BTC/ETH/SOL synthetic trend, whipsaw and reversal recipes; report all 45 costed cases
and three signal diagnostics without rankings or best-model selection.

## Consequences

The adapter is intentionally bounded and computationally more expensive than an
incremental broker: each decision rebuilds a prefix using the trusted spot executor.
At most 128 bars prevents unbounded replay work. A receipt-close order cannot exploit
the price window that just closed or an open preceding its post-receipt placement.
Missed or partial entries and failed exits remain visible in exposure and ledgers.
Current spot-only financial evidence does not establish symmetric short profitability.
ML and statistical robustness/selection belong to later iterations.
