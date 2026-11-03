# Module 14 — Research Dashboard, APIs and Observability

## Objective
Provide a practical operator dashboard and read-only research APIs for inspecting signals, evidence, executions and evaluation without pretending that a paper account is a real exchange balance.

## Dependencies
02–13. Keep UI separate from strategy logic and backtest state.

## Iteration 1 Prompt — Read-Only API and Simple UI
Implement Fastify read endpoints for source status, events/evidence, asset market status, features, signals/HOLD outcomes, four portfolios, equity curve and experiment manifests. Add Next.js/React pages for project overview, active runs, news provenance detail and paper trades. Create a clean operator design with clear badges reading **SIMULATED** where relevant. Use pagination, filtering and response schema validation. No real order placement buttons.

### Acceptance
A user can trace one signal to its source, features, risk decision, virtual fill and return; disconnected sources are visible; UI does not conflate a demo balance with real money.

## Iteration 2 Prompt — Drill-Down and Analytics
Add comparisons of four arms, event timelines, confidence and contradiction graphs, historical event studies, strategy parameters, drawdown, costs, asset correlations and execution trace. Show event truth/corroboration separately from directional profit prediction. Add report export (JSON, CSV, Markdown) with reproducible manifest link. Use minimal client state; no unbounded raw article or personally identifiable data exposure.

### Acceptance
Every chart can be reconstructed from back-end data; original and corrected article/event snapshots are inspectable; missing data is not interpolated without annotation.

## Iteration 3 Prompt — Operational Controls and Security
Add admin authentication for local and deployment mode, role-based read vs paper-run control, rate limits, safe error handling, redacted logs, run pause/stop, alert channels, backups, and observability dashboards. Protect API connectors against SSRF, malicious RSS and prompt injection, enforce outbound allowlists and least-privilege secrets. Run dependency/vulnerability scan and basic load test on news/market burst.

### Acceptance
Unauthorized users cannot access run controls; admin cannot bypass immutable logs; logs expose no API keys or copyrighted full text; injected malformed feed cannot break the worker.

## Handoff / Review Prompt
Record screenshots, API examples and operational playbook. Include known dashboard limits and a rollback plan. Handoff ready-to-freeze experiment controls to Module 15.
