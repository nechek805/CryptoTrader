# ADR 0050 — Frozen market strategies across multiple assets

Date: 2026-11-04. Status: accepted for retrospective local research.

The user requested a Market strategy tests dashboard tab with descriptions and real
historical tests for the existing BTC strategy versions across several cryptocurrencies.

Add a separate `/market-strategy-tests` page and bounded local research service. Replay
the frozen v1/v2/v3 rules on BTC, ETH, SOL, TRX, BNB, XRP, DOGE, ADA, LINK and AVAX against
USDT. Every cell starts with its own 10,000 virtual USDT. USDT itself is the cash control,
not an invented USDTUSDT instrument or a USD peg backtest. Do not add account balances
across the independent tests or present profitable-market counts as prediction accuracy.

The most recent verified public BTC snapshot anchors the exact six-month hourly window.
Capture other coins' own public candles for those same bounds, preserve the raw bytes,
actual download times, hashes and symbol-bearing decimal Parquet. Capture public exchange
metadata and apply its price tick, LOT_SIZE and minimum notional as explicitly static
retrospective assumptions. Historical metadata and candle availability remain unknown.
The fixed list includes current surviving instruments; it is not a historical ranking.

Use new market-history, market-test and market-matrix v1 contracts. A separate generic
runner keeps explicit base-asset units in the ledger and supports the original rules.
Keep original BTC engines and artifacts untouched. For BTC, compare all decisions,
fills, summary and journal against each original engine before publishing its row.
Cross-asset replay does not retune any threshold. Source fingerprints, plan hashes and
immutable report IDs distinguish the new reports from the original BTC reports.

Publish content-addressed reports and a matrix, then atomically advance the latest
pointer. Freeze/capture files are retained across reruns and restarts. A row requires
three distinct strategy results or an explicit failure; failed inputs never become
flat results. One bounded job executes at a time per local service and yields between
replays. Public requests are allowlisted and bounded; API inputs cannot supply URLs,
paths, balances, dates or unregistered strategies. Existing authentication, Origin
checks and request limits apply. These routes cannot be attached to deployment mode.

The UI separates Results, Strategies, Trade explorer and Sources & assumptions.
Describe intended improvements and failure modes, then show measured outcomes,
closed/open contribution, fee/slippage drag, exit groups, hourly decisions, fills,
costed buy-and-hold/cash, provenance, exports and exact selected-report replay.

This is exploratory research: v2/v3 were developed after seeing the BTC period, assets
share regimes, and current filters do not reconstruct historical order books or spread.
No native forward-experiment gate, original roadmap file, live-order capability or
existing strategy is changed. A green backtest is not promotion to forward or real money.

Rollback: stop the owned dashboard, restore the previous application code and retain
`data/market-strategy-tests` with all prior artifacts. Original BTC report locations and
IDs remain compatible. Never rewrite a frozen report to make an older version load it.
