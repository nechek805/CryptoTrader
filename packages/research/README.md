# @crypto/research

`normalizeMarketImport` validates/quarantines OHLCV rows and computes coverage.
`writeMarketSnapshot`, `verifyMarketSnapshot`, and `readMarketParquet` provide immutable,
deterministic Parquet/JSON snapshots through DuckDB. `persistMarketImport` optionally
registers source rows, versions, a snapshot receipt and reproducible run in PostgreSQL.

`writeStreamRecording` publishes bounded content-addressed observation chains;
`replayStreamRecording` validates hashes and recomputes each depth view in receipt order.

`SnapshotMarketData` implements versioned read-only `MarketData` history, resolution, data,
universe, quality and cross-venue queries. `marketObservationFromBar` preserves bar lineage,
candle-only quality and missing turnover/liquidity. `buildMarketQualityArtifact`,
`writeMarketQualityArtifact` and `verifyMarketQualityArtifact` retain/recompute inputs/results.

See `docs/market-import.md`, `docs/market-streams.md` and `docs/market-quality.md`.
Event studies/features remain Modules 06 and 07.
