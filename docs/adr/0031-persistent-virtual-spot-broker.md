# ADR 0031: Persistent virtual spot broker and four ledgers

Status: Accepted. Date: 2026-11-03. Scope: Module 12 Iteration 1.

Reuse canonical simulated order/fill contracts and the Module 08 balanced SpotLedger.
Four counterfactual portfolios receive independent capital and independent copies of
observed liquidity; orders inside one arm share capacity. A computed immutable Module 11
DecisionRecord must match the manifest, frozen risk policy, current own-arm cash/equity,
instrument, quote evidence and fee ceiling. No private exchange SDK or credential exists.

Persist one synced event/state-hash file at a time, publishing by an exclusive hard link.
Uncommitted staging is ignored; malformed committed events fail closed. A single writer
lock prevents concurrent mutation. Record owner PID; explicit stale-lock recovery refuses
to steal a lock from a live process. Replay rebuilds orders, reservations, fills, cost basis
and ledger. Snapshots must match an exact committed prefix and never replace the event log.

Signal/portfolio/strategy/version identity makes insertion idempotent. Provider event
identity prevents duplicate quote liquidity. Delayed pre-order observations cannot fill.
Partial fills retain reservations; terminal orders release them. Execution remains virtual.

Acceptance: strict typecheck and ten focused tests pass, including partial-fill restart,
exact replay, expired limit, late data, independent balances, corrupt committed events,
tampering, source eligibility and private/live input rejection. Next: Iteration 2 adds
trade-through/queue evidence, public read-only transport and protective exits.
