# Reproducible quantitative evaluation

Module 13 consumes semantically verified paper reports and Module 08 backtests. It retains
four arms, negative outcomes, missing coverage and exact evidence references. Gross PnL
means before paid fees, after execution price impact; fees/slippage are separate. Paper
uses average-cost tranche attribution and backtests retain FIFO lots. No result authorizes
real-money execution.

## Commands

```powershell
pnpm evaluation fixture --out data/evaluation
pnpm evaluation misleading --out data/evaluation
pnpm evaluation list --root data/evaluation
pnpm evaluation verify --bundle data/evaluation/evaluation_HASH
pnpm evaluation report --bundle data/evaluation/evaluation_HASH
pnpm evaluation reproduce --bundle data/evaluation/evaluation_HASH --out data/evaluation-reproduced
pnpm evaluation run --paper paper-report.json --plan evaluation-plan.json --out data/evaluation
```

Use pinned Node/pnpm. Bundles contain exact input.json, report.json, report.md, metrics.csv,
linked evidence and hash index. Synced staging is published atomically; existing bundles
are verified, never replaced. Semantic verification rebuilds every byte, including stresses
and memo. Search retains losing/inconclusive runs. Inputs cap at 256 MiB, bundles at 512 MiB.

## Metrics and integrity

Report net/gross PnL/return, trades, win rate, average wins/losses, expectancy, profit/recovery
factors, drawdown, daily volatility, turnover, costs, timestamp-weighted exposure/time in
market, coverage, vetoes/HOLD and fill rates. Money uses exact decimals. Undefined ratios
are null/N/A, never infinity. Zero trades/losses are valid; negative equity is rejected.

Daily aggregates retain partial-day/missingness flags. Held-asset marks cannot outlive
source validity. Full drawdown/exposure is unknown for incomplete paths; observed drawdown
is a disclosed lower bound. Position duration may remain known when price is unknown.
The passive fractional comparator requires eligible common endpoints and frozen costs;
stale or legally invalid endpoints make it unknown. It does not claim executable lot fills.

## Frozen uncertainty and sensitivity

The plan freezes opportunity grid, TEST/FORWARD phase, declared search history, comparison
family, overlap/dependence blocks, minimum samples, coverage/tail/drawdown gates and scenarios
before the source period. The fixed primary comparison is NEWS_ONLY minus MARKET_ONLY.
An outcome cannot replace the primary or refit a test-period producer.

Contiguous circular day blocks resample paired daily differences. Blocks cover declared
overlap and observed holding horizons. Insufficient trades/blocks, missing common coverage,
zero variation or poor Monte Carlo tail resolution leave confidence bounds unknown.
Bonferroni intervals cover declared searches only, not hidden searches or authenticated
preregistration. Purged rolling audit splits retain an embargo covering the dependence
window. Cost/slippage/latency scenarios replay identical candidate fingerprints and source
clocks; only risk/execution changes. Higher costs may veto or change paths, which remain
visible. An entry gapped below its protective stop is vetoed.

## Attribution and memo

Show four-arm contributions, paired differences, asset/month/regime/category/volatility
strata, conflicts, calibration bindings and source failures. Unknown categories stay UNKNOWN.
Brier scores remain unknown without matched frozen-horizon labels. Timing is from the latest
required rationale availability to first fill, not claimed publication/first-public time.
Unattached original source bundles remain explicit external content-hash references.

Continue/Revise/Stop follows frozen safety, coverage, sample, tail, primary-comparison and
stress gates. Continue means more forward research. Alpha remains NOT_ESTABLISHED and
real-money authority false. New hypotheses/parameters require a new frozen experiment.

Fifteen focused tests pass. The adverse-gap/license fixture retains -61.09693233 USDT per
active arm and STOP; hash sha256:b43a6ac8cf12f7cc8d58b2ee35e591ec95b7fa6d44fdfecbc05ffa9941004ece.
The deliberately misleading profitable fixture earns +224.42362131 USDT per active arm
from one tail event and remains REVISE; hash
sha256:fa2896521015fb9e12d7370b8d4c0565ff2db28800b1d7be63912ada0ed92beb.
Both are searchable and no alpha is established. See ADRs 0034–0036. Module 14 receives
the report schema; Module 15 receives the predeclared experiment controls.
