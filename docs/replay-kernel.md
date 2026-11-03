# Deterministic replay kernel

Module 08, Iteration 1. `@crypto/backtest` now provides causal event replay and a no-trade
control. Execution remains disabled. Fills, costs, accounts, orders, risk decisions,
portfolio ledgers and PnL are not implemented in this iteration.
The separate Iteration 2 spot simulator is documented in `docs/spot-execution.md`;
this original replay API and its artifacts retain their no-execution semantics.

## Run and reproduce

Use pinned Node 24.22.2 / pnpm 10.34.9 (README describes the Windows runtime).
All commands are offline and credential-free. The fixture contains fictional prices,
news, delayed arrivals and a historical correction; every fixture record is labelled
synthetic. It is not a provider capture or trading-performance demonstration.

```powershell
pnpm replay fixture --out data/replays
# Substitute the printed content-addressed file:
pnpm replay verify --artifact data/replays/replay_HASH.json
pnpm replay report --artifact data/replays/replay_HASH.json
pnpm replay reproduce --artifact data/replays/replay_HASH.json --out data/replays-copy
pnpm replay run --input replay-input.json --request replay-request.json --out data/replays
```

Run accepts strict `replay-input.v1` and `replay-request.v1` JSON. Input contains canonical
MarketBar and NewsDocument records with their original clocks, provenance, availability
classification and licensing metadata. No fetching, credentials, arbitrary strategy module
loading or execution flags are accepted. CLI uses the registered no-trade control only.
Reproduce uses the artifact's input/request and current software version; identical software
and inputs produce identical candidates, state, logs, snapshots and artifact bytes.

## Clock, schedule and visibility

The kernel reuses the existing monotonic `SyntheticClock` and Mulberry32 seeded random
generator. It never reads wall time for research decisions. Requests declare a half-open
decision period `[startAt,endAt)`, generated timestamp, explicit symbols, seed, snapshot
interval and query budget. Generation must be at/after the period end.

Eligible inputs are ordered by canonical nanosecond `availableAt`, then kind
(`MARKET_BAR` before `NEWS_DOCUMENT`), then original record ID using code-point comparison.
Input array order is normalized and does not influence input hash or tie order. Global
record IDs and per-source revision/availability identities must be unambiguous. Symbol,
venue, market type, interval and close distinguish price series. News revisions share
the explicit source/canonical URL and retain separate immutable document IDs.

Every event is admitted before its callback. At a timestamp tie, only the delivered
prefix is visible; later events at that same timestamp remain unavailable. The exact
logical cutoff therefore consists of both event time and sequence, not time alone.
Original candle close, news first-observed/publication and source availability remain
separate clocks. Historical corrections execute at their later availability and never
rewrite an earlier callback, state checkpoint or candidate.

Eligible observations before `startAt` are logged as WARMUP and admitted as query history;
they do not call the strategy or alter initial strategy state. Events at `endAt` or later,
descriptive/unknown-availability data and bars outside the declared cohort are explicitly
excluded. Warm-up inputs also count toward work limits. Initial clock is the earlier of
the first admitted event and decision start; final clock is the last actual event, not an
invented end-of-period observation. An empty schedule produces no candidates.

## Strategy and read-only query contract

```ts
import { executeReplay, createNoTradeControl } from '@crypto/backtest';
import type { Strategy, StrategyFactory, ReplayContext } from '@crypto/backtest';
const artifact = executeReplay(input, request, codeVersion, createNoTradeControl);
```

A `StrategyFactory` creates a fresh strategy for every run. `Strategy` declares a versioned
descriptor (ID, version, portfolio, JSON config), `initialState()` and synchronous
`onEvent(event, context, state)`. A callback returns `{state, candidates}` validated by
Zod. State is explicit, immutable JSON; functions, dates, bigint, unsafe numbers, async
outputs and serialized states over 16,384 characters fail. Event records, query results,
state, context properties and completed artifacts are frozen.

The context supplies only:

| Method/property                                             | Visibility                                                              |
| ----------------------------------------------------------- | ----------------------------------------------------------------------- |
| `clock.now()`, `cursor`                                     | Current event time and logical sequence; no clock mutation              |
| `random.next()`                                             | Seeded per-run random stream; draw counts retained                      |
| `bar({id,asOf})`                                            | Exact delivered bar revision actually available by the cutoff           |
| `bars({series,intervalSeconds,fromCloseAt,toCloseAt,asOf})` | Latest delivered eligible revision per close; explicit ordered window   |
| `newsById({id,asOf})`                                       | Exact delivered document revision                                       |
| `news({asOf,sourceId?})`                                    | Latest delivered eligible revision per source/canonical URL             |
| `features(technicalFeatureQuery)`                           | Existing Module 07 technical formulas over delivered eligible bars only |

