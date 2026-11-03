# ADR 0020: Conservative spot envelopes and an append-only balanced virtual journal

Status: accepted, 2026-11-01. Scope: Module 08, Iteration 2.

Add a separate finite ExecutionSimulator over the existing availability scheduler and
canonical order/fill contracts. Consume explicit validated intents/candidates/risk permits;
do not turn candidates into executions automatically. Restrict to one source/venue,
cash/spot, shared quote currency and independent experimental portfolios. Reject borrowed
assets, leverage, derivative modes and live execution options.

Reserve cash including worst-rate per-lot rounded fee buffers, or reserve owned assets.
Validate historical listing/mapping and price/quantity grids at submission and for the
entire source candle. Require activity before candle open, record outcomes only when
price evidence is actually available, and never reuse corrected/late candles as liquidity.
Use adverse high/low market envelopes with spread/slippage and tick rounding; limits
require strict penetration sufficient for impact. Share a participation cap within each
portfolio and retain unknown depth/queue assumptions. Submission, protection and cancel
acknowledgements honor explicit latency. Expiry/release times are deterministic.

Protect each acquired lot with one inventory-backed reduce-only virtual market exit.
Stop wins when a candle also hits the target. Keep original stop trigger evidence through
capacity outages, price later fills from the later available candle, and avoid retroactive
entry-bar exits. Target exits use taker costs. Explicit cancellation/expiry releases
reservations without fabricated liquidation prices.

Persist separately versioned journal transactions with signed FREE/RESERVED/EXTERNAL/FEES
postings. Balance every asset and portfolio independently, forbid negative wallet balances,
and reconcile reservations/quantities after each action. Preserve exact decimal notionals,
explicit fee rounding, fill links, hash chain and all balance snapshots. Independent journal
replay checks arithmetic; complete simulation replay checks fill/authorization semantics.
Client order idempotency survives terminal states and rejects conflicting payloads.

Store immutable content-addressed artifacts with atomic no-replace publication and semantic
verification. Preserve older order/fill/ledger/replay schemas and SQL migrations. The only
dependency wiring adds the existing Decimal 10.6.0 to backtest; no new third-party version.
Bound the offline runner to two workers so native readers and spawned CLIs do not
oversubscribe the workstation; retain existing test deadlines.

OHLCV envelopes and volume caps are declared simulation assumptions, not proof of historical
executable quotes. External producer/risk evidence remains attributable input, not verified
semantic truth. Broader backtest orchestration, execution manifests, sensitivities,
benchmark/equity/PnL reports and deliberately unprofitable strategies remain Iteration 3.
