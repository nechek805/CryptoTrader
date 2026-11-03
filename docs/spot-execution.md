# Spot fill, cost and portfolio ledger simulation

Module 08, Iteration 2. All orders, fills, authorizations and balances in the bundled
example are **synthetic and simulated**. Live execution is disabled. No exchange account,
order endpoint, private key, withdrawal, margin, funding or liquidation mode exists.
This service consumes explicit virtual order commands; it is not a trading strategy.

## Reproduce the accounting scenario

Use the pinned Node 24.22.2 and pnpm 10.34.9 runtime from README.

```powershell
pnpm replay spot-fixture --out data/spot-simulations
# Replace HASH with the printed artifact name:
pnpm replay spot-verify --artifact data/spot-simulations/spot-simulation_HASH.json
pnpm replay spot-report --artifact data/spot-simulations/spot-simulation_HASH.json
pnpm replay spot-reproduce --artifact data/spot-simulations/spot-simulation_HASH.json --out data/spot-reproduced
pnpm replay spot-run --input spot-input.json --request spot-request.json --out data/spot-simulations
```

The example buys one fictional BTC at modeled price 100 and sells it at 110. At a
0.001 taker rate the fees are 0.10 + 0.11 = **0.21**; exact ending cash is
1000 − 100 − 0.10 + 110 − 0.11 = **1009.79**, with zero BTC. This is an independent
accounting example, not measured strategy performance. The report exposes fills,
fees, final balances, source ambiguity and journal reconciliation without a PnL/equity
curve or benchmark comparison. Those research controls remain Iteration 3.

## Validated inputs and authorization

`spot-simulation-input.v1` embeds historical MarketDataset metadata, MarketBar evidence
and explicit SUBMIT/CANCEL commands. `spot-simulation-request.v1` declares one source/
venue, a single quote currency, requested instruments, independent portfolio IDs, shared
starting balance configuration, time window, latency, publication-delay bound, maker/
taker rates, spread/slippage, fee scale, volume participation and fixed policy versions.
Enabled derivatives, leverage, short borrowing and unknown execution flags fail validation.

Every SUBMIT includes a strict intent, existing SignalCandidate and RiskDecision. Check
portfolio/symbol/candidate identity, LONG→BUY or SHORT→inventory-backed SELL, allowed risk
decision, decision/cutoff/expiry clocks, authorized quantity and notional, quote currency,
any mandatory fixed stop/target policy,
historically known listing/mapping and tick/lot grids. Orders cannot outlive candidate
or risk authorization. Actual cumulative fill notional is checked again; a sell price
above its submitted minimum cannot bypass an authorized notional cap. Fees are additional
cash costs, not part of that exposure/notional cap. HOLD cannot authorize an order.

Rationale IDs that refer to included bars, metadata or observations must actually be
eligible/available by candidate dataCutoff. External rationale IDs and their original
hashes are preserved as producer evidence; this executor does not reconstruct arbitrary
news/model inputs or prove an external risk algorithm is correct. The fixture uses
explicit manual synthetic permits. Future strategy orchestration must validate its
producer snapshots and supply real computed risk decisions; no risk engine is fabricated.

BUY MARKET requires a positive maximum price; SELL MARKET requires a positive minimum.
LIMIT requires its explicit limit instead. No hidden unlimited-spend market order exists.
BUY protection optionally declares stopLoss/takeProfit around the price cap; it can only
exit acquired spot inventory. Orders reject insufficient **unreserved** cash or assets,
invalid precision, unknown listing and stale/denied/mismatched authorization.

## Time, event ordering and conservative OHLCV fills

Reuse the existing monotonic clock and availability scheduler; old replay/Strategy APIs
and artifacts remain compatible. Price evidence must be closed, eligible, actually
available, within declared maximum receipt delay, source-bound, on the requested interval,
and valid for the full historically listed/mapped/precision interval. Unknown/descriptive,
gap/stale/conflicting evidence cannot fill. A known precision change cancels an outstanding
order rather than silently rounding it. Missing/delisted prices never become zero exits.

