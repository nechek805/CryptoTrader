# ADR 0004: Offline OHLCV import and immutable research snapshots

Date: 2026-10-30
Status: accepted for Module 03, Iteration 1 only

Separate provider-specific file decoding in `@crypto/connectors` from normalization,
coverage/quarantine, Parquet and persistence orchestration in `@crypto/research`. The initial
registry supports a synthetic fixture and Binance spot daily/monthly archives; shared output
is the existing exchange-labelled `MarketBar`, not an exchange trading SDK.

Require explicit original spot URI/type attribution and filename/period consistency. Pin
provider/decoder profiles for pre-2025 millisecond and post-2025 microsecond spot data.
Never infer units from magnitude. Convert inclusive closes by one explicit source unit.
Keep original file/member hashes and physical row evidence, verifying official ZIP sidecars
when supplied, CRC and strict single-member bounds without filesystem extraction.

Use conservative archive availability: descriptive-only with unknown historical first availability.
Fixture eligibility begins only after the entire input batch's declared capture. Quarantine
ordinary malformed rows and all conflicting candles; count exact duplicates and disorder,
normalize valid decimal spellings exactly and sort transparently. Never repair invalid values
or fill gaps. Expectations come from the declared half-open range/cadence.

Write actual Parquet through pinned DuckDB 1.4.4-r.1 with explicit stable row/page/thread
settings and exact string fields. Canonical manifests carry actual byte/data/config/code hashes.
Publish through private staging and atomic rename into a content-addressed directory;
verify/reuse existing bytes and reject conflicts. Store operational output paths outside hashes.
This avoids output timestamps, random file IDs or machine-specific paths breaking replay.

Reuse existing transactional raw/revision/run storage. Persist a separately versioned snapshot
reference as an event payload rather than extending the strict existing run v1 format.
The existing purpose classifications cover fixtures and descriptive archive studies. This
adds versioned schemas without modifying existing persisted contracts or SQL checksums.
All source rows, normalized versions, receipt and run commit together; the output directory
can survive a later failed DB transaction for an idempotent retry.

Keep the default path database-independent. Bound optional transactional DB registration to
5,000 source rows and document larger artifact-only imports. Bound decoded input and
expected range sizes before expensive processing. This is a small offline vertical slice,
not live ingestion, historical universe selection, a scalable bulk loader or an execution model.

Provider format/terms references, actual archive verification and exact commands are in
`docs/market-import.md`. No authenticated market requests or automatic downloader was added.
