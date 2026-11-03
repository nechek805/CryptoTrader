# Backtest controls, performance and sensitivity

Module 08, Iteration 3. The backtest coordinator combines the existing causal replay
and spot simulator with versioned execution assumptions, independent cash/buy-and-hold
comparators, performance accounting and a bounded sensitivity matrix. All execution is
simulated. The bundled losing and leaking strategies are explicitly synthetic diagnostics.

## Run, inspect and reproduce

Use pinned Node 24.22.2 / pnpm 10.34.9 (README describes the Windows runtime).
No database, network, credentials or external code loading is required.

```powershell
pnpm backtest fixture --out data/backtests
# Substitute the printed content-addressed directory:
pnpm backtest verify --directory data/backtests/backtest_HASH
pnpm backtest report --directory data/backtests/backtest_HASH
pnpm backtest run --manifest data/backtests/backtest_HASH/manifest.json --out data/backtests-built
pnpm backtest reproduce --directory data/backtests/backtest_HASH --out data/backtests-reproduced
```

`run --manifest` publishes JSON and Markdown together. Each immutable bundle contains
`report.json`, `report.md`, the exact canonical `manifest.json`, and `bundle.json`
with byte hashes and report/manifest identity. Reproduce uses the stored manifest and
current software hash. Identical input/config/code reproduces every bundle byte.
Report JSON retains every scenario's replay, candidates, simulated orders/fills,
authorizations, complete journal/trace, equity curve, closed FIFO lots and metrics.

## Frozen input and assumptions

`backtest-manifest.v1` embeds canonical MarketDataset and ReplayInput evidence, its
content hash, strategy ID/version/config/required fields, explicit series/quantity/
price bounds/notional cap/lifetime, predeclared candle calendar, mark freshness limit,
cohort disclosure and at most six additional scenarios. `execution-assumptions.v1`
wraps the complete existing spot policy and a declared timestamp at/before decision
start. Hashes cover all the inputs, clock/cost/latency/volume policies, scenario
transformations and sizing choices. Initial positions must be zero; initial cash positive.

The declared timestamp is an operator assertion, not authenticated prospective
registration. Snapshot hashes establish local consistency, not provider authenticity,
source rights or proof of when an experiment was registered. Original provider clocks,
source chains, licensing classifications and quality flags remain intact. Frozen
historical input may contain later observations; only the delivered prefix is exposed
to strategy callbacks. Descriptive/unknown-availability bars never become tradable data.

This first coordinator supports one explicitly declared spot series, source/venue,
quote currency and BASELINE account per counterfactual. It reuses the multi-portfolio
spot primitive without claiming to implement the later news/market/fusion engines.
The three roles are separate virtual runs, each with identical starting cash, inputs,
period, quantity policy, execution assumptions and volume opportunity set. They do not
compete for a shared experimental liquidity budget or share wallet state.

## Registered strategies and bounded authorizations

| ID                       | Behavior                                                                     |
| ------------------------ | ---------------------------------------------------------------------------- |
| `control:no-trade`       | Explicit HOLD on eligible price events; no orders                            |
| `control:buy-and-hold`   | One LONG on the first eligible known price; retain acquired inventory        |
| `synthetic:loss-control` | One LONG, then one SHORT after configured `sellAfterEvents` (at least three) |
| `synthetic:future-leak`  | Deliberately requests a future cutoff; the run must fail before publication  |

Non-losing control config is `{}`; the losing control config is
`{ "sellAfterEvents": 3 }`. Diagnostic IDs require wholly synthetic sources and fixture
records. None is an optimized forecasting strategy. Market regimes, technical trading
baselines, ML, news-only/fusion producers and broad strategy selection remain later modules.

Strategies use the existing `StrategyFactory` / `Strategy.onEvent` and `ReplayContext`.
Callbacks see the delivered prefix, including strict timestamp tie order, immutable
state and provided clock/randomness. A fresh factory is used per run. Explicit future
cutoffs, undelivered IDs and caught access violations still fail loudly. Data-field
requirements reject unsupported order-book depth/funding or unavailable timed news;
every comparison scenario requires actual eligible OHLCV during its period. An all-data
outage fails rather than publishing fictitious zero-return strategy evidence. Warm-up
and per-row missing observations remain explicit in the source/query contracts.

`runBacktest(manifest, codeVersion, factory?)` permits trusted TypeScript factories with
matching descriptor ID/version/config. CLI loads registered controls only. In-process
custom code is not a security sandbox and must use supplied time/randomness and explicit
state. Publication reruns semantics and rejects non-repeatable results. Code/version
identity must describe the actual supplied implementation.

Non-HOLD candidates become explicit market-order intents with predeclared quantity,
BUY cap / SELL floor, notional bound and clamped candidate/period/lifetime expiry.
The coordinator creates attributable bounded research authorizations; the spot executor
can veto cash, inventory, lifetime, source, precision and actual notional violations.
This is not the later general risk engine. SHORT means an inventory-backed spot exit;
there is no short borrowing or leverage. Candidate evidence/time gates come from replay,
and known rationale IDs are checked again by the executor.

Candidate generation and matching remain two deterministic passes. The existing matcher
processes commands before price evidence at a timestamp and requires full-candle activity.
It can therefore reject an exit before a pending entry acknowledgement at the same time.
Strategies receive price/news context, not fill/account feedback in this coordinator.
Reports retain those rejections; latency scenarios do not pretend their executed paths
are identical. There is no fill at a strategy's first unavailable historical open.

## Benchmarks and scenarios

