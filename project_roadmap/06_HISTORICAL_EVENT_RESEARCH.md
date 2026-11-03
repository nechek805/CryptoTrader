# Module 06 — Historical Event Studies and Reaction Library

## Objective
Study **what markets did after historically observable events** without confusing correlation with causality. Produce descriptive research first, tradable hypotheses only where point-in-time availability is defensible.

## Dependencies
03, 05. Event timestamps need aligned market bars/trades, provenance and explicit confidence.

## Iteration 1 Prompt — Reproducible Event Study
Build an event-study CLI/API that aligns news event snapshots to BTC, ETH, SOL and a configurable market universe. For each event compute net/absolute and benchmark-adjusted returns at +1m, +5m, +15m, +1h, +4h, +24h, +72h and +7d where data supports it; also pre-event -1h/-24h to detect anticipation, max adverse/favorable excursion, realized volatility, drawdown and optional recovery-to-pre-event-price time. Distinguish trading clock/timezone and market price source; treat absent data as missing, never zero.

### Acceptance
Synthetic event with known price path yields exact returns and excursions; no event join to bars whose `availableAt` was later than a simulated decision; partial-period results flagged not silently extrapolated.

## Iteration 2 Prompt — Cross-Asset and Event Controls
Add multiple asset responses, BTC beta/market factor adjustment, relative return to basket, lagged cross-correlation and optional control windows matching volatility/time of day. Test news events against random control timestamps to estimate how frequently similar moves happen without an event. Measure time-to-recovery with right-censoring (not all markets recover in the observation window). Support event taxonomy drill-down and event concentration analysis.

### Acceptance
Control-event baseline uses same available observation windows; lag tests enforce direction and data availability; correlation is never presented as causality; right-censored observations reported explicitly.

## Iteration 3 Prompt — Hypothesis Registry and Time Validity
Implement versioned hypothesis cards: thesis, event group, expected direction and horizon, assumptions, eligibility rules, sample period, first-seen-time quality, selection biases, tests, contradictory examples, statistical uncertainty and final status. Quarantine `DESCRIPTIVE_ONLY` historical event records from tradable backtests. Build sample reports for exchange incidents, rate announcements and listings using **synthetic** fixtures (real imports optional and clearly labeled).

### Acceptance
No hypothesis is allowed to reuse the same period for both selection and final validation without disclosure; reports show sample counts and confidence intervals; causal language requires justification absent in most studies.

## Handoff / Review Prompt
Deliver a notebook-style reproducible CLI report and machine-readable hypothesis registry, including at least one negative finding. Provide handoff dataset for News Strategy; do not convert an event label directly into automatic SHORT rules.
