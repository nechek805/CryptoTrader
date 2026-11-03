# Market-only interpretable baselines

Module 09 Iteration 1 publishes deterministic market candidates and costed, unborrowed
spot research reports. All fixture prices and metadata are **SYNTHETIC**. No ranking,
training, labels, fitted parameters, selection rule or profitability claim is provided.

## Run and reproduce

Use the pinned runtime from README before running commands:

```powershell
pnpm backtest market-fixture --asset BTC --regime WHIPSAW --strategy MA_CROSSOVER
pnpm backtest market-matrix --out data/market-baselines
pnpm backtest market-run --manifest <manifest.json> --out data/market-baselines-built
pnpm backtest market-verify --directory <market-baseline_directory>
pnpm backtest market-report --directory <market-baseline_directory>
pnpm backtest market-reproduce --directory <market-baseline_directory> --out data/market-baselines-reproduced
pnpm backtest market-fixture --asset SOL --regime REVERSAL --strategy SYMMETRIC_MA_FIXTURE
```

The fixed matrix contains 45 costed reports: BTC/ETH/SOL × TREND/WHIPSAW/REVERSAL ×
CASH/BUY_AND_HOLD/MA_CROSSOVER/BREAKOUT/ZSCORE_REVERSION. Each costed report contains
independent strategy, cash and buy-and-hold accounts with identical assumptions. Three
additional symmetric reversal reports contain signals only, with execution DISABLED.
This is a disclosed acceptance fixture set, not Module 09 Iteration 3 parameter search.
Invalid options, unregistered strategies and unsupported real execution fail closed.

Each immutable directory contains manifest.json, report.json, report.md and bundle.json.
Canonical payload and byte hashes bind source snapshots, parameters, software version,
seed, costs, eligibility policy, candidates, features and simulated ledgers. Verification
rebuilds the report and rendered Markdown; changing content and recomputing a file hash
does not bypass semantic validation. Reproduction retains the original software label;
the current implementation must still reproduce its content. Older replay, spot and
backtest-controls artifacts keep their existing contracts and formatter.

## Public interfaces and signals

`@crypto/strategies` exports `MarketSignalProvider`, `createMarketStrategy`,
`MarketOnlyContext`, `MarketStrategy`, `marketStrategyId` and `sizeMarketTarget`.
`@crypto/backtest` exports `marketBaselineFixture`, `marketSource`, `runMarketBaseline`,
`marketFixtureSignals`, `validateMarketBaseline`, `writeMarketBaseline`,
`verifyMarketBaseline` and `marketBaselineMarkdown`. New public payloads have strict
Zod contracts in packages/contracts/src/market-strategies.ts.

Providers consult only closed market bars and the replay's point-in-time technical
feature service. NEWS deliveries make no queries or state changes. The type excludes
news methods and execution/account access. Feature reads use the callback clock and
delivered prefix; unavailable records, late metadata, gaps, invalid price/volume grids,
listing changes, stale receipts and source mismatches cannot become entry evidence.
Selected feature input IDs, historical metadata IDs, formula fingerprints and maximum
input timestamps are retained in state snapshots. The technical feature query trace
also records all inputs computed by that query. No warm-up value is replaced by zero.

| Kind                 | Entry                                                                                            | Exit                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| CASH                 | Never; always HOLD/flat                                                                          | No exposure                                                                          |
| BUY_AND_HOLD         | First eligible liquid candle                                                                     | Holds through the end; no synthetic closing sale                                     |
| MA_CROSSOVER         | Fast SMA or seeded EMA crosses above slow; first fully eligible positive relation also qualifies | Negative relation, max holding duration, or configured missing-data exit             |
| BREAKOUT             | Close strictly above prior-window high plus buffer                                               | Close below prior exit-window low, max duration, or missing-data policy              |
| ZSCORE_REVERSION     | Prior-window z-score at or below negative entry threshold                                        | z-score at or above negative exit band, max duration, or missing-data policy         |
| SYMMETRIC_MA_FIXTURE | Positive/negative MA relation gives virtual long/short targets                                   | Opposite relation, duration or missing-data policy; cooldown before the other target |

Defaults are MA 2/4 SMA; breakout 4-bar entry/2-bar exit with zero buffer;
z-score 4-bar entry 1.25/exit 0; minimum volume 1, freshness 120 seconds,
maximum holding 128 bars, one cooldown bar and EXIT on missing features. CASH and
BUY_AND_HOLD are controls: max-hold/missing-exit/cooldown do not liquidate buy-and-hold.
Source metadata failures retain HOLD rather than requesting an unqualified liquidation.
An invalid MA window resets the relation so it cannot consume an unactionable crossover.
Consumed closes and late corrections cannot create duplicate entries.

Scores are **target-state codes**: 1 long, 0 flat, −1 virtual short. Calibration remains
explicitly MISSING. A HOLD candidate carries the persistent target, not a new entry.
The symmetric provider requires synthetic metadata and fixture-labelled bars, and the
spot runner rejects it. No short PnL, borrow, funding, margin or derivatives are simulated.

## Sizing and timing

The external sizing interface accepts a fixed absolute quantity, actual owned quantity,
target and known lot step. It returns the target gap rounded down to the lot grid.
There are no score, price, volatility, PnL or leverage fields. The simulator independently
vetoes unavailable cash/inventory, bad source/precision, notional caps and expiry.
Unfilled intents are not treated as owned assets.

Reconciliation runs at decisionAt plus **one nanosecond**, using the simulated execution
prefix through the receipt. It includes free and reserved owned assets. Pending orders
block replacement; an opposing target requests cancellation once and waits for resolution.
Partial fills remain partial. Rejection/expiry does not trigger repeated orders on each
HOLD: only a new target transition permits another attempt. Pending-wait transitions can
be submitted after the pending order resolves. No future price changes the size.

Execution candidates have distinct deterministic IDs and link the original immutable
signal plus prefix hash. Risk audit retains the size, prefix, policy and source identity.
Orders cannot use an entire candle that began before placement. With zero configured
latency, a decision on a 00:04 close therefore first fills on the complete 00:05–00:06
candle receipt. All roles share this conservative timing. End-of-run orders release
reservations without fabricating closing trades. Terminal owned assets use known fresh
marks; missing marks and their risk statistics remain unknown.

## Fixtures and limits

Each fixed recipe has 24 one-minute bars, volume 1,000, cash 1,000, target one unit,
0.1% taker fees, 10 bps spread and 5 bps slippage. BTC/ETH/SOL start at fictional
100/50/20. TREND adds one per bar; WHIPSAW repeats three bars at base+3 followed by
three at base−3; REVERSAL rises for twelve bars then declines. OHLC are equal within
each bar, and all source/recipe hashes are retained. This deliberately simple matrix
tests known signal directions and retained losses; it is not a sampled market universe.

The BTC whipsaw MA path has three completed round trips: gross PnL −18.63, fees
0.60003 and net PnL −19.23003, net return −0.01923003. Costs and adverse-price rounding
are included. Synthetic result magnitudes are not investment estimates.

Runner work is capped at 128 input bars and a bounded historical calendar, one spot
series and one execution case. OHLCV depth, queue position and intrabar paths remain
unknown. There is no annualized Sharpe, model selection, real historical validation,
general risk engine or four-engine portfolio comparison. API/doctor remain fixture-only.
Next: exactly Module 09 Iteration 2, Training Data and Simple ML, under temporal gates.
