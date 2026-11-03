# Point-in-time market data and quality

Module 03, Iteration 3. Verified 2026-10-31 (Europe/Moscow). Execution remains disabled.
This slice supplies an immutable research snapshot and query API. Two fictional venues and
all fixture prices, volumes, liquidity, listings and instrument identities are locally authored.
No new exchange metadata/trade collector or actual cross-venue coverage is claimed.

## Commands and saved evidence

Use the pinned Node/pnpm PATH in the root README.

```powershell
pnpm market quality --provider fixture
pnpm market verify-quality --artifact 'C:\absolute\path\to\market-quality_<hash>.json'
pnpm market serve-fixture --port 3001
```

Quality capture defaults to fixtures, writes to `data/market-quality` (`--out` overrides),
and prints the report path, hashes, selected universe and BTC/ETH/SOL alignment. Other
provider/credential/endpoint flags are rejected. The query service binds `127.0.0.1` only;
stop with Ctrl+C. It uses the same synthetic catalog and performs no outbound requests or
database writes. The existing `pnpm dev` health service stays separate.

The CLI report evaluates a four-minute synthetic grid at `2026-01-01T00:04:03Z`. That is
an explicit evaluation clock, not a fabricated wall-clock creation time. Its source/software/
configuration hashes support recomputation. No randomness, strategy, fee model or financial
run exists in this report.

Verified quality artifact:
`data/market-quality/market-quality_f1f114874313c5103121c53e6e8aa47c867d4cc2b7439aaabcfdfd3173e608fd.json`.
Artifact hash: `sha256:f1f114874313c5103121c53e6e8aa47c867d4cc2b7439aaabcfdfd3173e608fd`.
Normalized dataset hash: `sha256:0f4a841b5bfced4b64806d10b4bf81e241b221c91863b47b84de6a87832aa684`.

## Metadata and knowledge time

`instrument-revision.v1` keeps stable `instrumentKey`, base/quote asset IDs, source/venue,
market type, provider symbol, asset display code/name, decimal price tick and quantity step,
listing/delisting boundaries, derivative-field availability and receipt/availability timestamps.
An instrument key cannot change venue, source, asset identity, quote identity or market type.
A display/provider rename retains identity. Spot and perpetuals may share provider symbols
but remain separate instruments. Asset IDs are explicitly curated; fuzzy ticker matching and
stablecoin-equivalence assumptions are not performed.

Each revision is a full state assertion starting at `effectiveFrom`. For a market time and
decision cutoff, choose the latest effective boundary already knowable at the cutoff, then
the highest revision at that boundary. Later precision, naming or delisting statements cannot
enter an earlier decision view. Corrections to several effective boundaries require explicit
revisions at those boundaries; the reader does not infer field-level historical corrections.
Revisions never delete earlier records. Knowledge/revision ordering conflicts are refused.

History returns only revisions observed and knowable by its cutoff, including descriptive
evidence for inspection. A null availability can be inspected after its actual capture but
cannot qualify for eligible decisions. Eligible reads require defensible observed/archived
availability. An unknown/descriptive current revision does not revive an older eligible value.

Listing lifetime is `[listedAt, delistedAt)`. A completed observation window must lie fully
inside that lifetime. Historical observations ending exactly at delisting remain available;
membership at or after delisting is excluded. A new listing needs known metadata and a
completed eligible observation. Metadata changes inside a window produce a visible exclusion.
Ambiguous active provider mappings fail closed. All historical revisions remain in the input
artifact even when a query cannot see them.

## Observation and universe semantics

`market-observation.v1` retains source/instrument/provider identity, parent evidence ID/hash,
revision, exact completed interval, provider time, local observation/availability, data quality,
price, quote turnover, liquidity and explicit derivative metric status. UTC values are canonical
nanoseconds; prices/quantities are decimal strings. Decimal tick membership is checked exactly
without rounding. Quantity steps are retained metadata; there are no order quantities or
exchange order-validation claims in this slice.

For this interface `ORDER_BOOK` price is a reported best bid; `CANDLE_ONLY` price is a bar
close. Price joins require matching quality. Book-labelled fixture inputs are synthetic and
do not prove fillability. The declared liquidity metric is the smaller bid/ask quote notional
within 100 bps of the midpoint, measured conservatively over each completed window. Real
producers must establish that metric from adequate raw depth coverage; five visible levels
or OHLCV alone cannot establish it.

