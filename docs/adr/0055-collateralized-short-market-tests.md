# ADR 0055 — Collateralized short tests for every retained token

Date: 2026-11-06. Status: accepted for local retrospective research.

The user requested short support for all tokens. Preserve every frozen long-only
engine, contract, dataset, matrix, report ID and fee preference. Add a new versioned
directional engine, contracts, collateral/debt ledger and authenticated local service.
The sidebar's **Long & short tests** page compares LONG_ONLY, SHORT_ONLY and LONG_SHORT.
Existing BTC, all-token and SOL/XRP pages link to it and retain their original results.
This extends market research only; native paper/news/fusion risk gates and real-money
execution remain unchanged.

The ten retained public spot/USDT histories cover BTC, ETH, SOL, TRX, BNB, XRP, DOGE,
ADA, LINK and AVAX. USDT is the cash control, not a fabricated USDTUSDT market. V1–V3
exist for all ten tokens; V4/V5 retain only their original SOL/XRP profiles. There are
34 profiles, three direction modes and two fee modes: 204 comparison cells. The 68
original long-only cells point to the original immutable reports. Before extending
each profile, require the new engine's LONG_ONLY equity, net P&L, costs, counts, open
quantity and hourly drawdown to reproduce the saved report in both fee modes.

No historical lending availability/rates or perpetual funding data was captured. Do
not portray spot prices as historical futures executions or invent a measured funding
series. Use a prominently labelled hypothetical spot-borrow model with 100% entry
notional collateral, locked sale proceeds and a fixed 10% annual borrowing-cost
assumption. Charge simple USDT interest on entry notional at annual rate / 8,760 per
holding candle, rounded to 18 decimals per hour. Intrabar exits are charged a full
exit candle; next-open exits do not accrue another hour. This is a declared sensitivity
assumption, not an actual provider rate, product availability or recommended borrowing
rate. Financing remains enabled when trading fees are switched off.

Short entries SELL at the next open after a fresh bearish MA20/50 crossover; covers
BUY with adverse slippage and tick rounding. V2 mirrors the rising MA200/price-above
gate to a falling MA200/price-below gate. V3 mirrors the upper-half close gate to a
lower-half close, retaining the maximum 2 ATR range. Specialist impulse and volatility
target rules use only completed signal candles. Short stops are above entry and
targets below. Bullish crossovers or daily loss limits close shorts. Combined mode
shares one account and one position, closes before reversing, pays both fill fees,
and resizes the new entry against the actual account after the close.

Keep 10,000 initial USDT, 0.25% risk, 10% notional allocation, 1% prior-candle volume
participation and a 2% daily loss limit. Entry quantity cannot increase at the next
open or spend locked short proceeds. The filtered short cost gate budgets 24 hours
of borrowing plus round-trip trading fees/slippage; actual carry depends on the hold.
No new parameter search or claim that prior long-only tuning optimizes shorts.

The separate ledger balances each asset's postings, makes borrowed base-asset debt
explicit, and distinguishes free USDT, collateral and sale proceeds. No negative
spendable cash, collateral or proceeds is permitted. Equity includes borrowed-token
liability at the current close. A short covers and repays the base debt before its
collateral/proceeds become available. Keep independent long/short closed-trade net
totals; reconcile their sum plus final open contribution to account net P&L.

Within a candle, choose the adverse protective exit before the profit target, using
the worse opening gap. A 0.5% maintenance allowance and closing-cost reserves define
a hypothetical forced-margin-close level; ordinary stops normally trigger earlier.
If an extreme opening gap exceeds all account funds, record the uncovered USDT debt,
retain negative equity and halt further entries. Never hide the deficit by clipping
equity or crediting an unrecorded deposit. Failed repayment is explicit insolvency,
not a guaranteed loss cap. Unknown market depth and lender recalls remain limitations.

Version all assumptions and fingerprint execution, ledger, contracts, fixed plans,
decimal helpers, validation and canonical hashing source. Reports and journals are
content addressed; publish a new matrix pointer only after all profiles finish.
Bounded inputs select only known tokens, versions and modes. Requests cannot choose
arbitrary URLs, files, leverage, risk parameters or borrowing assumptions. Keep
atomic saved V1–V5 fee preferences separate from the existing labs. A global switch
affects all coins, modes and positions in this comparison; individual switches affect
one version. Fee changes select complete cached simulations, not arithmetic adjustments.

The UI shows all outcomes, separate long/short contributions, borrowing costs,
collateral, base debt, uncovered default debt, negative-equity halts, equity curves,
hourly signals, entry/cover order direction, sources, JSON export and exact replay.
Profiles selected on previously seen long-only history remain exploratory. There are
68 new short-enabled profile/mode combinations, each evaluated with fees on/off,
without ranking away losses. No live execution or independent validation is claimed.
