# Prompt Pack Manifest

## Purpose
This repository-ready prompt pack guides an AI coding agent through building a **research-only, TypeScript-first crypto intelligence platform**. The system contains two independent research strategies—news-driven and market-driven—plus an optional fusion model, a historical replay engine, and a **paper-only** execution simulator. It never moves real money in the initial release.

The goal is **measurement**, not a claim of guaranteed trading profit. A one-month forward experiment is an operational shakeout and early signal check, not proof of persistent alpha.

## How to Use This Pack
1. Read `01_MASTER_PROMPT.md` fully and provide it as **persistent project context** to the coding agent (system/project instruction if available). Never remove its security and point-in-time constraints.
2. Create a repository; make `02_FOUNDATION_AND_CONTRACTS.md` the first implementation assignment.
3. For each numbered module, paste the **file's complete context plus only one iteration prompt at a time** into the agent. Say: `Implement Iteration N only. Use 01_MASTER_PROMPT.md as a binding specification. Stop after its acceptance tests and a handoff summary.`
4. Review the delivered code, tests, migrations, README changes and *actual* test results. Do not accept invented outputs.
5. Run the `Review / Handoff Prompt` at the end of that module. Fix blockers before the next iteration.
6. Proceed according to the dependency graph. Branch names and package paths are suggestions; adapt only if justified and document deviations in an architecture decision record (ADR).
7. Use `15_EXPERIMENT_PROTOCOL.md` to freeze a paper-trading experiment before collecting forward results.
8. Use `16_FUTURE_OPTIONS.md` only after the initial research system has passed all gates.

## File Index and Order

| File | Block | Depends on | Primary result |
| --- | --- | --- | --- |
| `01_MASTER_PROMPT.md` | Global project instruction | None | Goals, boundaries, stack, invariants |
| `02_FOUNDATION_AND_CONTRACTS.md` | Monorepo / contracts | Master | Runnable skeleton and typed schemas |
| `03_MARKET_DATA.md` | Market collectors | 02 | Reliable time-indexed multi-asset OHLCV/trades |
| `04_NEWS_INGESTION.md` | News collection | 02 | Licensed/policy-compliant article ingestion |
| `05_NEWS_PROVENANCE.md` | Event extraction and verification | 04 | Independent-source corroboration graph |
| `06_HISTORICAL_EVENT_RESEARCH.md` | Event studies | 03, 05 | Honest event-response research datasets |
| `07_FEATURE_STORE.md` | Market/cross-asset features | 03 | Point-in-time features and regime tags |
| `08_BACKTEST_ENGINE.md` | Replay and execution model | 02, 03 | Deterministic causal backtesting engine |
| `09_MARKET_STRATEGIES.md` | Technical/ML engine | 07, 08 | Baselines, market-only models and tests |
| `10_NEWS_STRATEGIES.md` | News-only engine | 05, 06, 08 | Versioned evidence-based news signals |
| `11_FUSION_AND_RISK.md` | Decision and limits | 09, 10 | Separate baseline/news/market/fusion decisions |
| `12_PAPER_BROKER.md` | Live data, virtual execution | 08, 11 | No-real-money, event-driven paper ledger |
| `13_EVALUATION.md` | Scientific evaluation | 08, 12 | Auditable reports and confidence bounds |
| `14_DASHBOARD_AND_OPERATIONS.md` | API/UI/ops | 02–13 | Operator dashboard and observability |
| `15_EXPERIMENT_PROTOCOL.md` | 30-day forward trial | 12–14 | Frozen comparison and decision memo |
| `16_FUTURE_OPTIONS.md` | Optional extensions | Successful 15 | Deliberate, gated future roadmap |

## Parallel Work
After `02`, `03` and `04` can proceed in parallel. After `03` and `05`, `06` and `07` can proceed in parallel. `08` can proceed once 02/03 are stable, then `09` and `10` can run in parallel once their dependencies pass. Integrate only against versioned interfaces.

## Minimum Acceptance Gate for Every Iteration
- Code runs, type-checks, lint checks and tests pass locally; report command + result (or explain why blocked).
- Public interfaces include Zod runtime validation and explicit timestamps where needed.
- Deterministic fixture tests do not require proprietary API keys.
- No live order placement, withdrawals or wallet keys. Any trading connector must be read-only or explicitly simulated.
- No hidden assumptions about source truth, filled limit orders, zero fees, trading eligibility or future data.
- At least one failure-path test per iteration; update docs and ADRs for design choices.

## Standard Agent Reply Contract
After each iteration the coding agent must return:
1. What changed (paths and exported interfaces).
2. Commands executed and **actual** results.
3. Demonstration output or an example API request/response.
4. Known limitations, risks and any missing historical data.
5. Exact next iteration, with dependencies and open questions.

## Definition of Done for the First Milestone
A reproducible local run processes at least three liquid symbols; ingests news through a provider fixture and one permitted live source; de-duplicates independent claims; produces fully time-gated news and market signals; logs all candidates (including HOLD); runs 4 isolated virtual portfolios (baseline, news, market, fusion); and creates a report with fees, drawdowns, data coverage and explicitly disclosed uncertainty. Financial performance need not be positive.

## Non-Goals
- Executing trades with real funds in this pack.
- Credential sharing, KYC or sanctions circumvention, scraping behind access controls, fake market volume or manipulation.
- Selling automated investment decisions to third parties without separate regulatory review.
- Claiming one month of profitable paper results proves a durable trading edge.
