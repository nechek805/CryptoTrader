# Offline market import — Module 03, Iteration 1

The importer reads local files, validates and quarantines rows, reports coverage, and publishes
immutable Parquet snapshots. `MarketDataProvider` separates file adapters from the common
normalizer and storage. There are no background streams, private exchange keys or orders.

## Fixture demonstration

After the README's Node/pnpm setup:

```powershell
pnpm market import --provider fixture --symbols 'BTCUSDT,ETHUSDT,SOLUSDT' --from 2026-01-01T00:00:00Z --to 2026-01-01T00:05:00Z
```

Quote the comma-separated symbols in PowerShell. `--interval` defaults to `1m` and `--out`
defaults to `data/market`. The bundled synthetic fixture is intentionally imperfect:

| Symbol  | Expected | Accepted | Missing | Quarantined | Exact duplicates | Conflicting rows | Out of order |
| ------- | -------- | -------- | ------- | ----------- | ---------------- | ---------------- | ------------ |
| BTCUSDT | 5        | 3        | 2       | 1           | 1                | 0                | 2            |
| ETHUSDT | 5        | 1        | 4       | 5           | 0                | 2                | 0            |
| SOLUSDT | 5        | 5        | 0       | 1           | 0                | 0                | 0            |

There are 9 accepted candles and 7 quarantined rows. SOL also has one valid row outside
the requested half-open window. Missing ranges include leading/trailing gaps and are never
forward-filled. The BTC gap is `[00:03, 00:05)` UTC, two candles. Quarantine counts describe
invalid rows in supplied files; valid rows outside the request are counted separately.

## Local Binance spot archives

The adapter supports the documented 12-column spot kline CSV inside daily/monthly ZIP
containers. It does not download archives or contact any endpoint. Supply an authorized
local copy and a manifest whose paths are relative to the manifest file:

```json
{
  "schemaVersion": "archive-input-list.v1",
  "files": [
    {
      "path": "BTCUSDT-1m-2025-01-01.zip",
      "marketType": "SPOT",
      "capturedAt": "2026-10-30T20:00:00Z",
      "sourceUri": "https://data.binance.vision/data/spot/daily/klines/BTCUSDT/1m/BTCUSDT-1m-2025-01-01.zip"
    }
  ]
}
```

Use the actual UTC receipt/capture time for your copy; the example time is illustrative.
Source URI, filename, interval, symbol, archive period and explicit SPOT attribution must
agree. Filenames alone cannot prove where copied bytes originated; retain the original
archive and its official checksum. The initial symbol mapping is BTC/ETH/SOL against USDT.

```powershell
pnpm market import --provider binance-archive --symbols BTCUSDT --from 2025-01-01T00:00:00Z --to 2025-01-02T00:00:00Z --archives data/market-inputs/archives.json
```

An adjacent `<archive>.CHECKSUM` is verified automatically when present. An explicit
`checksumPath` makes that sidecar required. Wrong digests or filenames fail the whole import.
Absent sidecars are labelled `NOT_SUPPLIED`; ZIP CRC/structure checks still run, but this is
not equivalent to verifying an official digest or authenticating the provider.

