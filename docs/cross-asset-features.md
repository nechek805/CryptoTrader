# Cross-asset features and deterministic regimes

Module 07, Iteration 2 builds on the existing point-in-time metadata/universe service and
frozen OHLCV evidence. It adds BTC-relative returns, rolling and lagged correlations,
breadth, turnover concentration and independent trend/volatility regime flags. Funding
and open interest remain optional, individually timed inputs. Nothing produces an order,
tradable signal, causal claim or training panel.

## CLI and reproducibility

Use pinned Node 24.22.2 / pnpm 10.34.9 as described in the README:

```powershell
pnpm features cross-fixture
pnpm features cross-catalog
pnpm features cross-verify --artifact 'data/cross-features/cross-features_<printed hash>.json'
pnpm features cross-report --artifact 'data/cross-features/cross-features_<printed hash>.json'
```

The fixture is entirely synthetic: source, listings, candles, quote-turnover/book metrics
and derivative values. The report is Markdown; the catalog and immutable artifact are
machine-readable JSON. The artifact contains all inputs, original source references and
market manifests, request/config/software hashes, seed zero, UTC clock semantics, catalog
and audited rows. Publication syncs a staging file and uses an atomic no-replace link;
verification rebuilds universe selection, joins, statistics, regimes and watermarks.

Replay or change a request against the same frozen evidence:

```powershell
$cross = Get-Content 'data/cross-features/cross-features_<hash>.json' -Raw | ConvertFrom-Json
$cross.request | ConvertTo-Json -Depth 30 | Set-Content 'data/cross-features/request.json' -Encoding utf8
pnpm features cross-run --artifact 'data/cross-features/cross-features_<hash>.json' --request 'data/cross-features/request.json'
```

For explicitly prepared local inputs, export/edit `input` and run
`pnpm features cross-build --input input.json --request request.json`. Dataset structure
is `cross-feature-dataset.v1`: `technical` is the existing technical-feature dataset,
`market` is a strict point-in-time market dataset, `bindings` explicitly map source and
instrument keys to OHLCV series, and `derivatives` is an optional list. All profiles,
metadata and observations are semantically validated. Imported evidence remains an
operator/source assertion rather than cryptographic proof of historical availability.
Do not backdate captures or omit provenance when preparing real inputs.

Input/artifact files are limited to 64 MiB; request files to 16 KiB. The batch has at most
64 cutoffs, ten explicit targets, twenty selected universe members, a 3–100-bar lookback,
eleven requested signed lags and a bounded 250,000 estimated slot/pair workload. No
provider is contacted. Existing single-series study/feature formats, APIs and SQL schemas
remain unchanged. For redirected JSON/Markdown without pnpm's banner, invoke
`node --import tsx apps/cli/src/features.ts ...`.

## Request and joins

`packages/contracts/src/cross-features.ts` defines the public Zod contracts;
`SnapshotCrossFeatures.evaluate` is the reusable TypeScript entry point. The fixture's
request is a complete editable example. Its main fields are:

| Field                                                                  | Policy                                                                                                 |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `sourceId`, `quoteAssetId`, `marketType`                               | Source/quote and market type for the dynamic universe; targets have explicit spot/perpetual bindings   |
| `targets`, `btcInstrumentKey`                                          | Explicit requested instrument keys and BTC reference; no symbol or venue replacement                   |
| `historyStartCloseAt`, `intervalSeconds`, `featureAsOf`, `generatedAt` | Declared fixed UTC grid, one shared cutoff per row, and generation after every cutoff                  |
| `lookbackBars`, `returnHorizonBars`, `minimumPairs`                    | Rolling window, cumulative-return horizon and observed correlation sample minimum (at least three)     |
| `lagBars`                                                              | Signed -10 to +10 intervals; zero-lag correlation is always included                                   |
| `joinToleranceMs`                                                      | 0–30,000 ms and strictly shorter than one interval; backward-only tolerance, never a forward allowance |
| `universe`                                                             | Existing point-in-time quote-volume/book-liquidity/coverage/age/drift thresholds, count and lookback   |
| `regime`                                                               | Explicit trend-efficiency and log-volatility thresholds                                                |
| `derivativeMaxAgeSeconds`                                              | Maximum age of an individually timed derivative measurement                                            |

The anchor is the last grid close at or before the row's feature-as-of instant. Every
instrument uses that **same cutoff**. A source close can join a nominal grid close only
if `nominal - tolerance <= actualClose <= nominal` and it was available by the row cutoff.
Even if a slightly later source candle is already known when computation runs, it cannot
be forward-matched onto an earlier nominal slot. Within each actual close choose the
latest eligible known revision; quality-invalid versions do not revive older prices.
Multiple known closes in one tolerance slot are ambiguous and do not supply a value.

Actual neighboring source closes must remain exactly one interval apart. Tolerance does
not permit interpolation or stitching over a missing candle. Close/open times, original
availability and metadata identities remain in each slot. A missing BTC input leaves
relative returns null; an asset's own return and regime can still be available. A price
or feature arriving after ETH's cutoff cannot silently enter ETH's BTC reference.

Historical metadata must be eligible and actually known by the cutoff. Each source bar
must lie inside its known listing lifetime, match venue/symbol/market type, honor price
and volume precision, and have a stable mapping over its full interval. Ambiguous
provider mappings are rejected. Explicit bindings are not proof of a historical listing;
missing metadata stays `NO_KNOWN_LISTING`. Delistings, name/mapping mismatches, gaps and
insufficient post-listing history remain visible rather than borrowing today's records.

