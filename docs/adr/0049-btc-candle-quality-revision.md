# ADR 0049: One declared candle-quality revision after the v2 trade review

The user requested analysis of v2, a v3 revision and comparison of all three versions.
The original snapshot is retained: dataset
`sha256:9d951084a1be4d63e23fc0fd05cd149b3444348154f99f8a4e42808a2761546e`.
Both previous engine source files and their reports remain unchanged.

Before the first v3 replay, the declared hypothesis is to avoid weak signal closes and
large impulse candles. V2's five stop-outs returned −64.3750906078 USDT; four target
exits returned +63.7726108608 USDT. Three stops occurred within one hour. Two of those
signal candles closed near the bottom of their range; another losing entry followed a
signal candle larger than three ATR. These are observations on a small, already-seen
sample, not independent evidence of a reliable market relationship.

The sole new candidate keeps the v2 trend/crossover/cost rules, sizing, fees, slippage,
protective exits and 224-hour context. It adds two fixed requirements at the completed
signal candle: close location at least 0.5 of the low-to-high range, and total range at
most 2 ATR14. A zero-range candle is ineligible. Features use the completed signal candle;
future prices and eventual trade duration/profit cannot decide entry eligibility.
No thresholds will be searched or adjusted after observing this revision's results.

One new candidate brings the cumulative count to two revisions and three strategies,
including the original. Previously observed post-exit prices are diagnostic only and
are not features. Both chronological windows have already been reviewed, so all results
remain exploratory. Period checks reset cash and positions and do not constitute an
untouched holdout. All versions are compared on the same source snapshot and cost model.

The dashboard will retain version selection, exact replay, attribution and exports for
v1 and v2, and add v3 with its own immutable report, plan and engine fingerprints.

Result: v3 full-period net is +19.2079054528 USDT from seven closed trades. It skips
three losing v2 entries and one winning entry. Its later-period net is +2.8107500682
USDT from only two trades, and its first-period result is below v2. Same-fill doubled
recorded costs would yield −1.8735141944 USDT. The dashboard exposes these qualifications,
the cumulative trial count, each version's trace and independent deterministic verification.
No forward strategy is promoted. See [the report](../btc-strategy-v3-2026-11-04.md).