Decision period is `[startAt,endAt)`. Before each event, process expiry timers at their
exact virtual times. At timestamp ties, cancellation acknowledgements precede new commands,
commands follow explicit sequence, then bars follow stable record order. This deliberately
excludes ambiguous mid-candle cancellation paths. Submission and protective activation
use `latencyMs`; cancellation reserves remain locked until request time plus that latency.
An order must be executable **at or before the source candle opens**, and still active
when the completed candle is available. Mid-candle orders never consume that full candle.

Fills are recorded at **bar.availableAt**, never backdated to its earlier open/high/low.
The price is an adverse envelope simulation using the completed candle; it does not
claim that a historic extreme or a contemporaneous executable quote was available at
submission. `fill.priceAvailableAt` retains actual receipt time. The order's older
`fillConstraints.priceDataAvailableAt` is only the lower bound at submission of its
declared price constraint, not an observation of a quote.

| Order/path        | Versioned price assumption                                                    |
| ----------------- | ----------------------------------------------------------------------------- |
| Market BUY        | Candle high × (1 + impact), rounded up to tick, within maximum price          |
| Market SELL       | Candle low × (1 − impact), rounded down to tick, above minimum price          |
| Limit BUY/SELL    | Fill at the limit only after strict penetration sufficient for impact         |
| Protective stop   | Adverse current candle low with sell impact; gaps can be worse than stop      |
| Protective target | Strict penetrated target with sufficient sell impact; target price, taker fee |

`impact = (fullSpreadBps / 2 + slippageBps) / 10000`. MARKET uses taker fees; plain
LIMIT uses maker fees. Every OHLCV fill discloses unknown depth; limits also disclose
unknown maker queue priority. Penetration is a declared matching assumption, not proof
of a historical limit fill. No bid/ask/order-book depth is inferred from OHLCV.

Available quantity is `floor(volume × participationFraction / lotStep) × lotStep`.
Orders in one portfolio share that candle capacity, with protective exits first and
otherwise acceptance FIFO. Timestamp ties preserve command order, not hashes containing
future input. Separate experimental portfolios receive the same independent capacity
and initial balances. No-partial orders wait for a candle able to cover the entire
remaining amount; this is not an immediate fill-or-kill instruction.

Each normalized series/close creates at most one opportunity. Older/revised/late candles
never replenish consumed liquidity or replay an earlier fill. Invalid first evidence
does not get a retroactive execution when later corrected. Mid-candle cancellation,
missing depth and gaps remain model limitations, not inferred intrabar certainty.

## Inventory-backed protective exits

Each completed BUY fill can create one reduce-only protective SELL order for exactly
that acquired quantity. It reserves those assets once, inherits the parent's expiry
and honors activation latency. Partial entries create separate inventory-backed lots.
Existing holdings cannot be sold or reserved twice.

When both stop and target are within one eligible candle, select **STOP_FIRST_ADVERSE**,
record the ambiguity in both trace and fill flags, and use the adverse sell envelope.
A protective target is a virtual market exit with taker costs, not a guaranteed maker
limit. Stop triggers latch through volume outages; a later fill uses the later candle's
adverse available envelope and retains the original triggering bar ID. Recovery before
liquidity returns can change the actual modeled stop execution price.

Protection is armed only when entry evidence is available. Movement earlier in the
entry candle cannot become a retroactive exit. Canceling a parent also cancels its
remaining attached protection and releases inventory. Expiry/end-of-run releases all
outstanding reservations without inventing market liquidation prices or recovery proceeds.

## Exact balances and append-only journal

Use an isolated 256-digit Decimal context. Monetary values remain validated decimal
strings, prices/quantities follow known tick/lot grids (at most 12 fractional places),
and notionals equal exact quantity × price. `quoteScale` controls **fee rounding only**:
fees round upward at that declared scale; exact notionals are not silently quantized.

