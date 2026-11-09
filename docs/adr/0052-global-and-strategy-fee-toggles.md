# ADR 0052 — Global and per-strategy trading fee toggles

Date: 2026-11-04. Status: accepted; supersedes the default-zero policy in ADR 0051.

The user corrected the fee request: retain fees with a global on/off toggle and an
individual toggle for each strategy. Restore fees enabled by default.

Use a workspace preference `{V1: boolean, V2: boolean, V3: boolean}`. The global UI
toggle sets all three together; individual toggles allow a mixed selection. Native
checkbox indeterminate state communicates a mixed global selection. Each strategy
setting applies to every coin, entry, exit, position and its matching buy-and-hold
comparator. On means 0.10% per side; off means zero. Slippage always stays 0.05% per
side plus tick rounding. Existing frozen experiments keep their original assumptions.

Persist preferences atomically in `data/market-strategy-tests/fees.json`; absent
preferences default to all enabled. Validate strict booleans through the authenticated
local READ research API. Reject fee changes during replay and freeze a preference
snapshot for each bounded job.

Precompute STANDARD and ZERO reports for all three strategies and ten coins: 60
deterministic cost-scenario runs, not six signal strategies. Both scenarios replay
eligibility, risk sizing, accounting and passive comparators. Switching fees selects
immutable reports and rebuilds the matrix. It never adds fees back to old returns or
alters recorded fills. There is no threshold fitting or automatic winner selection.

Matrices retain optional preferences and both scenario row sets. Mixed selections have
feeMode MIXED. Each primary cell selects its strategy's scenario. Label buy-and-hold
by strategy so mixed selections cannot display one mismatched comparator. Report
plans retain STANDARD/ZERO. New source and matrix hashes identify the new artifacts;
all earlier paid-fee and zero-fee matrices remain unchanged.

Persist the immutable matrix before advancing its pointer and acknowledging saved
preferences. Startup reconciles completed scenarios with preferences after a crash.
Failed scenarios remain explicit failures. An asynchronous report request captures
its selected matrix so concurrent switches cannot silently change that report.

Validate all eight combinations, default-on, unchanged other-strategy cells, cash,
failure recovery, snapshot mismatches, auth/Origin, malformed flags, persistence and
rejection during jobs. Replay both actual fee scenarios and exercise the local API.
