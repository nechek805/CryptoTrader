# ADR 0017: Shared-cutoff cross-asset features and explicit missing references

Status: accepted, 2026-11-01. Scope: Module 07, Iteration 2.

Use existing frozen OHLCV and point-in-time instrument/book datasets with explicit series
bindings. Every row shares one knowledge cutoff. Joins are backward-only within a
declared tolerance shorter than an interval; original actual closes/availability remain
visible. Do not join a later-known BTC candle onto ETH, interpolate gaps, substitute a
different reference, or revive an older source revision invalidated by known quality.

Historical listings/mappings/precision gate every full source-bar interval. Reuse the
existing quote-volume/book-liquidity universe selector and expose empty/partial results
when data is missing. Breadth uses actual complete selected responses and publishes its
denominator; concentration is explicitly selected exchange turnover rather than market
capitalization or risk. Audit ranking-excluded observations as inputs to selection too.

Compute BTC return differences and matched one-bar rolling/lagged correlations with
explicit direction, pair counts and known-at bounds. Keep nulls for insufficient pairs
or zero variance and never bridge missing source intervals. Define deterministic trend
efficiency, direction and log-return high-volatility flags separately; missing history
is UNKNOWN and volatility need not be mutually exclusive with trending/ranging.

Derivatives have their own strict measurement/publication/receipt/availability evidence.
They require eligible supported perpetual metadata and freshness. Spot is not applicable;
missing/unpublished/unsupported/stale fields cannot become numeric zeros. Ignore inline
candle/book derivative fields for these features unless separately timed evidence exists.

Publish separate versioned, content-addressed cross-feature artifacts with semantic
verification, source audits, catalog and code/config/input hashes. Preserve original
technical feature schemas/results. No dependencies, SQL schemas, live fetches, strategies
or execution modes change. Dataset panel construction and leakage audits remain Iteration 3.
