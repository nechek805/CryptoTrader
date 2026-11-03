# Reproducible descriptive event studies

Module 06, Iteration 1. Run with pinned Node 24.22.2 / pnpm 10.34.9 and installed
dependencies. All commands are local and execution remains disabled.

```powershell
pnpm study fixture
pnpm study verify --artifact 'data/event-studies/event-study_<printed hash>.json'
pnpm study report --artifact 'data/event-studies/event-study_<printed hash>.json'
pnpm study serve --artifact 'data/event-studies/event-study_<printed hash>.json' --port 3010
```

`fixture` creates a self-contained, immutable JSON artifact and prints its absolute path.
`report` verifies it before printing a notebook-style Markdown table. `serve` explicitly
starts the separate loopback API over that artifact's frozen evidence. POST a strict
`event-study-request.v1` to `/research/event-study`; it accepts requests up to 16 KiB,
never evidence uploads. The existing fixture health server is unchanged. API responses
use `cache-control: no-store`, generated request IDs and sanitized errors.

For existing local evidence, first create the news and market snapshots with their
documented commands, then:

```powershell
pnpm study run --news-snapshot 'data/news-event-snapshots/news-event_<hash>.json' --market-snapshot 'data/market/<snapshot directory>' --request 'study-request.json' --out 'data/event-studies'
```

Both snapshots are verified before importing their evidence; market input comes from
the verified Parquet bars. No provider is contacted. Source IDs, versions, capture
timestamps, bar capture parent IDs, original market snapshot manifests with source URIs
and file/member hashes, and all bar quality flags
remain embedded in the study input. The artifact hashes the entire input and request,
records the working-tree software hash, algorithm version, nanosecond clock semantics,
and seed zero. Verification rebuilds both news semantics and all study results, then
checks the full content hash and filename. Files are bounded to 64 MiB, UTF-8, and
published with a synced staging file and atomic hard link that refuses replacement.
Reports use file artifacts; no database migration or new PostgreSQL projection is needed.

Example request (replace event ID, instrument names, source and timestamps with those
actually present in your evidence; this is a schema illustration):

```json
{
  "schemaVersion": "event-study-request.v1",
  "events": [{ "eventId": "event:example", "decisionAt": "2026-01-01T09:21:00Z" }],
  "assets": [
    {
      "asset": "BTC",
      "exchange": "synthetic:event-study",
      "instrumentId": "BTC/USDT",
      "marketType": "SPOT"
    },
    {
      "asset": "ETH",
      "exchange": "synthetic:event-study",
      "instrumentId": "ETH/USDT",
      "marketType": "SPOT"
    },
    {
      "asset": "SOL",
      "exchange": "synthetic:event-study",
      "instrumentId": "SOL/USDT",
      "marketType": "SPOT"
    }
  ],
  "benchmark": {
    "asset": "BTC",
    "exchange": "synthetic:event-study",
    "instrumentId": "BTC/USDT",
    "marketType": "SPOT"
  },
  "intervalSeconds": 60,
  "analysisAsOf": "2026-01-08T09:21:00Z",
  "generatedAt": "2026-01-08T09:21:00Z",
  "roundTripCostBps": 10,
  "clock": "UTC_24_7_EXACT_CLOSE"
}
```

The explicit asset list is the configurable research universe (up to ten assets and
twenty event decisions). It does not select current survivors or infer event exposure
from future mappings. The caller must disclose any retrospective asset/event selection.
News context retains its own known-at direct/second-order/mention-only labels separately.
Intervals are 60, 300, 900 or 3600 seconds; shorter non-divisible horizons are flagged
`UNSUPPORTED_INTERVAL`. There is no automatic resampling, source substitution or backfill.

## Time and availability

- The event's declared `decisionAt` is the research anchor. The news snapshot is
  semantically replayed to that decision, and the requested event must be replay eligible
  with `availableAt <= decisionAt`. Unverified events remain in descriptive studies to
  avoid filtering only for subsequently confirmed stories. Published/event-occurrence
  time is never substituted for receipt or processing time. A caller choosing a later
  review decision is studying that later decision; the report does not call it first news.
- Trading clock is continuous UTC, 24/7, with exclusive bar closes and nanosecond
  timestamps. Entry requires a bar closing **exactly** at the event decision and already
  available at that instant. A nonaligned decision yields missing prices. There is no
  rounding onto a prior/next close and no implied executable fill at a bar close.