The [provider format reference](https://github.com/binance/binance-public-data) describes
spot archive timestamps before 2025 as milliseconds and from 2025-01-01 as microseconds.
The versioned decoder selects units from the archive period/profile, never from digit count.
Unexpected units produce quarantined rows; they are not rescaled until they look plausible.
Inclusive provider close times become exclusive domain ends by adding exactly one declared
timestamp unit. Raw epoch strings/units and file/member hashes remain attributable.

Supported candle intervals are `1s`, `1m`, `3m`, `5m`, `15m`, `30m`, `1h`, `2h`, `4h`, `6h`,
`8h`, `12h`, `1d`. These are fixed UTC durations. Calendar-month/week candles, futures,
non-USDT mappings, symbol-renaming history and live data are outside this iteration.
Daily/monthly here describes the archive container, not a calendar candle duration.

The archive policy was reviewed against [Binance Vision dataset terms](https://github.com/binance/binance-public-data/blob/master/TERMS_AND_CONDITIONS.md)
version 1.0, updated 2026-08-26. This adapter is for personal/non-commercial offline research;
its source metadata retains Binance attribution, `CC-BY-NC-SA-4.0` and the terms reference.
Public access is not a blanket commercial-use grant. Preserve applicable terms with retained
inputs and derived outputs. No actual provider data is committed to test fixtures or fetched by CI.

## Temporal integrity and validation

Public archives can be corrected after publication. Downloading today's file does not establish
when its exact historical values first became known. Archive bars therefore have null
`availableAt`, `availabilityBasis: UNKNOWN`, `researchUse: DESCRIPTIVE_ONLY`, and
`UNCERTAIN_TIMESTAMP`. They remain excluded from eligible decision views even after the
current capture time. Descriptive coverage is not historical tradability or order-book quality.

The synthetic fixture has a declared logical capture time. Cleaned fixture bars become
eligible only at the latest file capture in the batch, after the normalization inputs/diagnostics
are known. No bar-close timestamp is substituted for that capture. This also prevents a later
input file from contributing duplicate/conflict information to an earlier decision.

Validation covers explicit symbol/type/interval attribution, field count/CSV syntax, epoch
unit and archive period, UTC alignment, exact duration, OHLC bounds, positive prices,
nonnegative volume and relevant auxiliary fields. Valid decimal spellings are canonicalized
without float conversion; original text is retained. Invalid prices, negative volume, malformed
rows and unexpected units are quarantined with raw text/hash, file URI/hash, physical line
and a stable reason code. There is no fabricated zero, nearest-minute snap or unit guessing.

Exact numeric duplicates select a deterministic source/line and increment duplicate counts.
Conflicting valid candles with the same logical identity are all quarantined, leaving a gap.
Valid out-of-order rows are reported/flagged and sorted explicitly. Coverage expectations
come from the requested range/cadence, not only the timestamps that happened to appear.

## Immutable snapshots and verification

The CLI prints a snapshot ID/path and summary, and creates:

```text
data/market/market-snapshot_<digest>/
  bars.parquet
  manifest.json
  quarantine.json
  raw-rows.json
```

`raw-rows.json` retains source metadata and physical row text/decoded fields, including
rejected and duplicate evidence. Original ZIP/CSV bytes remain in their input location; retain
them alongside the content hashes. Source URIs are logical provider/fixture URIs, so moving
a local copy/output directory does not change its data identity.

Parquet uses pinned DuckDB/node-api 1.4.4-r.1, one writer thread, stable row sorting,
uncompressed pages and a fixed Parquet/row-group policy. Financial amounts and UTC
nanosecond instants are UTF-8 columns, preserving their exact contracts rather than coercing
to floats or microsecond timestamps. A canonical `record_json` column retains the full
versioned normalized record/provenance; typed readers reconstruct and validate it.

The canonical manifest includes request, source/checksum/licensing metadata, coverage,
normalizer/writer/code versions, config/data hashes and actual artifact byte hashes. The CLI
records an actual working-tree source hash rather than inventing a Git commit. No wall-clock
generation timestamp or absolute output path enters this immutable manifest. Repeating
identical input/capture/config/software produces the same Parquet/metadata/snapshot hashes.
Changed input or code creates a new snapshot ID. Private staging is atomically renamed;
an existing matching snapshot is verified/reused, and conflicting bytes are never overwritten.

`readMarketParquet(path)` reconstructs exact imported records using DuckDB. The public
`verifyMarketSnapshot(directory)` validates manifest identity, every file hash, row count and
dataset hash. Verification detects owner tampering; files are not protected against their OS
owner by an ACL or external signature. Metadata and artifact reads are size-bounded.

## Optional PostgreSQL registration

Export itself needs no database. To persist raw captures, normalized versions and run metadata:

```powershell
.\infra\local-postgres.ps1 -Action Start
$env:DATABASE_SCHEMA = 'crypto_fixture_market'
pnpm db:migrate
pnpm market import --provider fixture --symbols 'BTCUSDT,ETHUSDT,SOLUSDT' --from 2026-01-01T00:00:00Z --to 2026-01-01T00:05:00Z --persist
```

Persistence verifies the published snapshot first and uses one transaction for every source
row (including quarantine/duplicates), accepted bar version, snapshot receipt and run input
reference. It records exact raw/file/row hashes and version IDs. Fixture capture/run times
are labelled logical fixture times; PostgreSQL `storedAt` records the actual persistence clock.

Snapshots are referenced through a new `market-snapshot-reference.v1` receipt carried in the
existing generic event log. The strict existing `research-run.v1` contract is preserved:
fixture imports use `FIXTURE_IMPORT`, real archives use `DESCRIPTIVE_STUDY`, and the
run references the snapshot receipt plus source/version records. Existing persisted rows and
SQL migration checksums are unchanged; no new SQL migration is needed for these new
versioned payloads. Receipts are descriptive metadata and cannot become trading inputs.

An unchanged fixture import creates 18 source-row captures, one snapshot receipt, 9 bar
versions and one run, giving 29 audit entries. Its second import creates none of them. Run
hashes cover code/config/exact input records; the receipt links metadata/Parquet/dataset hashes.
Software or file-version changes produce a new run. Conflicting revision chronology is refused
rather than retroactively changing an existing decision view.

Parquet publication and PostgreSQL cannot be one distributed transaction. If DB registration
fails, its transaction rolls back and the immutable snapshot remains available for retry.
Database registration is bounded to 5,000 raw source rows per command; larger exports are
supported without `--persist`. See `docs/persistence.md` for connection/retention limitations.

## Resource bounds and actual checks

The first slice accepts at most 100 archives, 16 MiB compressed per ZIP, 64 MiB per decoded
member, 128 MiB aggregate decoded input, 200,000 source rows and 100,000 expected bars
per requested symbol. Rows are bounded to 8 KiB. Unsupported encodings/headers, integrity
failures and resource violations fail the import rather than silently accepting partial input.
Ordinary decodable malformed rows go to quarantine. ZIPs require exactly one expected
CSV member; traversal, symlinks, encryption, extra entries, invalid sizes and CRC failures are
rejected without extracting entries to paths. Native DuckDB extension autoload/install is disabled.

Local checks passed: 70 database-independent tests and 20 real PostgreSQL integration
tests, plus lint/typecheck/doctor/smoke. Golden tests assert fixture coverage and a fixed
Parquet byte hash, repeat exports in different directories, detect mutation, and verify
quarantine, ZIP integrity, explicit ms/us transitions, empty outputs and CLI failures.

Two actual official BTC 1-minute archives (2024-12-31 and 2025-01-01) and their official
checksums were also downloaded once for verification. All 2,880 candles validated with
zero missing/quarantined rows, all descriptive-only. The CLI itself and tests make no downloads.
The copies and generated datasets are in ignored `data/`, with attribution retained in snapshots.
The same real import was also registered twice in an isolated local database namespace:
2,880 source-row captures plus a snapshot receipt, 2,880 bar versions and one run produced
a valid 5,762-entry audit chain. The repeat added no records and preserved the same head.
No news, live streams, order-book data or historical eligibility evidence was added.

Subsequent stream/replay work is documented in `docs/market-streams.md`; point-in-time
universe and quality queries are in `docs/market-quality.md`. Module 03 is complete.
The next assignment is Module 04, Iteration 1: news registry and fixtures.
