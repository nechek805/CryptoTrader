# SOL and XRP strategy lab — 2026-11-06

Run `pnpm dashboard` and open <http://127.0.0.1:3100/sol-xrp-lab>, or choose
**SOL & XRP strategy lab** in the sidebar. All earlier coins and tests remain in
**Market strategy tests**. The new lab reads their existing verified SOL/XRP snapshots
and writes its own reports and preferences under ignored `data/sol-xrp-lab/`.

Use Results for v1/v2/v3/v4 comparisons, Why & v4 profiles for diagnosis, Candidate
search for every trial and the selection protocol, Trade explorer for hourly decisions
and actual simulated fills, and Sources for research assumptions and export links.
Global/per-version fee controls apply to both coins; these preferences are independent
of the earlier multi-coin page. Fees default on at 0.10% per side. Off means zero;
adverse slippage always remains 0.05% per side plus tick rounding. Switching fees uses
the already selected profile and never retunes it.

## Full-period results, fees and slippage included

Each cell starts with its own 10,000 virtual USDT, using the same 4,416 real hourly
candles from 2026-05-04 07:00 UTC to 2026-11-04 07:00 UTC, end exclusive.

Completed research matrix:
`sha256:b6fe7acc4f6ec7c53d8c65456e6167e8b875a9e817d2ff429636e506dd8c336c`.
Specialist engine:
`sha256:3d58b6b62be33aae0368e6148b2f22b423c634877458d9a50ea42d1af35590c1`.
Original multi-coin comparison remains
`sha256:52109b3107a2e00609e3068b59ce3799af3d8a211d116d591c792de8c2e72ef4`.

| Coin | v1 net USDT | v2 net USDT | v3 net USDT | v4 net USDT |
| ---- | ----------: | ----------: | ----------: | ----------: |
| SOL  |      +41.89 |      +50.84 |      +31.59 | **+126.48** |
| XRP  |     −235.91 |      +37.04 |     +103.92 | **+128.69** |

With fees off, the same selected v4 profiles return SOL +166.96119 and XRP +137.27262
USDT; slippage still applies. No separate fee-free optimization was performed.

SOL v4 selects a 2.5 ATR stop and 5 ATR target from the v2 base, retaining a 24-hour
MA200 slope lookback and avoiding the v3 close-location gate. Its full result is
126.48422578 USDT with 16 closed trades and seven wins; hourly drawdown is about
0.6581%. Its risk/allocation caps are unchanged. A wider stop reduces quantity when
the risk cap binds; more capital or leverage is not the source of the improvement.

XRP v4 keeps the v3 upper-half close and maximum 2 ATR signal range. It additionally
requires a minimum 0.8 ATR signal range and uses a 3.5 ATR target, with the original
2 ATR stop and 24-hour MA200 slope lookback. Full net is 128.68579954 USDT, four closed
trades/four wins, and roughly 0.0502% hourly drawdown. Four winning trades are a very
small sample and do not establish a repeatable future edge.

## Why the coin profiles differ

XRP v3 retained four winning v2 entries while rejecting three losing entries. In the
earlier development slice, v3 had two winning trades and one small losing crossover
exit. That loss's signal candle had range about 0.71 ATR, versus roughly 1.95/1.66 ATR
for the two winners. This motivated an explicit minimum-impulse hypothesis. The
selected 0.8 ATR minimum removes the quiet entry, and the 3.5 ATR target increases
the selected winners' payoff in this historical sample.

SOL v3 filtered out four winners from v2 along with several losers; its reduced
activity did not improve net profit. The selected SOL v4 keeps v2's broader entry
eligibility and improves stop/target distances instead. The page derives exclusion
counts and net contributions from original trade records; later quantities can differ,
so those excluded-trade totals are diagnostics rather than exact counterfactual P&L.

## Development selection and later chronological check

Development: 2026-05-04 07:00 → 2026-09-03 23:00 UTC (2,944 candles).
Later check: 2026-09-03 23:00 → 2026-11-04 07:00 UTC (1,472 candles).
Each slice resets to 10,000 USDT and preserves only earlier indicator context. These
slice returns are not additive to reconstruct the continuously compounded full run.

| Coin             | Earlier baseline | Earlier v4 | Later baseline | Later v4 |
| ---------------- | ---------------: | ---------: | -------------: | -------: |
| SOL, baseline v2 |           +66.89 |    +123.83 |         −15.95 |    +2.61 |
| XRP, baseline v3 |           +42.59 |     +56.14 |         +61.07 |   +72.13 |

SOL's later improvement is only 2.61179711 USDT and seven closed trades; XRP's later
result uses two winning trades. The later history was already seen in earlier research.
This is an exploratory chronological check, not independent forward validation.

The initial bounded search used 12 profiles per coin. It improved SOL but found no XRP
improvement. Twelve additional XRP minimum-impulse/target profiles were explicitly
added using the development diagnosis; all initial trials and the expanded 24-profile
XRP grid are retained. Selection uses highest development net P&L, fees on, fixed risk
and a 2% development hourly drawdown ceiling. No later-check or full-period return is
used to choose the profile. This is best within that disclosed grid, not a mathematical
or future maximum. Choosing SOL/XRP after observing their prior results adds bias.

## Reproduction and API

`pnpm specialist-tests --verify` reruns the disclosed search and verifies every final
SOL/XRP/version/fee-mode report (16 selected reports), restoring saved fees afterward.
Reports are immutable at `data/sol-xrp-lab/reports/<hash>.json`, matrices at
`matrices/<hash>.json`, with a mutable completed `latest.json` pointer. Original
v1/v2/v3 report IDs are reused from `data/market-strategy-tests`. New report source
fingerprints, plan hashes, dataset IDs and replay windows identify the v4 runs.

The authenticated local API adds GET `/specialist-tests`, GET `/specialist-tests/matrix`,
POST `/specialist-tests/run` with `{}`, POST `/specialist-tests/fees` with a strict
`fees` map for V1–V4, GET `/specialist-tests/report?asset=SOL&strategy=V4`, POST
`/specialist-tests/verify` with `{"asset":"SOL","strategy":"V4"}`, and matrix/selected
report exports. Only SOL/XRP and V1–V4 are accepted; arbitrary providers, URLs, risk
overrides and tuning parameters cannot be submitted. Jobs are bounded and local-only.

Unknown historical first-availability, current tick/lot filters applied retrospectively,
OHLC fill assumptions, cost sensitivity, cash/benchmark exposure differences and small
samples remain visible. No real-money, short, leverage, funding or maker-queue claim
is introduced. See ADR 0053 for the isolation and compatibility decisions.

## Verification

`pnpm check` passes 1,066 tests in 54 files, lint/formatting, backend/web typechecks,
smoke and contracts. Production build, doctor and the 17 original roadmap checksums
pass. The CLI verifies all 16 final coin/version/fee-mode reports exactly. Authenticated
local acceptance checks all 16 fee-switch combinations, both v4 fee-mode replays,
development selection, exports and both old/new pages returning 200. The original
matrix and fee preferences are unchanged. Browser automation is unavailable, so no
visual browser acceptance is claimed. The owned dashboard remains running for review.
