# Long and short market tests

Run `pnpm dashboard` and open **Long & short tests** in the sidebar:
`http://127.0.0.1:3100/long-short-tests`.

The page now defaults to the separate SOL/XRP **V6 research**, retaining every V1–V5
comparison and an **Original V1–V5 comparison** archive. See
[V6 short-trade diagnosis and results](sol-xrp-v6-short-research.md) for its 44 retained
candidates, unchanged long rules, full-period improvements and later-period limits.
The remainder of this guide documents the preserved V1–V5 extension and its assumptions.

The same ten six-month hourly histories and independent 10,000-USDT accounts support:

- **Long only · original:** the exact original report and ID, with the selected fee mode.
- **Short only:** bearish entries and covers, with borrowing costs and collateral.
- **Long + short:** one shared account per coin/version, with at most one position.

V1–V3 cover BTC, ETH, SOL, TRX, BNB, XRP, DOGE, ADA, LINK and AVAX. SOL and XRP
also retain their original separate V4/V5 profiles. V4/V5 cells for other tokens are
explicitly not developed. USDT remains a 10,000-USDT cash control. Every existing
long-only page, result, dataset and fee preference remains available.

## Test step by step

1. Open the page and use the completed saved comparison, or select **Run all direction
   modes** to replay all 34 profiles on the frozen histories. Progress is shown by
   profile; old complete results stay available if a new job fails.
2. Keep **Fees for all versions** on for a full-cost comparison. Each V1–V5 switch
   applies to every coin/mode/position in that version. Settings persist separately
   for this page. Fees are 0.10% per fill; adverse slippage is 0.05% plus tick rounding.
3. Switch between long-only, short-only and combined results. Combined P&L is not the
   sum of the other two modes: it shares capital, changes position sizes and can reverse.
4. Select a result to open **Trade explorer**. Inspect a completed candle, move to the
   next LONG/SHORT/EXIT, and compare signal time with the following-open fill. A short
   entry is **SHORT / OPEN / SELL**; repayment is **SHORT / CLOSE / BUY**.
5. Inspect reserved collateral, borrowed-token quantity, cumulative financing and
   separate closed long/short profit. Open-position contribution remains separate.
   Inspect all fills, export the report and select **Verify exact replay**.
6. Open **Rules & assumptions** before interpreting profitability. Historical lending
   availability, actual lending rates and recalls are unknown. These are hypothetical
   spot-borrow tests, not verified exchange margin or futures executions.

## Short rules and costs

Mirror the existing rules for falling markets: MA20 crosses below MA50; filtered
versions require close below a falling MA200. V3 requires the signal to close in its
lower half, with range no greater than 2 ATR. XRP specialists retain their 0.8 ATR
minimum signal range. SOL V5's low-volatility target and XRP V5's conditional momentum
target apply symmetrically using only the completed signal. There is no new short
parameter tuning. A short stop is above entry and its target below entry.

Borrowing uses an explicit fixed **10% annual simple interest assumption**, charged
in USDT on the initial short notional at 1/8,760 per holding hour. Charges round to
18 decimal places per hour. A protective exit somewhere within an hourly candle pays
for that whole candle; a next-open exit does not pay another hour. The filtered cost
gate estimates 24 hours of borrowing, while actual financing follows the hold length.
**Turning trading fees off does not turn borrowing or slippage off.** The 10% rate
is a research assumption, not measured historical data or a recommended rate.

Every short reserves entry notional as collateral and locks all sale proceeds.
Borrowed base debt is marked at each close. Proceeds cannot fund another position.
Notional allocation stays at most 10% of account equity, per-entry risk 0.25%, prior
volume participation 1% and daily loss limit 2%. Combined mode closes before reversing
and pays both fill fees. Quantity is checked again at the execution open.

