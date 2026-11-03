# Module 02 handoff to Modules 03 and 04

Historical boundary note: this document records the completed Module 02 handoff before
Module 03 implementation. Offline market import/snapshots now exist; current status and
commands are in `docs/progress.md` and `docs/market-import.md`.

The foundation is complete through Iteration 3. Do not assume a data provider, Parquet
pipeline, collector, strategy, risk engine or broker exists. All current examples are synthetic.

## Stable shared contracts

Import versioned Zod schemas/types from `@crypto/contracts`. Use `MarketBarSchema`,
`NewsDocumentSchema`, the typed `eventEnvelopeSchema(payloadSchema)`, provenance,
quality flags, explicit raw timestamp units and availability/use labels. Parse unknown input;
do not cast provider JSON. Domain times normalize to branded UTC strings with nine digits.
Bars are half-open with exact declared duration. Financial values are validated decimal
strings; missing/uncertain values carry explicit states/reasons instead of fabricated zeros.

Core exports UTC/bigint conversion, mock/monotonic clocks, decimal math, frozen
`decisionView`, canonical hashing/IDs and versioned seeded randomness. Keep source
publication/provider occurrence times distinct from observations/availability. Unknown or
estimated availability is descriptive-only and cannot enter a tradable decision view.

## Persistence path

Use `ResearchDatabase` from `@crypto/db`, run migrations, then execute a transaction:

1. Preserve an immutable raw envelope with `ingestRaw({envelope, sourceRawId})`. Compute
   its `rawHash` from the preserved source bytes; let the repository deduplicate delivery.
2. Append normalized data with `appendMarketBar`/`appendNewsDocument`, giving actual
   stored raw IDs, `knownAt`, and `previousVersionId: null` for the first version.
3. Corrections require the prior version ID and a later knowledge time. Never update an old
   raw capture or normalized record. Repeated identical input returns `created: false`.
4. Read via `barsAt`/`newsAt` for a decision instant; these select the latest knowable revision
   and exclude future/unknown/descriptive data. Exact version/history retrieval supports audits.
5. Freeze research input version IDs/hashes in immutable run records when building reports.

Transactions roll back provenance/audit together. Writes serialize within a namespace.
Await every operation and do not retain repository sessions. Pages are bounded/keyset;
separate page calls are not a frozen dataset. Retention marks archive, rather than erase,
records; physical erasure and production role separation are not present.

## Module 03 — next iteration

Start **Iteration 1, Offline Historical Import** only. Implement the provider interface,
fixture/archive import, validation/quarantine, coverage report, explicit timestamp units,
source file URI/hash/normalization version and deterministic Parquet/metadata output.
Use BTC/ETH/SOL initially. Retain provider-specific inclusive end times in raw payloads,
normalizing to exclusive `MarketBar.closeAt`. Detect missing/duplicate/out-of-order/unit
change/bad-price fixtures rather than silently repairing them. No private trading credentials.

## Module 04 — independent interface handoff

Once requested, start **Iteration 1, Provider Registry and Fixtures**. Build provider/source
registry and source policy checks, parser fixtures, URL allowlists/SSRF limits and permissible
field handling. The database is a storage boundary, not a source license validator or network
fetcher. Article count/source chains do not establish independent corroboration; Module 05
will implement the verification graph. Do not infer availability from historical publication.
Do not enable sources requiring physical erasure until that storage policy is implemented.

## Verified gates and limits

Local checks: 54 database-independent tests, 18 real PostgreSQL integration tests, strict
typecheck/lint, operational smoke and contract demo. Integration covers clean migration,
down/up with data, duplicates/concurrency, rollback, causal corrections, future-data/retraction
handling, precision, pagination, audited retention, immutable triggers, corruption checks and
run/experiment/input hashes. Seed twice preserves exactly four captures/four versions and
one experiment/run, with a valid 14-entry audit chain.

No historical/live provider data is available yet. PostgreSQL 18.4 was tested through a native
isolated cluster; Docker readiness/remote CI remain unverified. The native helper is sufficient
for local persistence work. Production access controls, archival/erase policy, dataset object
storage, queue processing and realistic execution are later work, not silently completed gates.