BUY reservations cover price-cap notional plus a maximum-rate fee buffer for every
minimum lot. This conservatively covers repeated upward-rounded partial-fill fees;
it can lock more cash than a single aggregate fee would require. Remaining reservations
are recomputed/released exactly after fills. SELL reserves only owned quantity; fees
must be covered by sale proceeds. An uneconomic tiny sale whose rounded fee exceeds
proceeds is skipped rather than debiting a negative wallet.

`spot-journal.v1` records signed FREE, RESERVED, EXTERNAL counterparty and FEES postings.
Every transaction sums to zero **per portfolio and asset**. Deposits have explicit
external counterentries; reservation/release transfers stay within the wallet; trades
exchange base/quote against external accounts; fees have a separate expense counterentry.
External accounts may have negative contra-balances; wallet FREE/RESERVED balances may not.

Transactions are append-only, hash-chained and carry balance snapshots plus order/fill
links. Every action checks order quantity reconciliation and the sum of open-order
reservations against the ledger. Fill traces link release, trade, fee and any protection
reservation transactions. Final independent journal replay checks every posting group,
clock, balance snapshot and chain. Artifact semantic replay also proves those transactions
match actual simulated orders/fills; a balanced fabricated journal alone is not proof.

Idempotency uses portfolio/clientOrderId and the entire original intent/candidate/risk
payload. An identical retry, including after the original expiry, returns the existing
outcome. A conflicting payload fails. Canceling a terminal order never repeats a release.
Repeated `ExecutionSimulator.run()` returns the same frozen result and cannot refill.

```ts
import { ExecutionSimulator, simulateSpot, reconcileSpotJournal } from '@crypto/backtest';
const result = simulateSpot(input, request, codeVersion);
const checkedBalances = reconcileSpotJournal(result.journal);
// result.orders, result.fills, result.trace, result.balances, result.reconciliation
```

## Persistence, verification and limits

Content-addressed `spot-simulation_<hash>.json` embeds input/config/software hashes, seed,
policy versions, orders, fill evidence, journal, step traces, exclusions and reconciliation.
Seed is recorded for reproducibility; this deterministic envelope policy consumes no
randomness. Publication syncs a private temporary file and atomically links without
overwriting existing evidence. Verification checks size/UTF-8/schema/filename and rebuilds
the entire simulation. Existing corrupt evidence is refused, not replaced. Hashes do not
authenticate providers or grant source rights.

New simulation/journal contracts are separately versioned. Existing SimulatedOrder,
SimulatedFill, LedgerEntry, replay and SQL contracts remain compatible. The backtest
workspace declares the already-pinned Decimal package; no new third-party version or SQL
migration is introduced. Local artifacts, rather than a live account service, own this
iteration's virtual ledger.

Bounds: 2,000 bars, 200 commands, 20 symbols/instruments, four portfolios/21 initial
assets; events × max(1, commands) ≤ 250,000; 2,000 resulting virtual orders, 5,000 fills,
25,000 journal transactions, 10,000 trace entries and 64 MiB artifact files. Fee rates
are nonnegative and ≤ 0.1; spread/slippage each ≤ 1,000 bps. The intentionally simple
single-venue spot model excludes cross-venue custody, rebates, live fills and derivatives.

`tests/spot-simulation.test.ts` covers independent round-trip arithmetic, nonnegative
cash/inventory, reservation reuse and latency, partial/dust fees, FIFO/capacity isolation,
source/revision/listing/precision gates, worst-case same-bar protection, idempotency,
journal reconciliation at every action, property cases and corrupt artifacts/CLI flags.
The offline test runner caps concurrency at two workers to bound contention between
native analytical readers and spawned CLI processes; acceptance timeouts remain unchanged.
See `docs/progress.md` for actual check results and retained evidence.

Next is exactly Module 08, Iteration 3 — Research Controls and Sensitivity. It will add
the broader execution-assumption manifest, backtest orchestration, sensitivity analysis
and benchmarks/performance reporting. None of those results is claimed here.
