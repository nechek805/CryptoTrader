# SOL and XRP V6 short research — 2026-11-06

Open **Long & short tests → Latest V6 research** at
`http://127.0.0.1:3100/long-short-tests`. Use **V6 research** for diagnosis, parameters,
every candidate and the later check; **Trade explorer** retains every V1–V6 fill.
**Original V1–V5 comparison** opens the previous interface and saved settings.

## Same history and costs

Use the exact saved 4,416 hourly candles per token, 2026-05-04 07:00 UTC through
2026-11-04 07:00 UTC, end exclusive. No data is downloaded or replaced. Each
coin/version/mode starts with 10,000 virtual USDT. Fees are on, 0.10% per fill, with
0.05% adverse slippage plus ticks and the existing hypothetical 10% annual borrowing
charge. All risk, allocation, volume, collateral and margin assumptions are unchanged.

| Net profit, USDT |  SOL V5 |      SOL V6 |  XRP V5 |      XRP V6 |
| ---------------- | ------: | ----------: | ------: | ----------: |
| Long only        | +158.37 |     +158.37 | +148.19 |     +148.19 |
| Short only       |  −16.98 |  **+84.45** |  +28.08 |  **+84.53** |
| Long + short     | +141.13 | **+244.17** | +176.69 | **+233.97** |

Exact short-only nets: SOL **84.451290922260273941**; XRP
**84.526438115388127845**. Combined nets: SOL **244.169074036780821892**;
XRP **233.971725266872146128**. These are separate 10,000-USDT accounts.
Combined returns are not the sum of independently reset long-only and short-only
returns: positions share capital and prior profits affect later quantities.

## Why SOL lost in V5

SOL had **15 closed shorts, five wins and ten losses**. Six trades stopped out;
four losing trades closed on a trend crossover. Its actual fills earned **14.67447
USDT before trading fees and borrowing**. Trading fees **28.28199323** and borrowing
**3.371110644406392683** turned this into **−16.978633874406392683 USDT**.
Slippage **16.02008** is already embedded in the fills and must not be subtracted
again. Borrowing alone was not the principal cause of the loss.

Several bearish crossovers happened while the long MA200 was falling only weakly.
Those entries had little follow-through. Other trades moved favorably but never
reached targets inherited from long-side tuning. Entry hour 448 moved more than
4.57 entry ATR in SOL's favor on completed candles before its exit, then lost
24.620194661780821916 USDT. Entry 875 moved more than 2.85 ATR favorably and later
lost 8.44989236301369864 USDT on a trend exit. The later entry 3226 similarly gave
back a 3.60 ATR move. OHLC excursions do not establish an achievable optimal exit;
they motivate tests whose actual fills remain conservative.

**Selected SOL V6:** require MA200's fall over the previous 24 completed hours to
be at least **0.75 current ATR14**, with price still below that falling average.
Use a **2.5 ATR short target**, retaining the **2.5 ATR stop**. Keep V5's long-side
rules, including its volatility-dependent long target. Trailing candidates were
tested and retained but not selected. Do not add a short candle-quality filter that
would silently discard the existing profitable weak-close entries.

V6 filters many shallow-trend losses and exits retained shorts nearer to entry.
It also filters a later winning short and earns less on some retained winners.
Its five full-period closed shorts all win on this snapshot; only three occur in
development. This is a small, repeatedly tuned sample, not a general win-rate estimate.

## XRP's separate improvement

XRP V5 had **nine shorts, three wins and six losses**, net
**28.08323995196347031 USDT**. Some losing entries were only about 0.48–0.57 ATR
below MA200, where crossovers repeated without a durable decline. Other losing entries
were more than 4–6 ATR below it, after an extended move. Retaining a falling average
and lower-half close did not distinguish these situations well enough.

**Selected XRP V6:** require the completed signal close to be **0.75–4 ATR14 below
MA200**, inclusive. Use a **3.5 ATR short target**, retaining the **2 ATR stop**, the
falling MA200, lower-half close, 0.8–2 ATR signal range and cost gate. The long-side
V5 conditional 6 ATR target remains unchanged. Short entry and execution both use the
target chosen on the preceding completed signal candle.

This retains the three previously winning short entries and filters the six losing
entries on this snapshot. A retained short that previously used a 6 ATR target now
takes the nearer 3.5 ATR target and earns less; the page shows that lost upside.
There are only **three full-period V6 shorts**, all in development, so the later
check provides no new short trade evidence.

## Earlier selection and later check

