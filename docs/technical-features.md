# Deterministic technical features

Module 07, Iteration 1 adds a point-in-time OHLCV feature engine and versioned catalog.
It produces market measurements, missingness reasons and source/timing audits. It does
not produce signals, execution, cross-asset regimes or training panels.

## Local workflow

Use pinned Node 24.22.2 and pnpm 10.34.9 as described in the README:

```powershell
pnpm features fixture
pnpm features catalog
pnpm features verify --artifact 'data/technical-features/technical-features_<printed hash>.json'
pnpm features report --artifact 'data/technical-features/technical-features_<printed hash>.json'
```

The fixture is explicitly synthetic. The artifact contains its input bars, config,
queries, formula catalog, outputs, source provenance and availability audits. `catalog`
prints the fixture config's definitions; use `catalog --config config.json` for another
validated config. `report` verifies the artifact and prints Markdown.

For existing local evidence, import/verify a market snapshot first, then:

```powershell
pnpm features run --snapshot 'data/market/<snapshot directory>' --request 'feature-request.json'
```

This verifies the original market manifest and Parquet data before reading bars and
preserving its source manifests. No provider is contacted. A verified feature artifact
can also supply frozen evidence for another request:

```powershell
$features = Get-Content 'data/technical-features/technical-features_<hash>.json' -Raw | ConvertFrom-Json
$features.request | ConvertTo-Json -Depth 30 | Set-Content 'data/technical-features/request.json' -Encoding utf8
pnpm features run --artifact 'data/technical-features/technical-features_<hash>.json' --request 'data/technical-features/request.json'
```

Choose exactly one source (`--snapshot` or `--artifact`); `--out` optionally changes the
output directory. For clean redirected catalog/report output, invoke
`node --import tsx apps/cli/src/features.ts ...` to omit pnpm's banner.

## Public contracts and timing

`TechnicalFeatureDatasetSchema`, `TechnicalFeatureQuerySchema` and the batch request
schema are defined in `packages/contracts/src/technical-features.ts`.
`SnapshotTechnicalFeatures.query` is the reusable TypeScript interface. A batch request
has this shape (replace the source identity and timestamps with your evidence):

```json
{
  "schemaVersion": "technical-feature-request.v1",
  "series": {
    "asset": "BTC",
    "exchange": "synthetic:features",
    "instrumentId": "BTC/USDT",
    "marketType": "SPOT"
  },
  "intervalSeconds": 60,
  "historyStartCloseAt": "2026-01-01T00:01:00Z",
  "featureAsOf": ["2026-01-01T00:04:00Z", "2026-01-01T00:04:30Z"],
  "generatedAt": "2026-01-01T00:11:00Z",
  "config": {
    "schemaVersion": "technical-feature-config.v1",
    "smaPeriod": 3,
    "emaPeriod": 3,
    "volatilityPeriod": 3,
    "atrPeriod": 3,
    "relativeVolumePeriod": 3,
    "zScorePeriod": 3,
    "breakoutPeriod": 3,
    "returnHorizonsBars": [1, 2, 5],
    "minimumBaseVolume": "5",
    "lowRelativeVolumeThreshold": "0.25",
    "candleGapThresholdBps": 100,
    "staleAfterSeconds": 120
  }
}
```

The single-query contract uses `technical-feature-query.v1` and one scalar
`featureAsOf`, with the same common fields and no `generatedAt`. Each period is 1–500
bars; up to twenty distinct return horizons are 1–1000 bars. A batch has 1–128 distinct
as-of instants and at most 250,000 inspected close slots. Each query spans at most 10,000
slots; interval is a fixed 1–86,400 seconds. Input contains at most 200,000 bars; request
files are at most 16 KiB and immutable artifacts at most 64 MiB.

`historyStartCloseAt` is the first expected exclusive close and fixes the grid phase and
recursive seed origin. For as-of `T`, the anchor is the greatest grid close `<= T`.
There is no partial current candle, implicit source substitution, resampling, calendar
inference or fallback onto an older current close. A missing anchor bar is explicit.
The caller declares history and instruments; historical listing/universe selection is
not inferred in this iteration. Fixed intervals use continuous UTC, including nanoseconds.

At each evaluation, every selected bar must satisfy **closeAt <= featureAsOf** and
**availableAt <= featureAsOf**, with `ELIGIBLE` observed/archived availability. This allows
a delayed old bar to become usable once it is actually received. It differs from the
event study's more restrictive own-close measurement rule: a feature evaluated later
may use all relevant history then known. Evaluations at earlier as-of instants remain
unchanged in value and input IDs when late data or corrections are added.

For each close, select the latest eligible revision known by that cutoff. If it carries
MISSING, GAP, STALE, UNCERTAIN_TIMESTAMP or CONFLICTING_EVIDENCE, the slot is unavailable;
the engine does not fall back to an older price invalidated by that revision. Duplicate
IDs and ambiguous versions at the same close/availability instant are rejected.
Descriptive/estimated/unknown-availability records cannot supply a feature price.
Public archives without defensible historical availability can therefore yield all
missing values; capture times must never be relabelled as earlier receipt times.

## Catalog and numerical definitions

The catalog records formula, version, price/volume inputs, required initial warm-up,
fixed-window versus recursive history, variable availability lag and NaN policy.
Definitions are parameterized by the recorded config and version
`technical-features.v1`. Decimal fractions are used for returns, gaps and volatility.

