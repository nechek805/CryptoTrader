# ADR 0029: Deterministic spot risk and adverse gap allowance

Status: Accepted. Date: 2026-11-03. Scope: Module 11 Iteration 2.

Use a pure, versioned risk request/configuration/result. Reject unknown balances, stale
account/market snapshots, unavailable configuration, expired candidates, short exposure,
unknown correlation groups and missing stop/target policy. Default globally enabled kill
switch requires both an explicitly frozen clear configuration and an attributable override.
Overrides remain in the immutable result and cannot bypass hard limits.

Default risk budget is 0.25% of virtual equity; daily loss cut is 2%, gross/net ceilings
50%, symbol ceiling 10% and correlated-group ceiling 20%. Size is the minimum of loss
budget/stop distance plus adverse gap and two-sided fee allowance, available cash, gross,
net, symbol, correlated and liquidity caps, rounded down to the instrument quantity step.
Stops are not guaranteed fill prices. Existing spot exposure is long-only, so gross and
net are equal. Leverage and new short exposure remain disabled.

Acceptance: strict typecheck and 17 focused tests pass, including monotonic tighter
ceilings, unknown balances, daily loss boundary, stale/future prices, missing stops,
cooldown, kill switch, reproducibility and immutable overrides. Next: Iteration 3 adds
decision/evidence audits, regime restrictions and labeled diagnostic counterfactuals.