## Numerical features and regimes

All prices and statistics use private 256-digit decimal arithmetic with half-even
rounding to 36 fractional digits. No binary floating-point price arithmetic, fills,
cost assumptions or annualization are introduced.

- Gross return is `endClose / startClose - 1` on a complete contiguous H-bar path.
  BTC-relative return subtracts BTC's gross return over the same nominal window. It is
  a signed return difference, not a beta or causal adjustment.
- Rolling correlation is Pearson correlation of matched adjacent one-bar simple returns.
  It requires at least `minimumPairs` and nonzero variance. Missing intervals remove
  their affected returns, not just the absent endpoint, and never become longer returns.
  Actual pair count, expected count and full/partial coverage are explicit. A partially
  observed coefficient can be computed when enough valid pairs remain; its coverage
  does not become complete. A constant series has null correlation, not zero.
- For signed lag `k`, pair BTC return ending at nominal `u` with asset return ending at
  `u + k*interval`. Positive means BTC leads, negative means asset leads, zero means a
  contemporaneous nominal grid. Pairs remain inside the historical lookback and preserve
  both actual close times, four source IDs and a price/mapping input-availability bound.
  This is a historical feature known at the current cutoff, not a forecast available at
  the earlier point in the pair. Correlation/lead-lag is not causality.
- Trend efficiency is `abs(lastClose-firstClose) / sum(abs(adjacent price changes))`.
  A flat complete path has efficiency zero and is ranging. A nonconstant path is trending
  when efficiency meets the configured threshold; direction separately reports UP,
  DOWN or FLAT. Missing paths produce UNKNOWN, not a ranging default.
- High volatility independently compares population standard deviation of log returns
  with its declared threshold. A jump and reversal can be ranging and high-volatility;
  a large directional move can be trending and high-volatility. Flags are deterministic
  descriptive thresholds, not a trained classifier or an assertion of future regimes.

## Universe, breadth and concentration

Universe selection reuses `SnapshotMarketData.universe`: eligible historical listings,
provider quote turnover, actual book-liquidity observations, minimum coverage, freshness,
precision/mapping and timestamp-drift checks. The ranking is quote volume descending,
then liquidity descending, then instrument key. The complete selection request and
every exclusion are retained. Higher-volume future listings cannot appear before their
metadata becomes knowable. Candle base volume never substitutes for missing book depth
or quote turnover. There is no current-top-assets/survivor fallback.

The fallback is an explicitly empty or partially measurable current universe. Explicit
targets can still have their own features when they are not selected, but do not enter
breadth as static replacements. Breadth advance/decline fractions use only selected
members with complete returns, with selected and measured counts and coverage fraction
shown separately. No measurable members means null fractions; a genuine unchanged
member contributes a measured zero move. Empty selection is not a zero-advance market.

Concentration is largest share and Herfindahl of available quote turnover in the selected
universe. It is an exchange-turnover proxy, not market-cap concentration, risk or portfolio
diversification. A zero turnover total or empty selection has null shares/HHI. Ranking-
excluded candidate observations are included in the input audit too, because their known
data affected which members were selected.

## Optional derivative inputs and provenance

Funding/open-interest values are never taken from OHLCV or assumed present on every
provider. Even inline book-payload derivative values do not replace separate timing
evidence. A `derivative-feature-observation.v1` records metric, source/instrument,
measurement, publication, receipt, availability, eligibility and provenance. The order
must satisfy `measurement <= publication <= observed <= available`; open interest is
nonnegative. At a cutoff, choose the latest known eligible measurement, respecting
perpetual metadata support, listing time and explicit maximum age.

Spot fields are NOT_APPLICABLE; absent/unpublished or unsupported perpetual inputs are
UNAVAILABLE. Stale fields retain their known IDs/timestamps for audit but have null
values. No funding accrual, open-interest forecast or mark-price inference is produced.

Each row records all joined bars, mapping metadata, selected/ranking-excluded market
metrics and derivative evidence IDs, source/capture parents and maximum input event and
availability times. Contracts reject forward joins or inputs beyond the common cutoff.
These are input knowability bounds, not proof the offline feature was published then;
actual computation/distribution latency is not modeled. Raw snapshot hashes and coverage
diagnostics remain audit metadata, not automatically approved predictor columns.

## Acceptance fixture and next boundary

The synthetic case has BTC, steadily rising ETH, oscillating/jumping SOL, a late-known
NEW listing and a BTC perpetual with separately timed fields. At 00:05 the BTC candle
arrives fifteen seconds late: ETH's four-bar return is 0.08 while BTC-relative return
is missing. At 00:05:30 BTC is known, returns zero over that window and ETH-relative
return is 0.08. Correlations preserve their actual observed pair coverage.

NEW's listing metadata is unavailable before 00:06 despite stored older prices. After
metadata arrives, pre-listing candles are still excluded and sufficient post-listing
history is required. Later it can join the quote-volume-ranked universe; it does not
appear retroactively. The jump/reversal case is ranging with high volatility, while
the monotonic ETH path is trending. Missing BTC, unknown liquidity, constant series,
future corrections and unpublished open interest retain explicit missing states.

Tests additionally check exact backward tolerance, one-nanosecond availability, both
lag directions, metadata ambiguity/precision, complete/partial breadth, source/field
watermarks, immutable artifacts and the previous technical-feature artifact's exact
identity. Iteration 2 stops here. Next is Module 07, Iteration 3: reproducible datasets,
time splits, purge/embargo, leakage audits and stable panel exports.