The first 2,944 candles, ending 2026-09-03 23:00 UTC exclusive, select the rule on
short-only net P&L with fees on. Require at least two closed trades, no insolvency and
hourly drawdown ≤2%. The later 1,472 candles never rank candidates. Each slice resets
cash/positions to 10,000 USDT and is not additive with the full-period results.

| Short-only slice, net USDT |                     V5 |                         V6 |
| -------------------------- | ---------------------: | -------------------------: |
| SOL earlier                | −57.658882797990867599 |     +48.235993784269406362 |
| SOL later                  | +40.913622571255707773 | **+36.042014313972602743** |
| XRP earlier                |  +43.37553015196347032 |     +84.526438115388127845 |
| XRP later                  |  −15.22754077698630138 |       **0.00 — no trades** |

**SOL's later short-only performance deteriorates by 4.87 USDT despite full-period
improvement.** XRP's later improvement is loss avoidance with no short trades; it
does not validate a new profitable short opportunity. Both periods were already seen
in prior research. The hypotheses themselves are informed by seen trade diagnostics.

Combined later-slice nets also remain visible: SOL V5 +43.535065019520547969 versus
V6 +38.661846444611872148; XRP V5 +56.79721323972602739 versus V6 +72.13330452.
The later SOL combined check deteriorates too.

The registered grids contain **25 SOL profiles** (baseline plus four slope thresholds
× three short targets × trailing off/on) and **19 XRP profiles** (baseline plus two
minimum distances × three maximum distances × three short targets). All **44**
development reports remain visible, including losses, ineligible profiles and equivalent
outcomes. Selection ties prefer baseline/no trailing, then fewer trades and canonical
candidate hash. No candidate is chosen using combined or full-period profit.
Earlier V4/V5 tuning, asset selection and the untuned short extension add prior
selection bias. Replaying the same profiles is not an independent new experiment.

## Reproduction and compatibility

```powershell
pnpm short-v6 --verify
```

The command retains all 44 candidate reports, earlier/later evidence and 12 selected
V6 reports, and verifies V5/V6 across both coins, all three modes and both fee settings
(24 final replays). It restores saved fee settings afterward. Original 204 V1–V5
cells, report IDs, matrix pointers, data and settings remain intact; append 12 V6
cells for **216 cells / 36 profiles**. Reports under ignored `data/short-v6/` use
separate engine/version/plan/journal fingerprints. Native forward data gates, the
original short ledger/default model and all old engines/contracts are unchanged.

All six fee switches default on and persist separately for this comparison. They
select complete cost scenarios without retuning; turning trading fees off retains
borrowing and slippage. The local `/short-v6` API provides strict authenticated state,
matrix, run, fees, report, verification and export routes. Arbitrary profile, URL,
path, risk and borrowing assumptions cannot be supplied through a request.

The source history is real public spot data. Historical lending availability/rates
remain unknown and borrowing is still an explicit fixed research assumption. No
perpetual funding history, actual exchange short execution or future profitability
is claimed. The later evidence, small short counts and lost winners remain visible.

Completed V6 matrix:
`sha256:b314104b31d776fc8774ecad98d3062c70c31f3d703d0ed3fbb373b4aba23bad`.
V6 engine:
`sha256:bf0ed1863b2d5b2aab559406633d10f45edf75b592a91a225e77ec429d602334`.
Preserved V1–V5 directional parent:
`sha256:ed775e088375404b0c9a5fce9ecfa08aa9e1f2d30672171bfc5d6ec67820013b`.

Validation: `pnpm check` passes **1,104 tests in 60 files**, lint, formatting,
backend/web types, smoke and contracts. Production build, doctor and all 17 original
roadmap checksums pass. Nine new focused tests cover compatibility, complete registered
grids, fair parent/window/mode/cost selection, later-price invariance, short-side
signals and targets, unchanged longs, independent later-slice capital, trade-cost
attribution, report/history tampering, next-candle trailing stops and worse gaps,
strict authenticated routes and fee persistence. All 24 final V5/V6 reports and
journals replay exactly; all 204 original directional report IDs are preserved.

Live local READ-session acceptance passes **76 selected reports, all 64 fee-switch
combinations, two V6 API replays and both export types**. Four pages serve matching
ten-link server/client menus. All original matrix pointers and fee preferences remain
unchanged. The new comparison restores every V1–V6 switch on, including the saved
file, and the dashboard remains running. Browser visual automation is unavailable;
these checks do not claim an automated visual click-through test.
