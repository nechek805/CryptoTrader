# Public market streams and replay

Module 03, Iteration 2 provides finite read-only capture and verified offline replay.
The default feed is explicitly synthetic. Real data requires `--provider binance-public`.
One SPOT instrument per capture is supported: BTCUSDT, ETHUSDT or SOLUSDT. Execution
remains `DISABLED`. Data-quality gates do not establish a fill model or venue tradability.

## Commands

Use the pinned runtime/PATH described in the root README.

```powershell
pnpm market stream
pnpm market stream --provider binance-public --symbol BTCUSDT --duration-ms 8000
pnpm market replay --recording 'C:\absolute\path\to\market-stream-recording_<hash>'
```

Capture prints its directory, hashes, faults and number of usable observations. `--out`
overrides `data/market-streams`. The synthetic script has 12 fixed observations and uses
BTCUSDT; it rejects duration overrides. Live duration defaults to 5,000 ms, bounded to
100–60,000 ms. No collector remains running. Credential/arbitrary-URL flags fail without
echoing values. A successful recording can contain zero usable quotes; inspect states/faults.
The existing API/doctor still report fixture operational readiness only.

## Interfaces and temporal gates

`MarketStream` separates transport from the managed runner and reducer. `open` emits
normalized receipts; `clock` and `snapshot` return REST inputs. Other providers must map
their documented sequencing semantics into the versioned contracts; interface conformance
alone does not establish provider compatibility.

`market-stream-config.v1`, `market-stream-step.v1`, `market-stream-view.v1`,
`market-stream-record.v1` and `market-stream-recording.v1` are strict Zod boundaries.
Provider `occurredAt` remains distinct from local `observedAt`. The step's `processedAt`
controls view `availableAt`; recovery never backdates availability to a buffered receipt.
Times use canonical UTC nanoseconds. The provider profile explicitly uses millisecond
epochs. JSON integer tokens are preserved before rounding; sequences use bigint and
prices/quantities use decimal strings.

The reducer buffers WebSocket inputs during REST recovery. It discards updates already
covered by the snapshot, then requires a range containing the next expected sequence ID.
A gap immediately disables usability and requests a new snapshot. Later reordered packets
cannot repair a gap alone. Duplicates and timer heartbeats cannot refresh market-data
freshness. Disconnects invalidate readiness; late responses from old connections cannot
restore it. Receipt/processing clock regression fails closed.

Clock offset is server time minus the request midpoint. Uncertainty includes half the RTT
plus one millisecond of quantization. RTT over 1,000 ms or absolute offset over 5,000 ms
rejects a sample. Valid samples expire after 30 seconds by default. Rejected samples retry
after one second under the same request budget; accepted samples normally refresh after
ten seconds. Offset changes freshness comparisons only, preserving original timestamps.
This is a bounded estimate, not synchronized-clock proof.

Views become unusable when local receipt or clock-adjusted provider data exceed the default
2,000 ms freshness window, when provider times are implausibly future, or the clock is
unreliable. `isStreamUsableAt(view, decisionAt)` checks `availableAt` and `validUntil`, so a
saved READY object cannot remain usable after expiry without another tick. Thresholds are
recorded in config.

`quality: ORDER_BOOK` identifies reconstructed depth; `CANDLE_ONLY` never passes the helper.
This adapter emits depth rather than trades/candles. Views expose the best five known levels
and `depthLimited: true`. The initial snapshot has only 100 levels per side. A best quote
beyond the initial known price boundary, empty/crossed book, duplicate numeric price or
capacity breach requires recovery. These gates do not imply guaranteed simulated fills.

## Bounds and provider policy

Only these fixed unauthenticated market-data endpoints are used:

- `wss://data-stream.binance.vision/ws/<symbol>@depth@100ms`
- `https://data-api.binance.vision/api/v3/time`
- `https://data-api.binance.vision/api/v3/depth?symbol=<symbol>&limit=100`

REST is GET only, omits credentials, refuses redirects and times out after three seconds.
WebSocket opening also times out after three seconds. Native Node WebSocket handles
protocol control frames. The application independently checks market-packet silence:
five seconds by default records `HEARTBEAT_TIMEOUT`, invalidates and reconnects. A quiet
market can conservatively trigger this gate.