`marketObservationFromBar(bar, instrumentRevision, revision)` binds existing `MarketBar`
records explicitly to venue/pair/type metadata. It retains parent ID/hash, source capture and
availability, labels the result `CANDLE_ONLY`, and leaves quote turnover and book liquidity
null. Base volume times close is not substituted for quote turnover. Unknown archive
availability remains descriptive. Incompatible bindings and incomplete capture timestamps
fail. The original Parquet/raw evidence remains the referenced parent; it is not rewritten.

Top-N selection is source-, quote-asset- and market-type-specific. It uses only closed,
available intervals from the declared `[from,to]` grid, with `to <= decisionAt`. Revisions
are selected by logical window before eligibility filtering. The rules explicitly require:

- Requested count and minimum quote turnover (sum of known window turnover).
- Minimum liquidity (minimum known value across accepted windows).
- Minimum coverage over the entire requested lookback, including prelisting slots.
- Maximum age of the window and of the latest observation.
- Maximum absolute receipt-minus-provider timestamp difference.

Missing turnover/liquidity excludes a candidate; missing values never become zero. Ranking
is quote turnover descending, then minimum liquidity descending, then stable key ascending.
Candidates below the count are recorded as `RANK` exclusions. If fewer candidates qualify,
the result has fewer than N entries; it does not backfill failed assets. Selected entries
include actual observations and metadata revision IDs. Every result carries request and
dataset hash. No static list of today's winners is used by the selection algorithm.

## Quality and alignment

Quality reports distinguish unavailable/not-listed slots from missing eligible slots. The
denominator is the eligible listing grid; no eligible slots yields an unknown fraction (`null`).
Universe coverage deliberately uses the full lookback instead, making newly listed assets
wait for sufficient history. Excluded off-grid, precision, mapping, derivative or metadata
boundary observations remain visible as diagnostics; gaps are never rounded or forward-filled.

Spikes compare contiguous accepted prices only: absolute relative change times 10,000,
against an explicit threshold. A gap is not interpreted as a one-step return. Timestamp drift
is absolute `observedAt - providerAt`, reported in decimal milliseconds. It combines clock
error, source delay and transport latency; it is not a clock-offset estimator. Derivative
values use `KNOWN`, `UNAVAILABLE` (reason, no value), or `NOT_APPLICABLE`. Spot requires
not-applicable fields, and unsupported perpetual fields remain unknown rather than zero.

Cross-venue queries require both source IDs, stable instrument keys, common asset/quote/type,
an explicit millisecond tolerance, and an explicit divergence threshold. Same-venue and
incompatible identity/spot-perpetual joins are refused. The deterministic policy is backward
as-of provider time with one-to-one matching; later aggregate windows and later provider
prices cannot serve an earlier anchor. No right observation is reused. Matches expose both
evidence and metadata IDs plus availability equal to the latest prerequisite availability.
Downstream decisions must respect that time, rather than just the provider time.

Fixture results at **250 ms tolerance**, divergence threshold **500 bps**:

| Pair     | Alpha missing fraction | Beta spikes | Beta drift violations | Matches | Unmatched alpha | Divergent matches |
| -------- | ---------------------- | ----------- | --------------------- | ------- | --------------- | ----------------- |
| BTC/USDT | 0                      | 0           | 0                     | 4       | 0               | 0                 |
| ETH/USDT | 0                      | 0           | 4                     | 0       | 4               | 0                 |
| SOL/USDT | 0.25                   | 2           | 1                     | 3       | 0               | 1                 |

BTC/SOL provider lag is 200 ms; ETH lag is 900 ms. An explicit 900 ms tolerance would match
ETH, constituting a different query. Alpha SOL also has one drift violation and one missing
liquidity value. The synthetic perpetual has one accepted slot, three missing slots, and
unavailable funding/open interest/mark price. The universe's full-coverage, minimum-liquidity
rule selects BTC (turnover 4,000) and ETH (2,800); OLD is delisted, NEW lacks full lookback,
and SOL lacks coverage. These are fixture quality diagnostics, not performance results.

