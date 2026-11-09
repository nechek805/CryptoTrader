# BTC v3: candle-quality filter and three-version comparison

All versions use the same real BTCUSDT snapshot: **4,416 hourly candles**,
**2026-05-04 07:00 UTC to 2026-11-04 07:00 UTC**, end exclusive, with **10,000 virtual
USDT**. No new market prices were downloaded for this revision. The v1 and v2 source
engines and immutable reports remain unchanged and reproduce under their original IDs.

## Diagnosis of the eleven v2 trades

V2 had five stop-outs returning **−64.3750906078 USDT**, four target exits returning
**+63.7726108608 USDT**, and two crossover exits returning **−0.9599959326 USDT**.
The total was **−1.5624756796 USDT**, with no open BTC. Fees were 22.0379188796 USDT;
recorded adverse slippage was 11.0201618 USDT. Both are already included in net results.

Three stops occurred within one hour. Two losing signal candles closed close to the
bottom of their hourly range; an earlier losing signal candle had a range over three
ATR. This motivated one candle-quality candidate, declared in ADR 0049 before its first
replay. The observation is based on a small, already-seen sample and does not establish
a general causal relationship.

## The fixed v3 change

Keep v2's fresh MA20/MA50 crossover, rising MA200, reward/cost gate, 224-hour context,
2 ATR stop, 3 ATR target, sizing caps, fees and adverse slippage. Require two additional
conditions on the completed signal candle:

- `(close − low) / (high − low) >= 0.5`: close in the upper half of a nonzero range.
- `high − low <= 2 × ATR14`: avoid entering immediately after an unusually large candle.

Gate comparisons use exact decimal arithmetic; ratios are rounded only for display.
Zero-range candles are ineligible. These features use the completed signal candle.
Entry remains at the following open, with the original opening-price risk/cost checks.
Future trade duration, realized profit and post-exit prices are never entry features.

No thresholds were searched or changed after the v3 result. There is one new candidate
in this iteration and two revisions cumulatively: three strategies including v1.
Replays and implementation checks of the same fixed plan are not independent trials.

## Full six-month comparison

| Measure                         |               v1 |               v2 |                 v3 |
| ------------------------------- | ---------------: | ---------------: | -----------------: |
| Final equity, USDT              | 9,929.2974438709 | 9,998.4375243204 |  10,019.2079054528 |
| Net P&L after costs, USDT       |   −70.7025561291 |    −1.5624756796 | **+19.2079054528** |
| Net return                      | −0.707025561291% | −0.015624756796% |   +0.192079054528% |
| Maximum hourly drawdown         |  0.912746591040% |  0.391913163193% |    0.224830523250% |
| Fees, USDT                      |   100.5465538291 |    22.0379188796 |      14.0537307472 |
| Recorded adverse slippage, USDT |       50.2799367 |       11.0201618 |          7.0276889 |
| Closed trades / wins            |          50 / 23 |           11 / 5 |              7 / 4 |
| Closed-trade profit factor      |   0.754653643634 |   0.976812203084 |     1.643315926588 |
| BTC held at hourly closes       |   15.7608695652% |    3.2382246377% |      2.9438405797% |
| Ending BTC                      |          0.01276 |                0 |                  0 |
| Cash-only equity, USDT          |           10,000 |           10,000 |             10,000 |
| Costed buy-and-hold, USDT       | 9,505.2422845824 | 9,505.2422845824 |   9,505.2422845824 |

V3 improves the observed full-period P&L by **20.7703811324 USDT** versus v2.
Open BTC is marked at the final close without charging hypothetical exit costs.
Hourly-close exposure misses intrabar positions, and hourly drawdown can miss intrabar
losses. This is a historical virtual result, not a demonstrated forward trading edge.

## The trades v3 skipped

| V2 entry (UTC)     |    V2 net USDT | V3 gate                             |
| ------------------ | -------------: | ----------------------------------- |
| July 5 23:00       | −12.0747374272 | Signal range over 2 ATR             |
| August 24 04:00    | +16.7787927804 | Close below the middle of its range |
| September 9 14:00  | −13.3811725300 | Close below the middle of its range |
| September 25 12:00 | −12.0813926176 | Close below the middle of its range |