Cash issues no orders. Buy-and-hold uses the same predeclared quantity/cap and can first
execute only under the same full-window/latency/price/volume rules as the strategy.
Unspent cash remains cash; this is a quantity-matched comparator, not an implicit all-in
portfolio. An unfilled benchmark entry remains visible through zero fills and rejection/
skip details rather than being replaced with a favorable historical fill.

Each scenario explicitly overrides only maker/taker rates, full spread, slippage or
latency, and/or omits named original candle IDs. All originals remain in the root frozen
manifest. Unknown/duplicate omissions and scenario names fail. Effective input and full
assumption hashes identify every transformed run. The fixture runs base, higher fees,
higher slippage, wider spread, latency and one missing-candle case for all three roles.
No scenario is selected as the winner or treated as an independent statistical sample.

For higher-fee-only cases with **identical actual side/quantity/price/receipt/liquidity
paths** and known terminal valuations, gross PnL must be identical and net PnL cannot
improve. The coordinator asserts this across all roles. If fee reserves change accepted
orders/fills, or marks are unknown, report `CHANGED_EXECUTION_OR_UNKNOWN_MARKS` instead
of attributing the outcome to fees on identical trades. Latency/gaps/slippage can change
execution and are not assumed to have monotonic effects on total returns.

## Performance and valuation contract

| Field                   | Meaning                                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------------------- |
| Net PnL / return        | Terminal marked equity minus initial cash; return divides by initial cash                                |
| Gross PnL / return      | Net PnL plus explicit fees; modeled spread/slippage already affect fill prices                           |
| Fee drag                | Exact summed fees, plus fees divided by initial cash                                                     |
| Equity / exposure curve | Cash including reserves, asset quantity, known close/evidence, equity and position-value/equity fraction |
| Max drawdown / exposure | Maxima over reported valuation points, not inferred intrabar extremes                                    |
| Time in market          | Exact nanosecond duration with positive owned quantity, divided by run duration                          |
| Turnover                | Sum of all BUY and SELL fill notionals; fraction divides gross two-way turnover by initial cash          |
| Closed trades           | FIFO matched quantities with exact prices, source fill IDs, gross PnL and allocated entry/exit fees      |

All values are decimal strings with explicit rounding (ratios/fee allocation at 36 places).
Partial FIFO fee allocations consume the exact remaining fee on the final matched piece,
so allocated fees do not silently disappear. Unclosed entry fees still affect portfolio
net equity. Realized closed-lot records and terminal marked equity answer different
questions; open positions do not receive a fabricated liquidation trade or exit fee.

Valuation points are end-of-timestamp observations after all admitted events, plus
nanosecond freshness-expiry boundaries and start/end markers. Final marks exclude records
arriving exactly at the half-open run end. The latest actually known valid close is used
only within the declared maximum age. Bad latest revisions, stale data, delistings or
unsupported symbol renames can leave an owned asset unpriced. It is not set to zero,
converted to another asset or indefinitely forward-filled. Past points retain their own
knowledge cutoff when later corrections arrive.

Unknown held-asset marks make equity/return metrics null where they cannot be established.
Any unknown equity point makes drawdown/exposure maxima unknown, even if terminal cash
is later known after an exit. Actual cash with no position remains known without a price.
Time positioned, trade records, fees and turnover remain observable independently of
missing marks. No annualization, Sharpe estimate, confidence interval, significance or
out-of-sample alpha claim is produced from a short synthetic scenario.

## Execution audit and compatibility

Reports retain missing eligible close times against the predeclared calendar, explicit
omitted IDs, rejected orders, per-reason skipped attempts and all underlying fill flags.
OHLCV depth and maker queues remain UNKNOWN. Conservative highs/lows, strict penetration,
publication-delay bounds, adverse tick rounding, shared volume caps and stop-first
ambiguity behavior are unchanged from `docs/spot-execution.md`. A skipped attempt is a
model decision, not proof that a real trade was available or missed.

Bundles sync all files in a private checked staging directory before atomic publication.
Existing files must fully verify for reuse. Verification checks bounded regular files,
byte hashes, directory identity, regenerated Markdown/canonical manifest and complete
strategy/simulation/metric replay. Changing a Markdown conclusion and recomputing its
checksum cannot conceal a contradictory report. Future-read/unavailable-field failures
produce no report bundle. Failed runs do not overwrite prior results.

New backtest/assumption/bundle schemas are separately versioned. Existing replay, spot,
technical/panel and SQL schemas remain unchanged; no dependency version or SQL migration
is introduced. Limits include six additional scenarios, 12,000 total source-event/role/
scenario work units, 2,000 expected closes, existing replay/spot limits and 64 MiB per
bundle file. This is a finite research coordinator, not a live service.

## Module 08 handoff

The public interfaces exported by `@crypto/backtest` are `Strategy`, `StrategyFactory`,
`ReplayContext`, `ExecutionSimulator`, `runBacktest`, `writeBacktest`, `verifyBacktest`
and `backtestMarkdown`. `BacktestManifest`, `ExecutionAssumptionsSchema`, `BacktestReport`
and associated Zod schemas are exported by `@crypto/contracts`. Inputs, order of knowledge,
model assumptions, candidate/risk provenance, fill traces and accounting evidence remain
reviewable by future Modules 09–13.

`tests/backtest.test.ts` covers hand-calculated losing results, equal benchmarks,
fee invariance, changed paths, source gaps, stale/boundary/corrected marks, renames,
partial FIFO fees, unavailable fields, future reads, repeatability, work limits,
tampered bundles and CLI rejection. Actual verification and artifact identities are in
`docs/progress.md`.

Module 08 stops here. Next is exactly Module 09, Iteration 1 — Interpretable Baselines.
