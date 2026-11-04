# ADR 0033: Persistent controls, source health and synthetic soak

Status: Accepted. Date: 2026-11-03. Scope: Module 12 Iteration 3.

Run a durable single writer over synthetic or explicitly public read-only input. Queue
immutable operator/producer requests and preserve request/processing times. Pause, stop
and kill are logged. Killed manifests cannot resume. Source exhaustion pauses; work budgets
halt safely and require a separately identified continuation. Public startup refuses a
changed code hash. Absent candidates remain HOLD.

Monitor news heartbeat TTLs, trade/market interruptions, skew, validation, license and
instrument identity. Quarantine malformed input without logging bodies or accepting it as
a command. Daily reconciliation and transaction exports are auditable. Snapshots match
committed prefixes; the event journal is authoritative and restore replays it.

Acceptance: typecheck/lint, 23 focused tests, doctor and an actual persisted 24-hour virtual
soak pass. Inject outages, skew, bad data, flash crash and license change; retain losses and
missing marks. Status/replay/snapshot agree. This is not an elapsed real-provider day.
See docs/paper-broker.md for identities and limits. Module 13 may consume outcomes for
evaluation; outcomes remain unavailable to candidate producers.