The filter skipped three losers and one winner, with no additional entry times outside
the v2 set on this snapshot. Those outcomes are retrospective diagnostic evidence;
they were not used during replay. Retained trades have slightly different quantities
because preceding cash/equity histories differ.

## Previously seen chronological periods

Each period resets to 10,000 USDT and empty positions, with past-only feature context.
The period results are not additive to the full run because of those resets.

| UTC period, end exclusive            |    v1 net USDT |    v2 net USDT |    v3 net USDT | v3 trades / wins |
| ------------------------------------ | -------------: | -------------: | -------------: | ---------------: |
| May 4 07:00 → September 3 23:00      | −20.4801594938 | +21.0777516490 | +16.3936727954 |            5 / 3 |
| September 3 23:00 → November 4 07:00 | −69.1405008389 | −22.5831055697 |  +2.8107500682 |            2 / 1 |

V3 is worse than v2 in the first period and better in the later period. The later result
contains only two trades. Both periods had already been observed during diagnosis and
revision, so neither is an untouched holdout. Repeated adaptations of historical rules
can fit noise; see [Bailey et al., The Probability of Backtest Overfitting](https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf).
No probability of overfitting or statistical significance has been estimated here.

## Cost sensitivity

With the same fills and quantities, deducting one more copy of recorded fees and
slippage gives net P&L of **−221.5290466582**, **−34.6205563592**, and
**−1.8735141944 USDT** for v1, v2 and v3 respectively. This is a same-fill attribution
stress check, not another backtest with different sizing or executions. V3's small
observed profit does not survive that diagnostic. Fresh, frozen forward evidence is
required before treating it as a reliable strategy.

## Inspect and reproduce

Run `pnpm dashboard`, open <http://127.0.0.1:3100/market-test>, then use **Inspect original
v1**, **Inspect revision v2**, or **Inspect revision v3**. The comparison includes the
three result columns, v1/v2 loss attribution, skipped trades, period breakdowns and cost
sensitivity. The decision player exposes v3's candle range/ATR, close location and gate
reason. **Run v1 / v2 / v3 comparison** recomputes all three and preserves prior files.
The export contains all version fingerprints. Verify each selected report independently.

With the dashboard stopped, reproduce this exact snapshot with:

```powershell
pnpm exec tsx apps/cli/src/btc-compare-three.ts sha256:9d951084a1be4d63e23fc0fd05cd149b3444348154f99f8a4e42808a2761546e
```

The command checks `data/btc-market-test/before-v3-comparison.json` and refuses to
silently replace a changed v1 or v2 result. `pnpm btc-test compare` uses the currently
selected snapshot through the shared service. Run CLI mutations with the dashboard stopped.

Frozen identifiers:

- Dataset: `sha256:9d951084a1be4d63e23fc0fd05cd149b3444348154f99f8a4e42808a2761546e`.
- V1: `sha256:8d894356fb14aa1f22640b6d227a3bb597ecee51b0635824ee2d6d0582639067`.
- V2: `sha256:de93293f6a0b1df1d150129b77763a392d3185766d5169bdf1c897b68c457864`.
- V3: `sha256:3d6f762cc96ce80bcac5c49a9a02b380766cdd94865b32b2aafc5523e065ab8b`.
- Three-way comparison: `sha256:649811dee94ca37c1cc8b91b79943d10ff65ff347cffa80abfdc732f4b15d51a`.
- V3 plan: `sha256:449c5553a0a02233d42d5ecdab1998659c6e9a90713343524c5ec54ec4cc2abc`.
- V3 engine: `sha256:8a699e3732e4f4884ad7aa0369c7a7da493535c23813a796120d0098dedc3f80`.

Evidence is stored under git-ignored `data/btc-market-test/reports/` and `comparisons/`.
Raw provider responses, source hashes and Parquet remain unchanged. Historical receipt
availability remains UNKNOWN, with simulated next-open fills and adverse-first exits.
The forward paper system and prior frozen experiment are not promoted or rewritten.