Adverse exits win when an hourly candle crosses both stop and target. Gaps execute at
the worse opening price. Forced margin close assumes 0.5% maintenance and reserves
for close fees/slippage; normal stops generally trigger earlier. A catastrophic gap
can exceed all collateral and free cash. The simulator records uncovered USDT debt,
allows negative equity and permanently halts that account instead of hiding the loss.
Available cash, collateral and locked proceeds remain nonnegative.

## Interpretation and reproduction

The retained window is 2026-05-04 07:00 UTC → 2026-11-04 07:00 UTC, end exclusive:
4,416 hourly candles per token. All history was previously seen. Existing profiles
were developed for long-only trading, so short extensions need further independent
testing. Losses, zero-trade profiles and weaker combined outcomes remain visible.
There are 34 profiles × 3 modes × 2 fee settings = **204 comparison cells**, including
68 preserved original reports and 136 new short-enabled reports. These are 68 new
profile/direction combinations in two cost scenarios, not 136 independent experiments.

The first completed fees-on comparison includes:

| Profile | Original long-only net USDT | Short-only net USDT | Combined net USDT |
| ------- | --------------------------: | ------------------: | ----------------: |
| SOL V5  |                     +158.37 |              −16.98 |           +141.13 |
| XRP V5  |                     +148.19 |              +28.08 |           +176.69 |

SOL V5 combined has 31 closed trades, with 3.400023052739726035 USDT borrowing
cost; XRP V5 combined has 13, with 1.784616678310502311 USDT borrowing cost.
These amounts already include financing and trading fees; slippage is embedded in
fills. Adding shorts improves XRP V5 on this history and reduces SOL V5's return.
All other profiles, including losses, remain in the same comparison.

Open positions are marked at the final close without fictional exit charges. Hourly
drawdown can miss intrabar lows. Current tick/lot filters remain retrospective
assumptions; historical first availability and borrow availability remain unknown.
No futures funding series, order book, real exchange account or live order is implied.
All native forward-availability gates and old trading engines remain unchanged.

```powershell
pnpm directional-tests --verify
```

This reuses the frozen histories, checks long-only compatibility in both fee modes,
generates short-only and combined reports, and verifies all 136 new reports and
journals before restoring saved fee settings. Artifacts live under ignored
`data/directional-tests/`; shared snapshots and old reports stay in their original roots.
The authenticated local `/directional-tests` API supplies state, matrix, run, fees,
report, verify and export routes. Arbitrary endpoints, profiles, paths, leverage or
risk overrides are rejected. See ADR 0055 for the ledger and execution decisions.

First completed matrix:
`sha256:ed775e088375404b0c9a5fce9ecfa08aa9e1f2d30672171bfc5d6ec67820013b`.
Directional engine:
`sha256:e56b7e6cd974ffe2f662c6306ac91d47e58d9af5e71af94b9bfdf24b866e8e0d`.
Preserved specialist parent:
`sha256:70763372043f09d7493e2f8efa6bced1787f530e587b156bd01dccdf4459cd94`.

Validation: `pnpm check` passes **1,095 tests in 58 files**, lint, formatting,
backend/web types, smoke and contracts. Production build, doctor and all 17 roadmap
checksums pass. All 136 new short-enabled reports and journals replay exactly; all 68
original long-only cost scenarios reproduce in the new engine and retain old IDs.
The 22 new focused tests cover all ten borrowed-token identities and grids, baseline
compatibility, hand-calculated short costs, lower-half gates, fee-off financing,
reversal ordering, locked proceeds, future-price invariance, adverse gaps, explicit
insolvency, ledger/report tampering, strict request validation, local authentication
and fee persistence. Generated captures and browser diagnostics are excluded from
source linting through the ignored `data/` root.

Live local READ-session acceptance passes **74 selected reports, all 32 fee-switch
combinations, two API replays and both export types**. Five pages serve matching
ten-link server/client menus, including the original market pages and the new route.
All 68 old report IDs and original matrix pointers/settings remain unchanged. All
directional fee switches are restored on, including the saved preferences, and the
dashboard is left running. Browser visual automation is unavailable; these checks do
not claim a visual click-through acceptance test.
