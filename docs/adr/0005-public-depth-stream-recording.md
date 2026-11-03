# ADR 0005: Finite public depth capture and causal replay

Date: 2026-10-30. Status: accepted for Module 03, Iteration 2.

## Context

Offline bars do not supply executable bid/ask observations or defensible live receipt order.
The next slice needs recoverable public data and replay while retaining existing history.

## Decision

Use a provider-neutral `MarketStream`, pure versioned `DepthStreamState` and finite bounded
runner. The first adapter uses Binance's dedicated public market-data hosts and native Node
fetch/WebSocket, with one mapped spot pair per capture. No new dependency is required.

Only a bridging sequence after REST recovery enables a book. Gaps, disconnects, clock
uncertainty, staleness and unknown depth disable usability. Preserve receipt/provider times;
availability reflects actual processing. Saved quotes expire independently of future ticks.
Rejected clock samples retry under the same budget without weakening uncertainty limits.

Store raw bytes, normalized steps and views in a hash chain with strict manifests and atomic
content-addressed JSONL publication. Replay the original order/times through the reducer.
JSONL preserves event boundaries; existing Parquet snapshots remain the offline analytical
format. Existing `research-run.v1` and SQL migrations remain unchanged. SQL recording indexes
and API/daemon integration are deferred.

## Consequences

Time/request/reconnect/memory bounds and provider denial/cooldowns are explicit. Tests remain
offline; actual public BTC checks separately verified transport and fail-closed clock behavior.
Depth is limited: no full queue, metadata history, fill model, broker or production readiness
claim exists. Hashes detect mutation without authenticating the provider or preventing the
owner from making another chain. Data rights are undetermined; source/terms links remain.
See `docs/market-streams.md` for limits, commands and actual results.