Provider REST weights are 1 for time and 5 for a 100-level depth snapshot. The runner allows
12 total REST requests/session, at least 250 ms apart, and 100 weight/minute. Initial
connection plus at most three reconnects use 250/500/1,000 ms backoff. Subscription is in
the URL. Provider limits include five incoming control messages/second and 24-hour connection
lifetime; this runner lasts at most one minute.

429 responses honor numeric or HTTP-date `Retry-After`, using 60 seconds when absent/invalid.
Cooldown is never shortened to fit capture. Values over one day halt. Other 4xx restrictions
(including bans/regional denial) and redirects halt; no proxy or alternate-host bypass exists.
Network/5xx errors use bounded reconnects. Malformed input halts. Rejected clock measurements
stay unusable while retried.

Frames/REST bodies: 256 KiB; callback FIFO: 512 inputs; recovery buffer: 256 deltas; retained
book: 1,000 levels/side. FIFO overflow preserves queued receipts and records a terminal loss
fault: that capture is incomplete as market evidence. Already received packets drain before a
normal stop, in receipt order. Packets after cutoff are not admitted. Tests/replay use no network.

Protocol/limits were checked on 2026-10-30 against official
[market-data-only endpoints](https://github.com/binance/binance-spot-api-docs/blob/master/faqs/market_data_only.md),
[WebSocket streams](https://github.com/binance/binance-spot-api-docs/blob/master/web-socket-streams.md),
and [REST documentation](https://github.com/binance/binance-spot-api-docs/blob/master/rest-api.md).
Public access does not establish redistribution/commercial rights. Real recordings retain
[provider terms](https://www.binance.com/en/terms), source endpoints and `license: UNDETERMINED`;
synthetic records use `SYNTHETIC`. Provider bytes remain in ignored local `data/`.

## Recording integrity and compatibility

Canonical JSONL retains normalized inputs, raw text/hash, receipt/processing times, derived
views, index and previous-record hash. The manifest pins config, source profile, software,
reducer/clock semantics, byte hash, count and chain head. There is no randomness, signal,
fee model or financial run in this slice.

Capture is bounded to 5,000 observations/64 MiB, with a final STOPPED input. A private stage
is verified before atomic content-addressed publication. Identical capture/config/software
reuses verified output; conflicting bytes are refused. Files are not OS write-protected:
hashes detect changes, while the owner can deliberately forge another chain. These are
integrity checks, not provider signatures. Interrupted/over-limit captures fail without
publishing a successful artifact.

Replay validates bounded files/schemas, metadata/config/raw/record hashes, chain/order/count
and recomputes every view from recorded receipt/processing times. It never reorders or fetches
current data. A changed reducer needs compatible semantics or a new version; mismatched views
fail replay. Recordings are standalone evidence; SQL registration/API integration are deferred.
Existing strict `research-run.v1`, offline snapshots and migration checksums are unchanged.

## Actual verification

Pinned Node 24.22.2/pnpm 10.34.9 passed `pnpm check`: 99 offline tests, including 29 stream
tests; `pnpm run doctor`; and 20 actual PostgreSQL regression tests. The project database
cluster was stopped afterward; the separate Windows service was untouched. All 17 original
roadmap checksums verified.

The first actual eight-second BTC capture delivered 67 depth updates plus a snapshot; its
1.111-second clock RTT correctly kept all quotes unusable. After adding rejected-clock
remeasurement, a second actual eight-second capture yielded **110 observations, 80 usable
views, zero faults**, ending STOPPED. It is retained at
`data/market-streams/market-stream-recording_f772974d9fa7adc4b599e34ed59fc41ee59172ce0ada5a675b51323e6c35c108/`.
Historical recording software hashes remain unchanged when newer code changes the current
working-tree hash. ETH/SOL live captures, long sessions and remote CI were not run locally.

The public recording replayed with the final reducer: 110 observations and chain head
`sha256:d9edf39fe5d73f09e81dac08936b604ae905a9639856697a8012b469af7aca7a`.
The final synthetic CLI capture has 12 observations (three usable) and metadata hash
`sha256:412630f4e2a7912188c0636de4be9b084046f1856b1e70adbfab8c08f8948339`.

Module 03, Iteration 3 is now implemented; see `docs/market-quality.md` for the current
universe/metadata/quality interface and handoff. This page retains the Iteration 2 evidence.
