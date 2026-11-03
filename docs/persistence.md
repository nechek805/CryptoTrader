# PostgreSQL persistence — Module 02, Iteration 3

`@crypto/db` uses parameterized node-postgres queries and versioned SQL migrations.
The fixture API/worker remains database-independent. Persistence is an explicit CLI/library
operation; no providers, order endpoints or trading engine are enabled.

## Local startup

Use Node/pnpm and PATH setup from the README. Either run the root Compose stack, or use
the installed PostgreSQL binaries on this Windows workstation:

```powershell
# Uses an isolated cluster under ignored .tools/, without altering the existing service.
.\infra\local-postgres.ps1 -Action Start
pnpm db:migrate
pnpm db:seed
pnpm db:seed
pnpm test:integration
.\infra\local-postgres.ps1 -Action Stop
```

The helper defaults to `C:\Program Files\PostgreSQL\18\bin` (override `-BinDir`). It binds
only to loopback, asks the OS for an available port, and sets `DATABASE_URL`,
`TEST_DATABASE_URL`, and `DATABASE_SCHEMA=crypto_fixture_local` in that PowerShell session.
It uses local trust authentication with no passwords. It preserves the fixture data directory
on stop. It does not start/stop/reconfigure the existing PostgreSQL Windows service or Docker.

For Compose:

```powershell
pnpm infra:up
$env:DATABASE_URL = 'postgresql://research@127.0.0.1:5432/crypto_research'
$env:TEST_DATABASE_URL = $env:DATABASE_URL
$env:DATABASE_SCHEMA = 'crypto_fixture_local'
pnpm db:migrate
pnpm db:seed
pnpm test:integration
```

`.env.example` supplies the Compose development URL, without secrets. The DB CLI reads
`.env` when present. Integration tests require `TEST_DATABASE_URL` explicitly and fail if
it is missing; they never silently substitute a fake database or skip the suite. They create
random `crypto_test_<uuid>` schemas and drop only those schemas during teardown.
Connection permission to create schemas/functions/tables is required on a dedicated test DB.

`pnpm test` now runs 70 database-independent tests offline after installation.
`pnpm test:integration` now runs 20 actual PostgreSQL tests over loopback, including market import registration.
`pnpm check:db` runs the combined normal checks plus integration tests. Linux CI starts
Compose and runs integration tests; Windows CI runs the database-independent checks.

## Migrations and fixtures

`pnpm db:migrate` applies `0001_foundation` transactionally. Migration metadata records a
checksum covering both up/down SQL with normalized line endings. Reapplying the same
software is idempotent; unknown versions or changed applied checksums fail. SQL statements,
schema creation and migration metadata commit together under a namespace-scoped write lock.
Library `db.migrate('down')` is an explicit destructive rollback used by migration tests.
Do not edit a migration after real persisted deployments; add a new version.

`pnpm db:seed` imports synthetic BTC/USDT, ETH/USDT and SOL/USDT bars and one synthetic
news document, records an experiment manifest and a fixture-import run, and verifies audit
integrity. With unchanged source/config/data, a second import adds zero raw records,
revisions, experiments, runs or audit entries. It prints counts and hashes rather than text.

`pnpm db:clean` drops and recreates the selected fixture schema, including its audit history.
It is deliberately limited to the reserved `crypto_fixture_*` namespace. Seed has the same
namespace restriction. Normal research schemas cannot be reset through this command.
This is a local fixture reset, not retention of research data or a production maintenance API.

The seed's `codeVersion` is `working-tree:sha256:<digest>` covering app/package code,
SQL, package/config inputs, lockfile and fixture sources. It does not pretend an uncommitted
checkout has a Git commit. Config and input data have separate canonical hashes. Code
changes create a new fixture run/experiment ID while identical raw/version inputs deduplicate.
Seed logical run times use the labelled synthetic experiment timeline; `storedAt` records the
actual persistence clock. No backtest, risk decision or trading run is executed by seed.

## Repository usage

```ts
const db = new ResearchDatabase({ connectionString, schema: 'crypto_research' });
await db.migrate();
try {
  const saved = await db.transaction(async (repo) => {
    const raw = await repo.ingestRaw({ envelope, sourceRawId: 'provider-event-id' });
    return repo.appendMarketBar(bar, {
      sourceRawIds: [raw.record.id],
      previousVersionId: null,
      knownAt: bar.availableAt!, // use a validated, defensible revision knowledge time
    });
  });
  const page = await db.read((repo) => repo.barsAt(decisionTime, { limit: 100 }));
} finally {
  await db.close();
}
```

The example assumes validated non-null bar availability. Real callers must handle unknown
availability explicitly; descriptive news can have null availability while `knownAt` remains
the time the descriptive revision itself was known.