- Every subsequent or pre-event bar is evaluated at its **own close-time simulated
  decision**, also bounded by `analysisAsOf`. `ELIGIBLE` requires defensible observed or
  archived availability. Late receipts, later corrections, estimated/unknown availability,
  descriptive-only data, and MISSING/GAP/CONFLICTING_EVIDENCE/STALE/UNCERTAIN_TIMESTAMP flags
  cannot supply a price. A historical archive captured later will often be unusable under
  this strict rule; its capture time must never be relabelled as historical availability.
- Price source is exactly the requested exchange, instrument, market type and interval.
  Revisions have distinct IDs. Ambiguous versions at the same availability instant and
  duplicate IDs are rejected. Later versions do not rewrite earlier price decisions.
- Each window needs the start close and every consecutive bar through the target close.
  `expectedBars` counts interval bars after the start; start coverage is tracked separately.
  A missing start, endpoint or internal bar leaves all that window's metrics null, with
  observed counts, selected/excluded bar IDs and exact missing close timestamps. Future
  targets are `NOT_YET_OBSERVABLE`; otherwise incomplete data is `PARTIAL` or `MISSING`.
  Longer horizons are never extrapolated. An absent benchmark leaves adjusted return null
  while a complete asset window can retain its own metrics.

## Metrics and assumptions

Each event/asset has -24h and -1h windows ending at the event anchor, plus +1m, +5m,
+15m, +1h, +4h, +24h, +72h and +7d windows starting there. For each complete window:

| Metric                      | Definition                                                                                |
| --------------------------- | ----------------------------------------------------------------------------------------- |
| Gross signed return         | `endClose / startClose - 1`                                                               |
| Net return                  | Gross minus the explicit assumed round-trip cost in basis points divided by 10,000        |
| Absolute return             | Absolute magnitude of gross signed return                                                 |
| Benchmark adjusted          | Asset gross minus benchmark gross over the same window; simple subtraction, no beta model |
| Maximum adverse excursion   | Minimum of zero and `barLow / startClose - 1` after the starting close                    |
| Maximum favorable excursion | Maximum of zero and `barHigh / startClose - 1` after the starting close                   |
| Realized volatility         | Unannualized `sqrt(sum(log(close[i]/close[i-1])^2))`, including the starting close        |
| Maximum drawdown            | Maximum `1 - close / runningPeakClose`, including the starting close                      |

All returns are decimal fractions (`0.2` means 20%). Private 256-digit decimal arithmetic
includes log/sqrt; outputs are rounded to at most 36 fractional digits with half-even
rounding. No binary floating-point price conversions are used. Excursions use OHLC
extremes; drawdown uses closes because intrabar high/low order is unknown. These are
descriptive paths and explicit cost assumptions, without spreads, slippage, fills,
short-position semantics or a performance claim. Optional recovery timing is deferred
to Iteration 2 together with right-censoring.

## Synthetic acceptance scenario and handoff

The bundled fictional event is frozen at 09:21 UTC, before any later official statement.
The event's first rumor was received earlier; this is explicitly a selected research
decision rather than an inferred first-rumor timestamp. Three fictional spot instruments
have complete minute bars from -1h to +1h; the snapshot is evaluated through +7d so
longer windows demonstrate partial coverage rather than forecast prices.

ETH starts at 100 and closes 110, 90, 100, 110, 120 over the next five minutes, with
minimum low 85 and maximum high 125. The +5m gross/absolute/benchmark-adjusted return is
0.2, net with ten assumed basis points is 0.199, adverse excursion is -0.15 and favorable
excursion 0.25. Close drawdown is 2/11; realized volatility is approximately
0.277684365334535. BTC and SOL remain flat: **the event label has no price response for
two of three synthetic assets**; cost-adjusted net is -0.001 under the stated assumption.
This negative finding is neither statistical evidence nor a causal claim about real news.

Tests additionally cover complete hourly histories through +7d/-24h, negative returns and
fractional prices, one-nanosecond late availability, future observations and news context,
internal gaps, unavailable benchmark, nonaligned decisions, revisions, ambiguous IDs,
unknown fields, stale/estimated records, immutability, artifact tampering and API limits.

Iteration 1 stops here. Next is Module 06, Iteration 2: controls, BTC beta/factor and basket
adjustment, direction-safe lag analysis, right-censored recovery and concentration.
Hypothesis cards, validation-period policies and a machine-readable hypothesis registry
belong to Iteration 3 and are not implied by these descriptive results. Event labels do
not generate trading rules or orders.