Queries cannot access the complete input schedule, future rows, labels or training panels.
Future as-of times, future bar windows, undelivered IDs (including timestamp ties), invalid
query shapes and undeclared-symbol requests fail loudly. Causal/validation/budget errors
remain sticky: catching them inside a callback cannot make the run succeed. Query/clock/
random capabilities expire after each callback, preventing retained references from seeing
later arrivals. Past as-of queries remain limited to that callback's delivered prefix.

Each successful query logs its request hash, actual record IDs and maximum source event/
availability clocks. Features use the same formula/warm-up/quality policy as the existing
technical engine, with no future records even in coverage diagnostics or dataset hashes.
Raw bar queries retain known quality flags; a bad latest revision is not silently replaced
by an older clean one. Feature queries suppress invalid price inputs according to the
existing registry. Historical listing/universe/group selection, cross-feature adapters and
new semantic-news projections are not inferred from raw bars/documents by this kernel.

Strategies are trusted local TypeScript, not sandboxed programs. They must use the supplied
clock/random stream and explicit state; code can otherwise access external process/global
state. Publication and artifact verification rerun the supplied factory and reject different
results, but do not prove arbitrary code is pure or secure. Record the actual implementation
in codeVersion and change strategy versions/config when behavior changes. The CLI cannot
load untrusted code. Domain news content is data, never instructions or verified truth.

## Candidates, logs, manifests and snapshots

Callbacks return intent fields only (symbol, LONG/SHORT/HOLD, horizon, score/calibration and
rationale IDs). The kernel binds strategy/version/portfolio, decision time, inclusive
`dataCutoff`, expiry, deterministic ID and reproducibility metadata. Cutoff equals callback
time because the triggering event is itself known input; its exact prefix sequence is in
the event log. Historical queries may use earlier cutoffs. Rationale IDs must reference
the triggering record or source records actually read in that callback; historical state
does not silently authorize fabricated evidence. Intent clock/execution overrides fail.

Candidate metadata includes the complete input hash, request hash, code version, fixed seed,
clock/random algorithms and an explicit **unmodeled execution/cost assumption hash**, not a
zero-fee trading model. LONG/SHORT are recorded candidates only. The control emits HOLD on
market events; news events update state with no fabricated symbol mapping or trade intent.

The manifest records input/config/strategy/code identity, ordering version, generated time,
seed, exclusions, counts and hashes for event order, candidates, final state, logs and
snapshots. Every log entry records event identity/payload hash, phase, query evidence,
candidate IDs, state hash, random draw count and previous-entry/hash chain.

Snapshots include logical sequence, actual clock, explicit state, visible record IDs,
candidate hash, random draw count and log head. Initial, configured-interval and final
checkpoints are retained. These are review checkpoints; snapshot restore/resume is not
implemented. Warm-up and empty-input behavior is explicit, and snapshots expose no
undelivered source IDs.

Files use `replay_<artifact hash>.json`. Publication reruns semantic verification, writes
and syncs a private temporary file, then atomically links without replacing existing
evidence. Existing files must verify for reuse. Verification checks bounded regular files,
UTF-8, strict schema, filename/hash and complete semantic replay using the registered or
explicitly supplied factory. Altered candidates, logs, state, snapshots or manifests fail
even when a caller recomputes their hashes. Hashes are consistency evidence, not signatures
or source authenticity. Existing MarketBar, NewsDocument and SignalCandidate schemas,
SQL migrations and older research artifact schemas remain unchanged.

Work is bounded: at most 5,000 bars/1,000 documents, 20 intents per callback/10,000 total,
request-selected 1–100 queries per callback, two feature queries and 1,024 random draws per
callback, 2,000 bar results, 10,000 traced record references per callback/250,000 total,
and a 250,000 snapshot-reference work bound. Artifact files are limited to 64 MiB. This is a
finite research kernel, not a streaming service or external-code resource sandbox.

## Verification and next boundary

`tests/replay.test.ts` covers deterministic replay/randomness, timestamp ties, nanosecond
cutoffs, delayed news, warm-up, late price/news revisions, future-query rejection even
when caught, state/context immutability, provenance/rationale gates, work limits, corrupted
artifacts, non-repeatable strategies and CLI rejection paths. Full checks and retained
artifact identities are recorded in `docs/progress.md`.

Next is exactly Module 08, Iteration 2 — Fill, Costs and Portfolio Ledger. Retain this
clock/scheduler/query/Strategy boundary when adding simulation. No later fill assumptions,
ledger, performance report or strategy optimization is part of this iteration.
