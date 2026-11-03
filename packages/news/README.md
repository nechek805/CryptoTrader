# @crypto/news

`NewsRegistry` validates provider/source policy and resolves only known configured feeds.
`NewsIngestStore` retains captures, parser diagnostics and append-only article versions with
point-in-time reads. `persistNewsStore` registers providers/sources/captures/metadata as
versioned raw evidence and uses the existing PostgreSQL NewsDocument history.

`NewsPollJournal`/`NewsPoller` add bounded single-host public metadata capture, durable
quotas/retries/dead letters and replay. Duplicate views preserve separate occurrences and
label possible dependencies without verifying facts. The CLI fixture package remains
synthetic. See `docs/news-live.md` and `docs/news-registry.md`. Article review starts in
Module 04, Iteration 3 via `NewsReviewService`, `NewsCorrectionJournal`, coverage and
content-addressed snapshot build/write/verification. Prospective correction overlays retain
original evidence and past views. Replay excludes descriptive historical data and requires
explicit opt-in for estimates. See `docs/news-review.md`.

Module 05, Iteration 1 adds configurable `defaultNewsOntology`, literal evidence extraction,
`NewsClaimExtractor`, synthetic fixtures and optional append-only result persistence.
Structured responses are untrusted and reconciled against the supported grammar; injected
adapters accept synthetic inputs only. Every assertion remains unverified. See
`docs/news-extraction.md`.

Iteration 2 adds `NewsGraphService`, `NewsGraphJournal`, `evidenceIndependenceScore`, conservative
anchored clustering, attributed dependency edges, contradiction/retraction history and local
review commands. PostgreSQL graph projection is append-only and idempotent. See
`docs/news-independence.md`.

Iteration 3 adds `NewsEventService`/`NewsEventJournal`, immutable event snapshot build/write/
verification, prospective split/merge lineage, declared asset/expectation context, explained
confidence and scoped novelty. `newsEventResearchInputs` supplies point-in-time downstream
inputs; `newsEventProvenanceDot` emits offline provenance. See `docs/news-events.md`.
Module 06 event studies and all trading behavior remain unimplemented.
