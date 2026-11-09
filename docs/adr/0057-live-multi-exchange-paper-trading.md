# 0057 — Persistent forward paper trading on five public spot feeds

Date: 2026-11-06. Status: accepted. Implements the requested live paper workspace;
Module 12 forward execution and Module 14 observability apply. Historical research
engines, reports, matrices, fee switches and existing pages remain unchanged.

## Decision

Add `/live-paper`, backed by an independent PostgreSQL namespace
`crypto_live_paper_v1`. Binance, Bybit, OKX, Bitget and MEXC supply public GET-only
spot order books, instrument metadata and completed hourly candles. Each venue
starts with **10,000 virtual USDT**, shared between SOL and XRP. The frozen V6
profiles come from matrix
`sha256:b314104b31d776fc8774ecad98d3062c70c31f3d703d0ed3fbb373b4aba23bad`.
Warmup history never creates positions. Only new completed hours after the run's
start can propose entries, and a later fresh quote is required for execution.

This is a new forward execution version, not the historical next-open simulator.
Both directions are fully collateralized, cash-settled **internal paper exposures**
priced from spot books. They are not exchange spot balances, margin loans or
perpetual contracts. Short borrowability, funding and exchange liquidation are
unknown and not modeled. A hypothetical 10% annual simple charge accrues on
remaining short entry notional, including downtime until an actual paper close.

Cash reserves entry notional for both directions. Entry fees reduce cash and
booked P&L. Partial exits release proportional reserved notional and settle the
price difference, less actual exit fees. The account projection plus open reserved
notional and marked price differences reconciles to equity. Open equity also
deducts estimated remaining exit fees. Negative cash remains visible and blocks
entries; it is never reset. Position net P&L includes entry/exit fees and borrowing.

Fees are frozen estimates: Binance/Bybit/OKX 0.1%, Bitget 0.2%, MEXC 0.05% per
fill. Actual account tiers may differ. Spread comes from the venue book; an
additional adverse 0.05% slippage and tick rounding apply. Fill participation is
at most 10% of each of five observed levels. Partial entries cancel their
remainder; partial exits retry on new sequence evidence. Size uses the existing
0.25% risk and 10% allocation limits, plus 20% combined venue exposure and 1% of
the completed signal candle's base volume. A 2% UTC daily loss latch blocks new
entries and requests risk exits. These are market-style orders with protective
stop/target triggers; no limit-order queue or real exchange execution is claimed.

## Persistence and recovery

The local API owns a non-overlapping five-second polling worker. A PostgreSQL
session advisory lock prevents a second worker; worker transactions use that
same leased connection, so connection loss fences its writes. Controls and
worker updates also share a transaction advisory lock. A unique partial index
permits only one active run. Durable state includes deadline, balances, remaining
positions, pending proposals, hourly watermarks and consumed quote sequences.
Positions, immutable source captures and hash-linked events commit atomically.
Position IDs derive from the run, venue, asset and signal identity. Closed
positions are preserved; failed transactions do not change balances or fills.

Unlike the deployment task infrastructure, this explicitly local, bounded
one-worker feature does not require Redis. PostgreSQL is its durable authority;
the timer is scheduling only. Keep the dashboard process and computer awake.
Restart resumes the original deadline without synthesizing missed trades. Future
hosting should move scheduling to the existing managed worker infrastructure.

The 24-hour deadline clears entries and requests all exits. Stale feeds never
produce fills. A position may remain CLOSING past the deadline until a fresh book
is available; the run remains STOPPING and its final profit is incomplete.
Pause disables entries but retains monitoring and exits. A source-code hash
prevents an active run silently switching execution implementations after restart.

Hourly history must be contiguous, with at least 224 completed candles and a
three-second close buffer. Signals older than 90 seconds are skipped, not replayed
at current prices. Quotes require receipt age <=15 seconds, HTTP duration <=3
seconds, and valid provider clock where available. Binance depth lacks an exchange
timestamp, so its weaker receipt-clock provenance is displayed. Books cannot be
crossed or unordered. Provider errors back off to 60 seconds; no venue substitutes
another venue's prices. Sampling can miss between-poll stops and targets.

## Inspection and evidence

The UI reads persisted open/closed positions and per-venue net liquidation
estimates while the run is active. WORKING is lifecycle, not a winning outcome;
WIN/LOSS/BREAKEVEN applies after full closure. Filters cover run, venue, asset,
side, result, lifecycle, opened/closed date range and net P&L bounds. Server-side
sorting is allowlisted and numerically correct, with stable identity tie breaks.
Exports use the same query, include all matching rows up to an explicit 50,000
bound, and use a repeatable-read snapshot. JSON contains fills and signal metrics;
CSV/TSV/Markdown are flat tables, with spreadsheet-formula protection for text.
Original quote captures are accessible from each fill.

`pnpm live-paper verify [RUN_ID]` re-executes recorded books/candles/metadata,
decisions, controls and account updates, checking every source/content hash,
event link and state hash against the selected persisted revision. It performs
no network requests and can verify a run in progress. It does not turn a partial
forward run into completed-day performance.

## Local configuration

The current checkout's ignored `.env` enables the feature and points to the
dedicated loopback PostgreSQL cluster in `.tools/postgres-live-paper`. The Windows
dashboard launcher starts only that cluster, with hidden subprocesses. It does
not modify or stop installed PostgreSQL Windows services or the fixture cluster.
`.env.example` defaults to disabled and allows a separately managed PostgreSQL
URL. Existing `DATA_MODE=fixture-only` still describes the old research workspace;
the explicit `LIVE_PAPER_ENABLED=1` opts this separate workspace into public live
network data. No secrets, private APIs or order routes are introduced.

## Primary API references

- [Binance public market data](https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/market)
- [Bybit order books](https://bybit-exchange.github.io/docs/v5/market/orderbook)
- [Bybit candles](https://bybit-exchange.github.io/docs/v5/market/kline)
- [OKX API v5](https://www.okx.com/docs-v5/en/)
- [Bitget public API documentation](https://www.bitget.com/api-doc/spot/market/Get-Orderbook)
- [MEXC spot API v3](https://mexcdevelop.github.io/apidocs/spot_v3_en/)

All five live order book, instrument and hourly candle endpoints were exercised
from this machine for both SOL and XRP. Unit tests cover finance, gaps, stale
data, timing, partial execution, restart identity and exports. PostgreSQL
integration tests cover atomicity, worker fencing, immutable evidence, replay,
filtering and numeric sorting. Authentication/origin tests protect the local
control and export boundary.
