# Module 03 — Market Data Collection and Normalization

## Objective
Provide timestamp-correct, multi-exchange, multi-asset public market data suitable for historical research and live **read-only** signal generation. Start with BTC, ETH and SOL against a stable quote currency; support extensible universe membership.

## Dependencies
02; contracts from the master. First adapter may be Binance **public datasets** even if the future trading venue is different; access and redistribution must comply with provider terms.

## Iteration 1 Prompt — Offline Historical Import
Implement `MarketDataProvider` plus a fixture adapter and an import adapter for publicly permitted daily/monthly OHLCV archives (provider-specific versioned format). Validate zip checksums when supplied, timestamp units explicitly, symbol identity, market type, interval, OHLC consistency, volume non-negativity, missing periods and duplicates. Retain raw file URI/hash and normalization version. Use a CLI command such as `market import --provider fixture --symbols BTCUSDT,ETHUSDT,SOLUSDT --from ... --to ...` and publish per-symbol coverage reports. No user credentials.

### Acceptance
Golden fixtures containing missing candles, duplicated bars, out-of-order data, unit changes and bad prices; malformed rows quarantined rather than silently fixed; deterministic normalized Parquet and metadata hashes.

## Iteration 2 Prompt — Live Read-Only Streams
Add a provider-neutral `MarketStream` (WebSocket + REST recovery) for trades, bid/ask or order book snapshots, with bounded reconnects, sequence checks, server clock offset, heartbeat, rate limit and stale-data detection. Do not implement private exchange keys or order placement. Maintain event `observedAt` separately from provider time, and mark whether a stream is executable-quality (order book) or candle-only. Include a recording mode and synthetic feed.

### Acceptance
Disconnect and reordering fixtures, clock-skew tests, packet gap recovery, stale stream marked unusable; immutable recorded replay reproduces observations in the same order.

## Iteration 3 Prompt — Universe, Quality and Cross-Venue
Implement top-N selection using **point-in-time** volume/liquidity rules rather than a static list of today's winners. Track asset/pair metadata changes, precision, listing/delisting windows, spot vs perpetual symbols, provider mapping and unavailable derivatives fields. Add quality metrics (missing fraction, abnormal spikes, timestamp drift, exchange divergence). Provide a query API and a small report comparing BTC/ETH/SOL time alignment.

### Acceptance
A historically delisted asset is not erased; a newly listed instrument is excluded before its first eligible timestamp; cross-exchange prices cannot be joined without an explicit tolerance and source ID.

## Handoff / Review Prompt
Run import, recorded replay and quality reports for fixture data. Record API limits, provider/terms links, data coverage and known inaccuracies. Provide a versioned MarketData interface to 06, 07 and 08. Stop.
