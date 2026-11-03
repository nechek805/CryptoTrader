# ADR 0013: Exact-close descriptive event studies

Status: accepted, 2026-11-01. Scope: Module 06, Iteration 1.

The historical event engine consumes a semantically verified immutable news snapshot
and existing strict MarketBar OHLC records. An explicit request selects event decisions,
asset/source identities and a benchmark. It replays news features at each selected
decision, including unverified stories when temporally eligible. No subsequent event
status, curator mapping or correction is promoted into an earlier context.

Use continuous UTC and exact closes. Entry is known at the event decision; every path
bar is known at its own close-time decision. Require a complete consecutive path for
all metrics. Preserve partial/missing/future/unsupported status, excluded evidence IDs
and source provenance. An archive captured later cannot stand in for contemporaneous
knowledge. This conservative implementation intentionally sacrifices coverage when
availability or alignment is uncertain. There is no implicit staleness allowance.

Use private decimal arithmetic, including log/sqrt, with explicit half-even rounding at
36 fractional digits. Signed gross, absolute magnitude, assumed-cost net and simple
benchmark subtraction are separate fields. OHLC excursions and close-only drawdown
avoid assuming intrabar ordering. All results describe association; prices do not imply
fills or strategy profit.

Publish self-contained content-addressed JSON via a synced staging file and atomic
no-replace link. Verify both evidence semantics and recomputed outputs. Retain the full
working-tree code hash, input/config hashes, clock and algorithm version. A separate
loopback query API binds this frozen input at startup; the existing health contract and
database schemas are unchanged.

Explicit asset/event selection can carry research selection bias and must be disclosed.
No dynamic survivor universe, beta model, random control baseline, statistical confidence,
recovery estimator or hypothesis registry is added until its numbered iteration. Optional
recovery is deferred so it can arrive with proper right-censoring in Iteration 2.
