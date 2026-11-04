# ADR 0032: Observed quote/trade evidence and adverse protective exits

Status: Accepted. Date: 2026-11-03. Scope: Module 12 Iteration 2.

Market orders consume only eligible later quotes, with observed spread, frozen slippage,
quantity-step rounding, per-arm participation and exact fees. Limit buys require strict
trade-through, correct aggressor side and exhaustion of a predeclared assumed queue.
Quote touch alone never fills. Duplicate provider evidence cannot replenish capacity.
Keep provider trade/event, receipt and processing clocks distinct.

Stop/target triggers create inventory-backed child orders. A later eligible quote supplies
their execution price; stops can fill far below the threshold during a gap. Positions,
cost basis, realized/unrealized net PnL, exposure and drawdown reconcile to the same journal.
Unknown/stale marks remain null. News/trade/market outages are observable and pause new risk.

Public data uses fixed Binance market-only hosts, the existing clock/sequence-checked depth
transport and a separately validated public raw-trade stream. Bounded reconnect budgets
and source/license/metadata gates apply. No authenticated exchange channel exists.
Public adapters were tested with synthetic packets, not silently substituted in a live run.
Protocol reference: https://github.com/binance/binance-spot-api-docs/blob/master/web-socket-streams.md.

Acceptance: 17 broker/execution tests pass, including seven new realistic-execution cases.
Strict typecheck passes. Next: Iteration 3 service controls, health, soak and operator CLI.
