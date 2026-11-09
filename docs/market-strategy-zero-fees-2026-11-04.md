# Market strategies with trading fees excluded — 2026-11-04

At the user's request, replay the same ten six-month hourly crypto histories with
zero trading fees for every version and for buy-and-hold. Keep adverse slippage at
0.05% per side plus tick rounding. Initial capital remains 10,000 virtual USDT per
independent coin/version account. The USDT cash control remains 10,000.

The new matrix is
`sha256:7fb97b12a2a9974a21a68e37298c9f985130a9aa277b97550dd27f43b65f7627`.
Engine:
`sha256:42690b24ab88842a17fda3ea50253eccd82675ca083b99ca0eb08697ef0e09df`.
All 30 reports record ZERO fee mode and zero total fees. Each report retains its own
dataset hash, plan hash, fills, decisions, slippage and balanced journal. Data IDs and
the exact 2026-05-04 07:00 → 2026-11-04 07:00 UTC window are unchanged.

## Net P&L in virtual USDT, including slippage

| Asset     |      V1 |      V2 |      V3 |
| --------- | ------: | ------: | ------: |
| BTC       |  +30.05 |  +27.30 |  +35.32 |
| ETH       |  +24.06 |  +32.73 |   +4.83 |
| SOL       | +138.56 |  +87.23 |  +49.07 |
| TRX       |  −21.28 |   +2.99 |   +6.74 |
| BNB       |  +83.84 |  +55.09 |   +9.14 |
| XRP       | −135.46 |  +48.76 | +113.50 |
| DOGE      |  −81.72 |   −3.16 |   −5.45 |
| ADA       | −107.60 |  +22.60 |  −32.97 |
| LINK      |  +50.76 |  +18.18 |  +23.91 |
| AVAX      | −500.12 | −244.59 |  −83.67 |
| USDT cash |    0.00 |    0.00 |    0.00 |

V1 has five positive/five negative markets; v2 eight positive/two negative; v3 seven
positive/three negative. These are correlated exploratory tests, not independent
estimates of prediction accuracy. Do not sum independent account balances into a
portfolio result. Profitability under a zero-fee assumption is not evidence of
profitability with real exchange costs.

## Difference from the paid-fee run

The original paid-fee matrix remains intact:
`sha256:3b3f905bc66f62deba68edeb004b9af643ee12137532365318eaba8a432d7ba9`.
Its full table is in [the original results](market-strategy-results-2026-11-04.md).
BTC changes from −70.7025561291 / −1.5624756796 / +19.2079054528 to
+30.0547265 / +27.2966779 / +35.3156004 for v1/v2/v3 respectively.

These are actual replays, not prior results with fees added back. The v2/v3 cost gate
uses the reduced execution cost, and all versions size using zero fee overhead.
Consequently BTC v2 closes 16 trades rather than 11 and v3 closes 11 rather than 7.
TRX v2/v3 close 12/11 trades rather than 1/1. Buy-and-hold also uses zero entry fees.
Trade counts, quantities, cost-gate eligibility and later account state can therefore
change. Slippage still affects fills and reported net returns.

Original BTC engines and historical paid-fee reports remain unchanged. The service
separately reproduces their decisions, fills, summary and ledger in STANDARD mode
before publishing the zero-fee BTC row. This compatibility check is not a claim that
the new zero-fee returns equal the old paid-fee returns.

Current exchange filters, unknown historical availability, survivorship bias,
previously seen BTC history and all other research limitations still apply. See
[ADR 0051](adr/0051-zero-fee-market-research.md) and
[the testing guide](market-strategy-tests.md).
