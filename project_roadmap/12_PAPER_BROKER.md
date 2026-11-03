# Module 12 — Forward Paper Trading, Not Live Trading

## Objective
Run a persistent always-on virtual trading service fed by live **public read-only** data; simulate orders and mark-to-market. Keep a clean boundary between research and actual exchange accounts.

## Dependencies
03, 08, 11. Reuse backtest fill/ledger interfaces but explicitly model live market data latency and unknown order-book queues.

## Iteration 1 Prompt — Simulated Broker and Four Ledgers
Implement four isolated paper portfolios with initial configurable cash, virtual balances, virtual orders and positions. Market-only public feed adapter. No private exchange credentials. Paper order lifecycle `PROPOSED`, `RISK_REJECTED`, `ACCEPTED`, `OPEN`, `PARTIAL`, `FILLED`, `CANCELLED`, `EXPIRED` and `UNKNOWN` where appropriate. Support synthetic feed and crash-safe replay. Make every order insertion idempotent by strategy/portfolio/signal/version.

### Acceptance
Restart during partial fill does not duplicate money or orders; ledger reconciles; no import path to real withdrawal/trade SDK methods; test a late fill and an expired limit order.

## Iteration 2 Prompt — Realistic Virtual Execution
Subscribe to public trades/quotes with reconnect and latency measurement. Simulate market orders using observed spread and modeled slippage; limit fills based on conservative quote/trade/queue evidence, not price touching alone. Keep configurable fees, uncertainty and optional funding for strictly simulated perps. If live order book is unavailable, identify decreased fill fidelity. Add portfolio equity, unrealized/realized PnL, exposure and drawdown recording.

### Acceptance
Trade and quote fixtures prove no immediate limit fills without evidence; fees are charged consistently; two independent portfolios cannot consume each other's balances; data interruptions pause rather than fake prices.

## Iteration 3 Prompt — Reliability and Human Observability
Add run controls (pause, resume, kill switch), daily reconciliation, health/alert events, outage handling, snapshot restore, corrupt-feed quarantine and alert triggers. Detect clock skew, stale news feeds, failed source validation, provider license changes and invalid instrument metadata. Include paper transaction export and a full-day replay comparison against recorded live inputs.

### Acceptance
Simulated service restart yields identical reconstructed ledger; a network outage triggers safe HOLD; no automated real-money channel exists; operators can inspect each virtual fill's market evidence.

## Handoff / Review Prompt
Deliver a 24-hour synthetic soak test with injected outages and a documented `paper start`/`paper status`/`paper stop` CLI. Do not suggest that virtual fills prove real-world execution quality.
