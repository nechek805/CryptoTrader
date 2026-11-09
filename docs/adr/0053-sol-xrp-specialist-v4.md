# ADR 0053 — Separate SOL and XRP v4 research

Date: 2026-11-06. Status: accepted for local retrospective research.

The user requested a new menu tab for future SOL/XRP strategy development, preserving
all other coins and earlier strategies, and separate profit-focused v4 profiles.

Add `/sol-xrp-lab` and a separate local authenticated service/artifact root. Read the
existing verified SOL and XRP snapshots from the immutable multi-market comparison.
Keep v1/v2/v3 engines, reports, datasets, original menus and fee preferences unchanged.
New contracts and a separate execution engine retain explicit coin identity, same
SpotLedger, exact-decimal calculations, next-open execution and conservative OHLC rules.
Require the specialist baseline to reproduce every original decision, fill, summary
and journal hash before comparing v4. SOL starts from v2; XRP starts from v3.

Choose parameters only on the first 2,944 of 4,416 hourly candles, with fees enabled.
Every candidate keeps risk 0.25%, allocation 10%, prior-volume participation 1%, no
leverage/shorts and the existing daily stop. Maximize development net P&L among the
registered candidates with development hourly drawdown no greater than 2%. Ties use
fewer trades, then simpler impulse/slope settings, then a stable hash. Enforce the
registered grid, one dataset, one development window and STANDARD costs in selection.

Initial grids have 12 profiles per coin. SOL varies stops 1.5/2/2.5 ATR and targets
3/4/5/6 ATR, retaining v2 gates. XRP retains v3's upper-half close and max 2 ATR range,
varying MA200 slope lookback 12/24/48 hours and targets 3/4/5/6 ATR. The initial XRP
grid did not improve on v3. Its development loss had a small signal range, so retain
that unsuccessful search and disclose 12 additional XRP profiles: minimum range
0.8/1/1.25 ATR and targets 3/3.5/4/4.5 ATR, with slope 24 hours and stop 2 ATR.
Total distinct candidates: SOL 12, XRP 24. These are hypotheses formed on seen data,
not independent trials or a claim of a global maximum.

Freeze one selected profile per coin before computing the later chronological check.
The later slice resets to 10,000 virtual USDT, uses earlier indicator context, and
starts trading only at its boundary. It was already seen in prior research and must
not be labeled independent or unseen validation. Full-period and slice returns are
not additive. Publish all candidates, negative results, cost assumptions and small
trade counts. Asset selection after seeing previous profits is another disclosed bias.

Precompute final selected profiles with fees on and off; switches do not reoptimize
the candidate. Preserve existing global/per-version fee controls in the new lab,
including v4, with independent atomically saved preferences. Slippage remains enabled.
Cache reports by content hash and publish a completed matrix pointer only after both
coins finish. Failure retains previous results. Imports are fixed local roots and
allowlisted SOL/XRP; request inputs cannot supply URLs, paths, risk or tuning parameters.
No exchange order endpoint or forward availability gate is introduced or changed.

The page includes comparisons, coin-specific diagnosis, complete development grids,
chronological checks, sources, fee controls, hour/fill inspection, exports and exact
replay. Extend sidebar scrolling for the extra menu item. Rollback restores prior code
while keeping both original data and `data/sol-xrp-lab` artifacts; never rewrite them.
