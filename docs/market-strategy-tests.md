# Market strategy tests

Run `pnpm dashboard` from the project root and open
<http://127.0.0.1:3100/market-strategy-tests>, or use **Market strategy tests** below
**BTC market test** in the sidebar. The existing local reader session opens automatically.

Use **Trading fees** above the tabs. The global switch turns fees on/off for every
strategy, coin and position. **V1 fees**, **V2 fees** and **V3 fees** change a strategy
individually. A mixed global indicator means only some strategies charge fees.
Fees default to **on (0.10% per side)**; choices persist across refresh and restart.
Off means 0%. Adverse slippage stays 0.05% per side plus tick rounding in every case.
After the first run calculates both scenarios, switches update results immediately.
Each strategy's buy-and-hold comparator uses its own fee setting. Earlier reports
remain intact. See ADR 0052. Plans and exports identify the exact assumptions used.

1. **Results** shows every coin against v1, v2 and v3, plus USDT cash. Each result is an
   independent 10,000 virtual USDT account. Select a result to inspect it.
2. **Strategies** describes the entry/exit rules, intended improvement, failure modes
   and actual counts of profitable/losing/flat markets. A later version can perform worse.
3. **Trade explorer** selects a coin and version, explains recorded gains/losses, groups
   closed trades by exit reason, shows fees, slippage and exposure, and lets you inspect
   completed candles and actual simulated fills. Use Next hour or Next long / exit.
   Verify deterministic replay reconstructs the decisions, fills and balanced ledger.
4. **Sources & assumptions** shows every source capture, dataset hash and per-symbol
   rounding/notional assumptions. Matrix and selected-test JSON exports retain IDs.

Use **Rerun all market tests** to replay the same cached inputs. Repeated replay is not
a new independent trial. To select a newer calendar window, first load newer real BTC
history on **BTC market test**, then run all market tests here. A first capture needs
public Internet access; unavailable or unverifiable assets are displayed as failures.
Previous results stay available while the bounded job runs. Frozen files survive restart.

CLI equivalent: `pnpm market-tests --verify` runs all ten markets and all three versions,
then verifies all 60 reports (both fee scenarios), restoring the selected preferences.
Do not run a second CLI writer while the dashboard research
job is active. Data and reports are under ignored `data/market-strategy-tests/`:
`datasets/<hash>/dataset.json`, `candles.parquet`, `reports/<hash>.json`,
`matrices/<hash>.json`. `fees.json` stores the three switches. The mutable `latest.json`
is only a completed-matrix pointer;
the input cache records fixed-window datasets and captured exchange metadata.

## Interpreting results

V1 uses MA20/MA50 crosses, including a bullish initial full window. V2 requires a fresh
cross, price above rising MA200 and a 3 ATR target at least three times estimated
round-trip costs. V3 also requires a signal close in the upper half of a nonzero range
and a signal range no greater than 2 ATR. Common controls remain ATR14, stop 2 ATR,
target 3 ATR, next-open entries/exits, adverse-first same-bar stop, selectable 0.10%/0% fee and 0.05%
adverse slippage per side plus tick rounding, 0.25% risk, 10% allocation, 1% prior-bar
volume participation and 2% UTC daily loss limit. The inherited execution risk denominator
has a 0.01 USDT per-unit floor; this can reduce exposure for low-priced tokens.

The backtest is spot long/hold/exit only. It does not implement shorts, leverage, funding,
liquidation, resting maker queues or historical spread reconstruction. Current exchange
PRICE_FILTER, LOT_SIZE and minimum-notional values are static historical assumptions,
not a claim to reproduce historical exchange rules. Protective stop/target orders are
simulated OHLC exits rather than guaranteed historical limit fills.

Equity and net P&L charge the selected strategy's fee: STANDARD is 0.10% per side and
ZERO is 0%. Both include adverse slippage. Slippage is embedded in
fill prices; do not subtract it again. Open holdings are marked at the final close with
entry costs included but no fictional final exit cost. Closed-trade contribution and
open contribution reconcile to total net P&L. Before-recorded-costs figures use the
same recorded fills; they do not rerun the algorithm at different costs. Buy-and-hold
has higher market exposure, enters at candle index 50 after its fixed warm-up and uses
the same entry fee/slippage assumptions. Its remaining units are marked at the final
close without exit costs; compare it with that exposure difference in mind. Drawdown is
sampled at hourly closes and can miss intrabar lows.

USDT cash stays at 10,000 USDT in all three columns, with zero trades and zero costs.
This tests quote-currency units, not the USDT/USD peg. No artificial USDTUSDT candles
are generated. Other assets each use their own real captured candles.

Historical first-availability times stay UNKNOWN; actual capture timestamps are kept.
The existing native forward-experiment gates are not relaxed. The universe is a fixed
list of currently available assets with survivorship bias and correlated market regimes.
V2/v3 already saw the BTC period during development. Negative and flat runs remain
visible. There is no parameter search, independent forward-validation claim or real-money
recommendation. See ADR 0050 for persistence and compatibility decisions.

## Local API

All routes use the existing authenticated local API and cookie Origin protection.
READ sessions may run this bounded retrospective research; paper-run controls still
require ADMIN. These routes are not registered in deployment mode.

| Route                                                                   | Purpose                                              |
| ----------------------------------------------------------------------- | ---------------------------------------------------- |
| GET `/market-strategies`                                                | Current completed matrix ID and bounded job progress |
| GET `/market-strategies/catalog`                                        | Three frozen strategy descriptions and references    |
| POST `/market-strategies/run` with `{}`                                 | Capture/reuse fixed-window inputs and run all tests  |
| GET `/market-strategies/matrix`                                         | All results including cash and explicit failures     |
| GET `/market-strategies/report?asset=ETH&strategy=V3`                   | Selected report, hourly bars and provenance          |
| POST `/market-strategies/verify` with `{"asset":"ETH","strategy":"V3"}` | Exact deterministic replay                           |
| GET `/market-strategies/export`                                         | Download the complete matrix                         |
| GET `/market-strategies/report-export?asset=ETH&strategy=V3`            | Download selected report                             |

Only the fixed asset list and V1/V2/V3 are accepted. USDT has no trading-report endpoint:
it is the declared cash control. Arbitrary URLs, paths and strategy settings are rejected.

POST `/market-strategies/fees` with `{"fees":{"V1":true,"V2":false,"V3":true}}` selects
fees on/off per strategy and returns saved workspace state. The global switch sends all
three flags together. This endpoint requires the same authentication and Origin checks;
settings cannot be changed during a research job. Fee-mode labels and each selected
strategy's buy-and-hold result accompany the matrix and selected report exports.
