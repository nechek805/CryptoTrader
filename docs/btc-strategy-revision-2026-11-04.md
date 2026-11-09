# BTC strategy revision: trade diagnosis and same-snapshot comparison

The original and revised strategies use exactly the same 4,416 real hourly BTCUSDT
candles from **2026-05-04 07:00 UTC to 2026-11-04 07:00 UTC**, end exclusive. Both
start with **10,000 virtual USDT**. No new market data was downloaded for this comparison.

## Why the original lost money

The original's 23 winning closed trades averaged +9.699582575296 USDT, while its 27
losing closed trades averaged −10.948873630507 USDT. Closed-trade profit factor was
0.754653643634: net winning-trade profit did not cover net losing-trade loss.

| Exit group                                     | Count |           Net USDT |
| ---------------------------------------------- | ----: | -----------------: |
| Protective stop                                |    22 |    −262.3197858684 |
| Profit target                                  |    21 |    +219.0763451313 |
| Bearish MA crossover                           |     7 |     −29.2857480548 |
| All closed trades                              |    50 |     −72.5291887919 |
| Open-position contribution including entry fee |     — |      +1.8266326628 |
| Portfolio net change                           |     — | **−70.7025561291** |

Thirty-two trades lasted twelve hours or less and together lost 118.7617581136 USDT.
The repeated short-lived entries are consistent with whipsaw exposure. The original
had no longer-term trend filter or minimum reward-to-cost requirement.

At the simulated fill prices, equity change before fees was +29.8439977 USDT. Charging
100.5465538291 USDT of fees gives the reported −70.7025561291 USDT. Recorded adverse
slippage of 50.2799367 USDT is already included in those fill prices. Adding back both
cost components yields +80.1239344 USDT for the same trades. This is an algebraic cost
attribution, not a new zero-cost run with different balance-dependent quantities.

## The one tested revision

Revision `btc-ma-atr.v2` retains the original crossover, exit levels, risk/quantity caps,
fees and adverse slippage. It adds three requirements before a virtual long entry:

1. A fresh bullish MA20/MA50 crossover; no automatic first-window bullish entry.
2. Close above MA200, with MA200 greater than its value 24 completed hours earlier.
3. The 3 ATR target distance must cover at least three times estimated round-trip
   costs: `2 × price × (0.001 fee + 0.0005 slippage)`. Recheck this at the next open.

The trend and slope need 224 completed hours, versus the original 50-hour warm-up.
Both warm-ups remain inside the six-month range. No leverage or short opening is added.
No parameter search was performed; one revision was tested. Original files remain intact.

## Full-period results

| Measure                           |      Original v1 |      Revision v2 |
| --------------------------------- | ---------------: | ---------------: |
| Final equity, USDT                | 9,929.2974438709 | 9,998.4375243204 |
| Net P&L, USDT                     |   −70.7025561291 |    −1.5624756796 |
| Net return                        | −0.707025561291% | −0.015624756796% |
| Maximum hourly drawdown           |  0.912746591040% |  0.391913163193% |
| Fees, USDT                        |   100.5465538291 |    22.0379188796 |
| Recorded adverse slippage, USDT   |       50.2799367 |       11.0201618 |
| Closed trades / wins              |          50 / 23 |           11 / 5 |
| Closed-trade profit factor        |   0.754653643634 |   0.976812203084 |
| BTC held at sampled hourly closes |   15.7608695652% |    3.2382246377% |
| Ending BTC                        |          0.01276 |                0 |
| Cash-only equity, USDT            |           10,000 |           10,000 |
| Costed buy-and-hold equity, USDT  | 9,505.2422845824 | 9,505.2422845824 |

The full-period loss falls by **69.1400804495 USDT**, principally with much lower turnover
and exposure. This does not establish improved directional prediction: the win rate is
23/50 versus 5/11, and the revision still has a closed-trade profit factor below one.
The hourly-close exposure measure misses positions opened and closed within one candle.
Hourly drawdown likewise can miss intrabar losses. Open BTC is marked without hypothetical
exit costs; actual exit costs are charged only when an exit is simulated.

## Chronological checks

Each check starts independently with 10,000 USDT and empty positions. Context before
the later window may form indicators but cannot create trades or change its cash.

| Window (UTC, end exclusive)          | Original net USDT | Revised net USDT | Revised closed trades / wins |
| ------------------------------------ | ----------------: | ---------------: | ---------------------------: |
| May 4 07:00 → September 3 23:00      |    −20.4801594938 |   +21.0777516490 |                        7 / 4 |
| September 3 23:00 → November 4 07:00 |    −69.1405008389 |   −22.5831055697 |                        4 / 1 |

The checks are not additive because each resets cash and positions. In the later window,
the revision's profit factor is only 0.385382292832 versus 0.510943802836 for the original.
Its smaller loss largely reflects reduced activity, not a demonstrated profitable edge.
The entire snapshot had already been observed; these are exploratory chronological
diagnostics, not an untouched holdout. No thresholds were changed after these results.
A newly frozen forward experiment is still needed before any claim of predictive skill.

## Reproduce and inspect

Run `pnpm dashboard` and open <http://127.0.0.1:3100/market-test>. The comparison appears
above the workflow. **Inspect original v1** and **Inspect revised v2** select the matching
immutable report and hourly decision player. v2 exposes MA200, its slope direction,
reward-to-cost ratio, gate results and any next-open rejection. **Run v1 vs v2 comparison**
reconstructs both strategies and the chronological diagnostics on the selected snapshot.
Use **Export comparison** and **Verify deterministic replay** for review.

With the dashboard stopped, `pnpm btc-test compare` uses the current snapshot. To reproduce
the exact snapshot used here, run:

```powershell
pnpm exec tsx apps/cli/src/btc-compare.ts sha256:9d951084a1be4d63e23fc0fd05cd149b3444348154f99f8a4e42808a2761546e
```

This command also checks the retained `data/btc-market-test/before-revision.json` against
the original run. No original report is overwritten. Evidence lives in git-ignored
`data/btc-market-test/reports/` and `data/btc-market-test/comparisons/`.

Frozen identifiers:

- Dataset: `sha256:9d951084a1be4d63e23fc0fd05cd149b3444348154f99f8a4e42808a2761546e`.
- Original: `sha256:8d894356fb14aa1f22640b6d227a3bb597ecee51b0635824ee2d6d0582639067`.
- Revision: `sha256:de93293f6a0b1df1d150129b77763a392d3185766d5169bdf1c897b68c457864`.
- Comparison: `sha256:9c05ec5209f8ae1d45abcdd4ffbd63611926ca9f36b7a4bb1c260304fe08cf22`.
- Revision plan: `sha256:453514d092e4fa49fa11214a501d883a80d833f3c32c2061e514b7767cbbdd12`.
- Revision engine: `sha256:67b8ee6119289a6cda1d5cfa52ad40d3c08797b644af8e148f0980226275545c`.

Public historical receipt availability remains UNKNOWN. All executions are virtual and
assume completed-bar knowledge and next-open fills; hourly candles cannot verify actual
order-book liquidity or historical receipt delays. The original forward-study gates remain.
