# Module 11 — Signal Fusion and Deterministic Risk Gate

## Objective
Evaluate combined intelligence without contaminating independent arms, and ensure every proposed trade is rejected unless it satisfies explicit deterministic limits.

## Dependencies
09, 10 and shared contracts. Paper broker not yet required; use a simulated RiskDecision target.

## Iteration 1 Prompt — Independent Strategy Isolation
Define four portfolios: baseline, news-only, market-only, fusion. At each decision window, collect immutable candidates. No copying positions or outcomes between arms. Implement straightforward pre-registered fusion policies: agreement-only, weighted calibrated score, and disagreement→HOLD. Each fusion policy must be versioned and selected on historical training data only. Each arm has identical snapshot and execution assumptions.

### Acceptance
With contradictory news/market signals, default fusion abstains; identical market and news candidates do not result in duplicate orders; components cannot read another arm's PnL during decision generation.

## Iteration 2 Prompt — Risk Engine
Create deterministic rules for capital at risk per hypothetical position (default example 0.25–0.5% of virtual equity), daily drawdown cut, gross/net exposure, symbol concentration, correlated assets, order validity, cooldown, spread/liquidity thresholds, gap risk, leverage disabled by default, and globally enabled `killSwitch`. Derive size from stop distance and available virtual capital; reject any position without a valid stop/position policy. Include override audit entries, never silent exceptions.

### Acceptance
Risk checks are monotonic with tighter limits, unknown balance rejects, stale feeds reject, no order after daily loss cap, and an adverse-price gap is not modeled as guaranteed stop execution.

## Iteration 3 Prompt — Sizing, Calibration and Conflict Analysis
Add uncertainty-aware sizing and regime restrictions without increasing risk based on uncalibrated model probabilities. Track veto reasons, opportunities lost, signal conflicts, portfolio correlation and contribution by arm. Implement an audit-ready `DecisionRecord` with source/evidence references, feature cutoff, confidence calibration and risk configuration hash. Run counterfactual no-risk and with-risk comparisons, clearly labeled.

### Acceptance
Every final candidate has deterministic explainable allow/deny reason; fusion improvement cannot be inferred without out-of-sample data; audit chain links to evidence and run manifest.

## Handoff / Review Prompt
Publish fixed defaults, per-arm risk rules and configuration freeze format. Test kill switch, duplicate signal and flash-crash fixtures. Hand off immutable decisions to Module 12.