All operations in a transaction use [one checked-out client](https://node-postgres.com/features/transactions). Await every repository operation;
do not fire and forget work or retain sessions outside the callback. Any failure rolls back
raw/derived/references/audit changes together. Sessions reject use after commit/rollback.
Read callbacks expose a restricted interface and run in REPEATABLE READ READ ONLY
transactions. Write callbacks serialize per namespace using an advisory transaction lock,
ensuring idempotency, optimistic revision parents and a single consistent audit chain. This
is a conservative foundation throughput choice, not a high-volume ingestion benchmark.

| Operation                                  | Result and invariants                                                                                                           |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `ingestRaw({envelope, sourceRawId})`       | `{created, record}`; source-scoped raw hash dedup and optional raw-ID alias mapping; first observation metadata retained        |
| `getRaw`, `findRawDelivery`, `listRaw`     | Validated immutable envelopes; archived records hidden by default                                                               |
| `appendMarketBar`, `appendNewsDocument`    | `{created, record}` with version ID, logical ID, revision, known time, previous version, raw-source references and content hash |
| `getBarVersion`, `getNewsVersion`          | Retrieve an exact version ID; explicit `includeArchived` available for retained replay data                                     |
| `barHistory`, `newsHistory`                | Paginated, preserved revision history                                                                                           |
| `barsAt`, `newsAt`                         | Latest revision known at a decision time, followed by eligibility/availability checks                                           |
| `recordRun`, `recordExperiment`            | Immutable hashed records with verified persisted input IDs/hashes                                                               |
| `getResearchRecord`, `listResearchRecords` | Validated run/experiment records and exact input references                                                                     |
| `listAudit`, `verifyAuditChain`            | Content-free audit metadata and chain integrity verification                                                                    |
| `archiveBefore`                            | Bounded, dry-run-by-default retention/archive selection with immutable tombstones and audit entries                             |

Schema/type wrappers (`stored-raw-event.v1`, `stored-revision.v1`, `research-run.v1`,
`stored-research-record.v1`, `audit-entry.v1`) are exported from contracts. Stored market/news
wrapper validators are also exported by `@crypto/db`. Input validation and read parsing
protect the library boundary; direct database-owner SQL is outside that boundary.

## Immutable identity, corrections and provenance

Raw identity is provider + raw content hash. Multiple source raw IDs may alias the same
logical capture. Reusing provider/raw ID for different bytes or reusing a raw hash for different
kind/occurrence/payload is a conflict. Duplicate receipt metadata does not overwrite first
observation/availability. `rawHash` is supplied by the adapter and must cover its preserved
provider bytes; the repository additionally hashes the normalized envelope and checks that
checksum on reads. Raw envelopes are bounded to 1 MiB.

Corrections append versions; they never update raw records or prior normalized versions.
The caller supplies the previous version ID (optimistic concurrency), a strictly later `knownAt`,
and actual stored raw-source IDs. Missing sources fail. Eligible normalized data cannot be
derived from descriptive/unknown or later-available raw inputs. Changed source attribution
with identical record content conflicts rather than silently discarding provenance.
Market identity (exchange/instrument/type/interval/open/end) remains fixed across corrections;
another logical ID cannot duplicate the same natural bar identity.

`knownAt` is when this exact revision became known; it must not follow a non-null declared
`availableAt`, and it cannot precede its raw sources' observations/known availability. The
storage wrapper preserves this field separately from `storedAt` and domain availability.
Point-in-time queries first select the latest revision whose `knownAt <= decisionAt`, then
require `ELIGIBLE` and `availableAt <= decisionAt`. A newly known descriptive correction
therefore suppresses the obsolete eligible version; it does not make an old version reappear.
Older decisions still retrieve the original version. Providers/normalizers remain responsible
for truthful availability, correct prices and licensed storage policy.

Input provenance is enforced by foreign keys for normalized raw sources and run/experiment
inputs. Run/experiment registration verifies referenced stored checksums and matching input
hash sets. Experiment inputs must already be observed/known at freeze time. This foundational
manifest store is not the full Module 15 experiment preflight or launch gate.

## Precision, pagination, audit and retention

Payload timestamps remain normalized nine-digit UTC strings and are indexed as explicit
nanosecond `NUMERIC(30,0)` values, supporting dates beyond bigint's epoch-nanosecond range.
JSONB preserves monetary/quantity decimal strings. No money or epoch nanos is parsed into
a JavaScript number. Database bigserial cursors are also decimal strings.

Pagination uses bounded keyset pages (default 100, maximum 500), with an opaque versioned
cursor tied to namespace/query/filter. It is not an authorization token. A cursor from another
query or decision time fails validation. Sequences order append history; point-in-time result
pages order logical IDs using C collation. One read callback has a consistent snapshot;
separate page requests do not freeze concurrent historical backfills. Persist exact version IDs
in run inputs for reproducible research snapshots.

Raw/delivery/derived/source/run/input/retention/audit tables reject UPDATE, DELETE and
TRUNCATE with statement triggers. Audit entries contain allowlisted action/type/IDs/time/
hashes only, with previous-entry hashes and deterministic IDs. They never contain article
titles, snippets, full text, configs or connection credentials. Driver/callback errors are replaced
by `PersistenceError` codes with fixed messages, without query parameters or original causes.
Idle connection failures are signalled as a sanitized STORAGE failure on the next operation.
The supplied Compose/native startup also disables PostgreSQL bound-parameter logging
(`log_parameter_max_length=0`, `log_parameter_max_length_on_error=0`) and uses
`log_error_verbosity=terse` to suppress failing-row detail. Apply equivalent settings on an
externally supplied server before storing licensed content; the client library cannot control
custom database/server logging. Restart the fixture helper after changing its startup settings.
Database-owner privileges can bypass triggers or rewrite an entire chain; external anchoring
and separated production roles are not implemented by this local foundation.

Retention currently means archival, not byte deletion. `archiveBefore({kind, before, limit,
dryRun})` selects records by persistence `storedAt`, previews by default, and appends marks
and audit on explicit execution. Default reads hide marked versions; explicit replay reads can
still inspect retained bytes. It does not delete referenced data, audit history or licensed
content. License-driven physical erasure/secure storage policies must be designed before
collecting sources that require them. Fixture reset is the only provided schema-erasure CLI.

Local PostgreSQL 18.4 integration was executed. Compose targets PostgreSQL 17; its Linux
CI gate is configured but was not run remotely. No live market/news data or results exist yet.
