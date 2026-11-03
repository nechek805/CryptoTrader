# Module 15 — Pre-Registered 30-Day Paper Trading Experiment

## Objective
Run a scientifically honest forward paper study with four isolated portfolios and **no real-money execution**. This module is both an operational runbook and an agent assignment. The one-month period is a preliminary test; it cannot establish long-run profitability.

## Dependencies
02–14 pass all gates; collect source coverage and legal/technical provider eligibility before starting.

## Experimental Arms
- A `BASELINE`: simple fixed policy; include cash-only comparator and external passive benchmark in reporting.
- B `NEWS_ONLY`: decision inputs are only temporally available, provenance-checked news events (price allowed for fills and risk measurement, not hidden market alpha).
- C `MARKET_ONLY`: only market and cross-asset features; no news features.
- D `FUSION`: a versioned combination of B and C, able to HOLD.

All arms start with equal **virtual capital**, identical eligible universe, quote currency, cost assumptions and formal risk ceilings. Expose with/without news comparison and a passive benchmark on the same timeline.

## Iteration 1 Prompt — Protocol Freeze
Create `experiment.yaml` and a signed/hashable `ExperimentManifest`. Freeze start/end in UTC, starting balance (e.g., $10,000 virtual per arm), instruments, eligible liquidity, strategy/model artifact hashes, fee and spread/slippage assumptions, risk settings, market/news providers, data-latency policy, news confirmation policy, delayed news treatment, paper fill model, KPI thresholds and failure criteria. Define that any code/parameter change creates a **new experiment ID**, not a secret update to the current one. Validate all providers and models before freeze. Create an operator checklist.

### Acceptance
Experiment refuses to start if manifest is mutable/unhashed, a data source lacks a valid adapter/license check, time gating is violated or a model has not been versioned. Include dry-run manifest validation command.

## Iteration 2 Prompt — Launch, Monitor and Incident Record
Implement scheduling, source heartbeat, downtime accounting, daily virtual ledger reconciliation and alerts. Log all candidate signals including HOLD, risk vetoes, virtual fills, news source dependencies, latency, manual pauses and corrections. Human may stop the experiment for safety/data integrity; do not silently erase a bad day. Produce daily summary and a weekly QA report; retain a raw event log for replay.

### Acceptance
Simulate multi-hour news outage, market data outage, duplicate source, delayed correction, highly volatile market and system restart; all result in understandable flags and no phantom profits. If a run is restarted, report a continuous vs interrupted analysis separately.

## Iteration 3 Prompt — End-of-Month Assessment
Generate a frozen after-action report comparing the four arms and buy-and-hold/cash. Include confidence bounds, percentage of signals missed due to corroboration delay, stop/target outcomes, transaction-cost sensitivity, net PnL, drawdown, calendar and asset decomposition, source failures, overfitting checks and a list of hypothesis changes for **a new future test**. Produce one of three predeclared recommendations: `CONTINUE_FORWARD_TEST`, `REVISE_AND_RESET` or `STOP`. Do not recommend real-money trading based on one month alone.

### Acceptance
Every claim linked to immutable report and hashes; winning arm cannot be called robust if trades are few, result is one outlier, or sensitivity wipes out profit; source/news uncertainty stays visible.

## Example Predeclared Research Gates (Adjust Before Freezing)
- Operational completeness: at least 95% eligible market data observations and documented news polling coverage, otherwise declare inconclusive.
- Integrity: zero known look-ahead or duplicate-ledger bugs; any such bug invalidates affected results.
- Robustness: net performance under increased simulated costs and reasonable latency not dominated by one trade.
- Evidence: comparison with baseline reported with uncertainty and enough independent observations for meaningful inference; otherwise classify inconclusive.
- Risk: no breach of simulated hard loss/exposure rules; if breached, stop and investigate.

## Handoff / Review Prompt
Write `experiment-YYYY-MM-DD-findings.md`, include raw links/hashes and a ranked backlog of new hypotheses. Explicitly state that post-hoc edits cannot retroactively improve the frozen trial. Only then consider Module 16.
