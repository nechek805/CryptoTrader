# ADR 0019: Deterministic availability replay with delivered-prefix query capabilities

Status: accepted, 2026-11-01. Scope: Module 08, Iteration 1.

Reuse the monotonic core clock and versioned seeded random generator. Order eligible
immutable MarketBar/NewsDocument revisions by availability, kind and original record ID.
Normalize source array order; retain descriptive/out-of-period/cohort exclusions. Log
warm-up observations before the declared decision window without calling strategies.

Provide a fresh, immutable, callback-scoped query capability over only admitted records.
Timestamp equality does not expose an undelivered tie: retain logical sequence alongside
time. Exact-ID and historical/latest queries reject future cutoffs and unknown/undelivered
records. Technical features reuse Module 07 over visible history only. Access/validation/
budget violations remain fatal even if a callback catches their exceptions. Expire the
capability after the callback; never expose the full schedule to strategy code.

Use a versioned Strategy descriptor, fresh factory, explicit JSON state and validated
intent output. Kernel-bind candidate identities, clocks, reproducibility and evidence;
record HOLD explicitly for the no-trade market-event control. Unknown affected symbols
on news events do not create fabricated candidates. No execution or zero-cost performance
model exists. Strategies are trusted in-process code, not a security boundary; they must
use provided clock/randomness and avoid hidden external state.

Record hash-chained event/query/candidate logs, bounded state checkpoints and a complete
run manifest. Snapshots are audit checkpoints without resume support. Semantically rerun
before immutable publication and when verifying; inconsistent strategies and changed
state/candidates/snapshots/logs fail. Keep source evidence and old domain/research schemas
unchanged. New replay schemas are versioned separately; no SQL migration or third-party
version change is required. Workspace wiring activates the reserved backtest package.

Stop before fills, costs, portfolio accounting and execution simulation. Implement those
in Module 08, Iteration 2 using this scheduler/query boundary.