| Feature                 | Formula and convention                                                                                                             |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| SMA(N)                  | Mean of the last N closes, including the closed anchor                                                                             |
| EMA(N)                  | Alpha = 2/(N+1); seed with SMA of the first N consecutive closes from declared history, then alpha*close + (1-alpha)*previousEMA   |
| Return(H)               | anchor.close / close[anchor-H bars] - 1, requiring all H+1 consecutive closes                                                      |
| Rolling volatility(N)   | Population standard deviation of N adjacent log returns; N+1 closes; unannualized                                                  |
| ATR(N)                  | TR = max(high-low, abs(high-previousClose), abs(low-previousClose)); initial mean of N TRs, then Wilder ((N-1)*previousATR + TR)/N |
| Relative volume(N)      | Current base volume / mean of the previous N base volumes, excluding anchor                                                        |
| Z-score(N)              | (anchor.close - mean(previous N closes)) / populationStd(previous N closes), excluding anchor from the reference                   |
| Breakout upper/lower(N) | Maximum high / minimum low of the previous N bars, excluding the closed anchor                                                     |
| Candle gap              | anchor.open / previous.close - 1; missing candle slots are reported separately                                                     |

ATR requires an actual preceding close: its first valid result needs N+1 bars. No first
TR is fabricated from high-low alone. EMA and ATR reset after missing/invalid slots and
restart their seed on the subsequent consecutive segment. Their audit lists all bars
in that segment because recursive state depends on the seed and updates. Freezing the
declared history start matters; changing it intentionally changes the seed definition.

Warm-up returns null with `WARMUP`. Interrupted paths return `GAP`; an unavailable
anchor returns `MISSING_CURRENT_BAR` for features needing it. Zero prior volume and
constant prior closes produce `ZERO_DENOMINATOR` and `ZERO_VARIANCE`, respectively.
No NaN, infinity, zero imputation or forward-fill is emitted. Genuine flat returns,
zero gaps and zero relative volume can be READY zero values.

Prior-only breakout levels may be READY even when the anchor price is unavailable;
their input IDs exclude that candle. They describe reference levels for the declared
closed anchor, not levels computed from an unfinished candle. Catalog warm-up for these
bands counts N+1 initial grid closes; the actual numeric input window has N prior bars.

Private 256-digit decimal arithmetic includes log/sqrt and half-even rounding to at
most 36 fractional digits. Prices never pass through binary floating-point arithmetic.
Results outside the existing 80-digit decimal contract fail closed. These are gross
market measurements without fees, slippage, annualization, fills or PnL assumptions.

## Provenance, coverage and liquidity limits

Each value records status, observed/required bars, exact input IDs, maximum input close
and maximum input availability. Each row records their union, source IDs, source versions,
parent capture IDs, dataset/config hashes, the query, anchor, current bar identity,
expected/available history counts, missing closes and excluded-version reasons. The
contracts reject a non-null value without adequate audited inputs or an input watermark
after the feature cutoff. Replaying all semantics verifies the hashes and catalog too.

The maximum input availability is an **input knowability bound**, not a claim that this
offline feature was computed or published at that historical instant. Actual ingestion,
computation and downstream publication latency are not modeled here. The source-coverage
and excluded-version diagnostics are audit metadata, not additional predictor columns;
a later snapshot can contain later evidence IDs even when historical values stay fixed.

Liquidity flags are explicitly `CANDLE_PROXY_ONLY_ORDER_BOOK_UNAVAILABLE`. They report
zero/low base volume, low relative volume, missing candles/current data, stale last-known
close and a configurable opening-price gap. Volume thresholds are in the selected
instrument's base units; they are not comparable market depth across assets. Missing
coverage is scoped to the complete declared history. Bid/ask spread, order-book depth,
executable size and funding are not inferred from OHLCV. `ORDER_BOOK_UNAVAILABLE` remains
visible even when every indicator is READY.

Artifacts preserve source manifests and original bar provenance, input/request hashes,
software version, UTC clock semantics and seed zero. Publication syncs a staging file
and uses atomic no-replace linking; verification rebuilds every row and checks the exact
content-addressed name. Old feature files and earlier news/study artifacts are unchanged.
No database migration, new dependency or network request is needed for these commands.

## Acceptance fixture and handoff

The synthetic closes start 10, 11, 12, 13 and volumes 10, 20, 30, 40. With period three,
the fourth close yields SMA 12, EMA 12, ATR 3, relative volume 2, z-score sqrt(6), and
prior breakout bands 13 / 9. The candle closes at 00:04 but arrives at 00:04:30. At 00:04
the current-price features are missing; at 00:04:30 they become ready. Subsequent zero
volume and a late old-candle correction exercise liquidity and revision audits.

Tests use hand-calculated SMA/EMA/Wilder recurrences, independent standard-library log
variance calculations, the closed-form volatility ln(2), fractional-price fixtures and
randomized future-price invariance. No external indicator package is assumed to share
these seed/window conventions. Failure tests cover gaps, stale/estimated data, one-nanosecond
availability, invalid revisions, zero denominators/variance, artifact/catalog tampering,
configuration limits and all input watermarks.

Iteration 1 stops with this catalog, reproducible outputs and source-coverage audit.
Next is Module 07, Iteration 2: cross-asset features and regimes. Training sample manifests,
purge/embargo, leakage audits and stable panel/Parquet exports remain Iteration 3.
