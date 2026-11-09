# Multi-asset v1/v2/v3 market research — 2026-11-04

Ten actual public Binance crypto/USDT histories, 4,416 hourly candles each, cover
2026-05-04 07:00 UTC to 2026-11-04 07:00 UTC (end exclusive). Each of the 30 runs starts
with its own 10,000 virtual USDT. USDT cash is displayed separately at 10,000 throughout.
No threshold was fitted or changed for this comparison. All 30 reports reproduced
exactly with `pnpm market-tests --verify`, including decisions, fills and balanced journals.

Completed matrix:
`sha256:3b3f905bc66f62deba68edeb004b9af643ee12137532365318eaba8a432d7ba9`.
Engine:
`sha256:a65b40dbba3c2829971a73e659ec1f723049e7002ecc8f1a828c272dc9e3f123`.
Reference original BTC snapshot:
`sha256:9d951084a1be4d63e23fc0fd05cd149b3444348154f99f8a4e42808a2761546e`.
Artifacts are retained under ignored `data/market-strategy-tests/`. Matrix cells link
their own immutable report IDs; each report links its own coin-specific dataset ID.

## Net P&L in virtual USDT, after recorded costs

| Asset     |      V1 |      V2 |      V3 | Closed trades V1 / V2 / V3 |
| --------- | ------: | ------: | ------: | -------------------------- |
| BTC       |  −70.70 |   −1.56 |  +19.21 | 50 / 11 / 7                |
| ETH       |  −83.31 |   −7.73 |  −13.17 | 53 / 19 / 9                |
| SOL       |  +41.89 |  +50.84 |  +31.59 | 45 / 16 / 7                |
| TRX       | −101.08 |   −7.95 |   −7.95 | 48 / 1 / 1                 |
| BNB       |   −6.26 |  +27.77 |  −12.04 | 45 / 13 / 10               |
| XRP       | −235.91 |  +37.04 | +103.92 | 55 / 8 / 5                 |
| DOGE      | −108.18 |   −7.16 |   −7.26 | 63 / 9 / 4                 |
| ADA       | −164.49 |  +10.60 |  −37.29 | 54 / 11 / 4                |
| LINK      |  −46.38 |  −10.80 |   +9.86 | 50 / 16 / 8                |
| AVAX      | −595.02 | −266.65 |  −92.61 | 63 / 17 / 7                |
| USDT cash |    0.00 |    0.00 |    0.00 | 0 / 0 / 0                  |

Each row/version is an independent account, not a component of a shared portfolio.
Do not sum the results into a claimed portfolio return. Full precision and costed
buy-and-hold, cash, exposure, fees, adverse slippage, marked open position and hourly
drawdown are in the matrix. The UI and selected exports expose exit-group attribution,
average winning/losing trades, open contribution, hourly gate states and actual fills.

V1 has one profitable and nine losing markets with 526 closed trades across separate
accounts. V2 has four profitable and six losing markets, 121 closed trades. V3 has four
profitable and six losing markets, 62 closed trades. These counts are descriptive;
correlated assets are not ten independent validations or a prediction-accuracy metric.

## What the comparison shows

The original BTC outcomes remain exactly −70.7025561291, −1.5624756796 and
+19.2079054528 USDT. The generic BTC runner compares every decision, fill, summary
and journal against the original engines before marking that row complete. Original
BTC reports and earlier comparison IDs remain unchanged.

V2's trend/cost gates reduce activity and recorded friction, but do not prevent losses
in weak trends. V3 reduces activity further and sometimes helps (BTC, XRP and LINK),
but also rejects profitable opportunities: SOL's v2 earns more than v3, while BNB and
ADA turn from positive v2 runs to negative v3 runs. ETH remains negative for all versions.
The page therefore describes intended improvements separately from measured results.

AVAX remains negative even after both revisions. TRX's v2/v3 each close just one trade;
a tiny activity count is not strong evidence. XRP's positive v3 has only five closed
trades, so its larger profit is also fragile evidence. A profitable BTC v3 did not imply
that the same rule would be profitable on every coin.

Interpret per-asset losses with the selected report: closed stop/crossover/target
groups reconcile to closed P&L, and open contribution reconciles the remainder.
Recorded cost drag can explain a loss when the same-fill pre-cost figure was positive;
when that figure is negative the price moves themselves were insufficient as well.
The pre-cost diagnostic is accounting on recorded fills, not a new cost-sensitive replay.

## Evidence limits

These are previously captured historical candles and simulated spot long/hold/exit
executions. First-availability timestamps remain UNKNOWN. Current exchange metadata
is applied as static research precision/notional assumptions, not historical rules.
The asset list is fixed among currently available coins, with survivorship bias and
shared market regimes. V2/v3 were designed after seeing the BTC period. No independent
forward-validation, optimal-strategy or real-money recommendation follows from this table.

Source downloads, exact decimal Parquet, all strategy versions, losing results and
report hashes are retained. See [the testing guide](market-strategy-tests.md) and
[ADR 0050](adr/0050-multi-asset-market-strategy-tests.md) for the data, execution and
persistence assumptions.
