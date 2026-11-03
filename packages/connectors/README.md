# @crypto/connectors

`MarketDataProvider`, `FixtureMarketDataProvider`, and `BinanceArchiveMarketDataProvider`
read local, versioned OHLCV inputs with explicit unit/identity/checksum/ZIP bounds.
`MarketStream`, `BinancePublicStream` and `runMarketStream` add bounded public market-data
REST/WebSocket capture. `DepthStreamState` checks continuity, clock uncertainty and freshness;
`syntheticStreamSteps` supplies deterministic failure fixtures. No authenticated connector or
order endpoint is implemented.

`marketQualityFixture` supplies locally authored BTC/ETH/SOL, delisting/new-listing, rename,
precision-change and unavailable-perpetual-series cases for two fictional venues.

See `docs/market-import.md`, `docs/market-streams.md` and `docs/market-quality.md` in the root.

Module 04, Iteration 1 adds `NewsProvider`/`FixtureNewsProvider`, strict RSS/Atom/JSON Feed
parsing, explicit-offset publication time parsing and registry-oriented HTTPS/SSRF guards.
Iteration 2 adds `PublicNewsProvider`, fixed reviewed CISA/GDELT profiles and a versioned
live parser that preserves uncertain provider dates. Adapters require explicit CLI flags
and metadata-only permission gates. See `docs/news-registry.md` and `docs/news-live.md`.

Iteration 3 adds separately labelled synthetic `newsReviewFixtureCaptures` for verified,
archived, unknown, uncertain and rejected historical date cases. The original fixture
registry/capture list remains unchanged. See `docs/news-review.md`.
