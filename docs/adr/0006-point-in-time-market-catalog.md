# ADR 0006: Point-in-time market catalog, selection and quality

Date: 2026-10-31 (Europe/Moscow). Status: accepted for Module 03, Iteration 3.

## Context

Today's listed symbols and volume winners cannot define yesterday's opportunity set.
Provider symbols/precision can change and the same symbol can describe spot and perpetuals.
Price alignment also needs source identity, availability and an explicit tolerance.

## Decision

Introduce versioned `MarketData` and a bounded immutable `market-dataset.v1`. Store full
metadata assertions by effective boundary and observed/available revision, retaining every
listing, delisting, rename and precision change. Stable base/quote/instrument identities are
explicit. Select a visible revision before applying eligibility so an unavailable correction
cannot revive a superseded eligible value. Source/mapping ambiguity fails closed.

Rank only eligible closed intervals by quote turnover, conservative liquidity and stable ID,
with explicit coverage, age and drift rules. Preserve missing values and excluded candidates.
Listing-aware quality denominators differ deliberately from full-lookback universe coverage.
Unknown derivative data stays unknown. Candle projection retains parent evidence and never
manufactures quote turnover or book liquidity from OHLCV.

Cross-venue joins use explicit source/instrument keys, tolerance, compatible quote/base/type
and price quality, backward provider time, no later aggregate window, and one-to-one matching.
Record the latest prerequisite availability for future feature/replay consumers.

Expose pure library methods and a separate explicit loopback query service. Keep the existing
operational fixture health behavior. Publish complete input/config/result/code evidence as
content-addressed `market-quality-artifact.v1`; atomically create without overwriting and
recompute all outputs on verification. Existing bar/run/stream v1 schemas and SQL migrations
remain compatible. The new artifact is a versioned persistence boundary without SQL indexing.

## Consequences

Fixture acceptance covers delisted history, first eligible listing time, future corrections,
symbol/precision changes, unavailable perpetual data, gaps/spikes/drift, strict joins and
immutable evidence. Current live adapters are not a historical metadata authority. A real
catalog needs authorized captures of state changes; source references alone are not proof.

Full state assertions do not infer field-level corrections across several effective boundaries;
producers must publish each corrected boundary. Data is bounded/in-memory; larger indexing,
multi-provider collectors, dashboards and trading models are later integrations. No forecast,
fill or performance claims follow from these quality checks. See `docs/market-quality.md`.