## Read-only API and downstream interface

`SnapshotMarketData` implements `MarketData` with `schemaVersion: market-data.v1` for
Modules 06/07/08. Constructor data is copied, validated, source/identity checked and frozen.
`datasetHash` is independent of collection input order. Queries and outputs are strict Zod
boundaries. Input order is retained in the artifact, so differently ordered original inputs
may have different artifact hashes even when their normalized dataset hash agrees.

The optional loopback HTTP service exposes JSON POST reads (no persistence side effects):

| Route              | Request schema                | Interface method |
| ------------------ | ----------------------------- | ---------------- |
| `/market/query`    | `market-data-query.v1`        | `query`          |
| `/market/history`  | `market-history-query.v1`     | `history`        |
| `/market/resolve`  | `market-resolve-query.v1`     | `resolve`        |
| `/market/universe` | `market-universe-query.v1`    | `universe`       |
| `/market/quality`  | `market-quality-query.v1`     | `quality`        |
| `/market/compare`  | `market-cross-venue-query.v1` | `compare`        |

For example, after starting `serve-fixture`:

```powershell
$body = @'
{
  "schemaVersion": "market-data-query.v1",
  "sourceId": "synthetic:alpha",
  "instrumentKey": "alpha:SPOT:BTC",
  "mode": "ELIGIBLE",
  "decisionAt": "2026-01-01T00:04:03Z",
  "from": "2026-01-01T00:00:00Z",
  "to": "2026-01-01T00:04:00Z",
  "intervalSeconds": 60
}
'@
Invoke-RestMethod http://127.0.0.1:3001/market/query -Method Post -ContentType application/json -Body $body
```

Invalid inputs return a static error without reflecting raw values. Request IDs are generated;
responses use `Cache-Control: no-store`. Request bodies are capped at 16 KiB. Each query
has at most 2,000 whole grid slots, interval 1 second–1 day, and explicit cutoff. Catalogs
are bounded to 20 sources, 1,000 metadata revisions and 10,000 observations. Report queries
are bounded to 20 quality, 10 comparison and 20 history requests sharing a cutoff/grid.
The library accepts supplied versioned datasets; the CLI service intentionally loads fixtures.

## Integrity, checks and limits

`market-quality-artifact.v1` retains the normalized input dataset, query configuration,
source policy/references, software version, hashes and complete derived report. Publication
uses a private file and atomic hard-link creation without replacing existing output. Reuse
verifies inputs/results; verification recomputes all results and rejects corruption. Files
are bounded to 16 MiB. Hashes detect changes; they do not authenticate providers or prevent
the owner from creating another dataset. No SQL migration or old strict schema changed.

Actual checks on 2026-10-31: `pnpm check` passed **135 offline tests** (36 new tests),
lint/format/typecheck/smoke/contract demo; `pnpm run doctor` passed; **20 actual PostgreSQL
18.4 regression tests** passed. A real loopback HTTP request returned the versioned universe
and BTC/ETH selection. The isolated project database cluster and HTTP listener were stopped;
the existing Windows PostgreSQL service was untouched. All 17 roadmap hashes verified.

The module handoff reran fixture import (9 bars, 7 quarantined), synthetic recording/replay
(12 observations, same chain head), quality capture and artifact recomputation. Saved stream:
`data/market-streams/market-stream-recording_211c9727af70e54ed5cc2c1040ad098ad08c98dd508a0de7ab88f3d781cba855/`.
Import snapshot:
`data/market/market-snapshot_21029ae0fefc9b290a262d9ca7648e8f804d51208c03d4561915801e1c992825/`.

Existing archive source policy/coverage is in `docs/market-import.md`; public stream hosts,
limits and provider/terms links are in `docs/market-streams.md` (reviewed 2026-10-30).
This iteration makes no new provider requests. Supplied actual datasets need authorized
metadata history and defensible availability; today's exchange listing page cannot establish
a historical listing universe. Live cross-venue collection, automatic bar/depth aggregation,
catalog SQL indexing, paginated large datasets and dashboards remain future integration.
No derivative network feed, strategies, risk engine, broker or financial results exist.

Next is Module 04, Iteration 1: news provider registry and fixtures. Module 04 is not started.
