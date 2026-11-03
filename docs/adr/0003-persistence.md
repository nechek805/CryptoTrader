# ADR 0003: Immutable PostgreSQL event/revision storage

Date: 2026-10-30
Status: accepted for Module 02, Iteration 3

Use pinned `pg` 8.23.1 and explicit versioned SQL instead of adding an ORM to a small initial
schema. Parameterize values and validate/quote namespace identifiers. Migrations and
checksums are transactional, reversible and protected against unknown versions or drift.
Existing operational/domain v1 schemas remain compatible; new storage wrappers and run
metadata are explicitly versioned.

Store raw captures immutably, with provider/hash identity and raw-ID aliases. Append derived
revisions with previous-version links and FK-backed raw provenance. Preserve monetary
strings in JSONB and index UTC time as explicit nanosecond NUMERIC(30,0), avoiding
timestamptz microsecond truncation and int64 nanosecond overflow after 2262.

Introduce per-revision `knownAt`, separately from persistence time and domain availability.
Select the latest known revision before applying eligibility. Otherwise an ineligible correction
could accidentally revive obsolete eligible content. Enforce increasing revision knowledge,
causal raw inputs, optimistic parents and fixed natural market identity.

Serialize writes per namespace with a PostgreSQL advisory transaction lock. This makes
duplicate delivery and the audit hash chain simple and deterministic at foundation scale.
Use one pooled client per transaction, snapshot read transactions and keyset pagination.
Actual volume/performance work can later narrow locks while preserving these semantics.

Persist immutable research records with verified exact input IDs/hashes and code/config/data
reproducibility metadata. Fixture source version is an explicit working-tree hash because
this project has no initial Git commit. This is not a live experiment launcher.

Reject UPDATE/DELETE/TRUNCATE through triggers on all business/audit tables. Audit
stores allowlisted identifiers/actions/hashes rather than news text or arbitrary details.
Expose fixed error codes/messages, discarding original SQL/parameter/callback error bodies.
These controls do not defend against a malicious schema owner/superuser.
Provided database startup suppresses bound-parameter logging and verbose failing-row
details, complementing sanitized application errors and content-free audit entries.

Implement retention as dry-run-first bounded archival with tombstones, retaining original
bytes and reference integrity for replay. Physical/rights-driven erasure is explicitly deferred
before providers requiring that policy can be enabled. Fixture clean may erase only the
reserved `crypto_fixture_*` schema; it is separate from research retention.

The existing Docker engine could not start. Installed PostgreSQL 18.4 binaries provide an
isolated loopback-only fixture cluster under `.tools/`, without touching the existing service.
Windows port 55432 was reserved, so the helper asks the OS for an available port. Real
PostgreSQL integration tests use unique temporary schemas; no database emulator is used.
Linux CI uses the existing PostgreSQL 17 Compose service. Network installation is needed
only for dependencies; local fixture/unit/database checks use no provider credentials.
