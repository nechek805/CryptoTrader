# ADR 0054 — Separate SOL and XRP v5 exit research

Date: 2026-11-06. Status: accepted for local retrospective research.

The user requested analysis of v4 trades, separate higher-profit v5 strategies for SOL
and XRP, preservation of all old versions, and comparison on the same history with fees
on. Preserve the original market and specialist contracts, engines, report IDs, datasets
and fee preferences. Add new v5 contracts, engine, analysis and search files, a separate
`/specialist-v5` service and `data/sol-xrp-v5` artifact root. The existing sidebar lab
defaults to V1–V5; its V4 research archive still opens the original v4 interface/service.

Reuse the completed v4 matrix and its exact public hourly snapshots. Each independent
coin/version starts with 10,000 virtual USDT. Risk stays 0.25%, allocation 10%, prior-bar
volume participation 1%, daily loss limit 2%, spot long/cash/exit only. STANDARD costs
remain 0.1% fee and 0.05% adverse slippage per side, with tick rounding. No leverage,
shorts, live orders, private keys or changes to native forward-availability gates.

The no-change v5 profile must reproduce the selected v4 parent's decisions (apart from
the added target diagnostic), fills, summary and balanced ledger. SOL keeps its v2
entry rules, stop 2.5 ATR and slope 24 hours. XRP keeps its v3 entry rules, range
0.8–2 ATR, upper-half close, stop 2 ATR and slope 24 hours. Entry ATR is ATR14.

Register before scoring 18 SOL candidates: targets 5/6 ATR crossed with trailing off
or distance 1.5/2/2.5/3/3.5 entry ATR (12); and six separate target rules choosing 3/4 ATR
when signal ATR/close is at most 0.4/0.6/0.8%, otherwise 5 ATR. A trailing candidate
raises its stop only after a completed close reaches entry + 3 entry ATR. Its stop
never decreases and applies to the following candle. The current candle's low is
checked against the previous stop first; adverse-first and worse-opening-gap rules stay.
Trailing and low-volatility rules are not combined in this grid.

Register 13 XRP candidates: unchanged v4 plus 12 rules extending its 3.5 ATR target
to 4.5/5/5.5/6 ATR when completed signal range/ATR lies between lower bound 1/1.25/1.5
and upper bound 1.8. Outside that interval keep 3.5 ATR. Carry the target chosen at
the signal close into the next-open fill, and recheck the cost gate using that target.
No future excursion, timestamp mask, later trade label or execution-candle volume is
used as a decision feature. No partial exits are introduced.

Rank STANDARD-cost candidates on the same first 2,944 of 4,416 candles only, requiring
development hourly drawdown ≤2%. Break ties by fewer trades, no additional exit rule,
then the higher XRP lower bound (fewer interventions), then canonical candidate hash.
Require the complete distinct registered grid and one dataset/window/cost mode. Freeze
the winner before calculating the later 1,472-candle check and full-period results.
Slices reset capital and positions and are not additive. Preserve every attempted
profile and its development report, including unsuccessful trailing candidates.

This round adds 31 distinct profiles to the earlier 36 specialist profiles (67 disclosed
profile evaluations, some including no-change baselines). Repeated deterministic
replays are not new hypotheses. Prior v1–v3 research and selecting SOL/XRP after seeing
their profits add further selection bias. All history, including the later check, was
already seen; it must not be called independent or unseen validation. Higher full-period
profits are descriptive, not a global maximum or evidence of future profitability.

Freeze one selected profile for both fee modes. New global and V1–V5 switches have
their own saved settings, default on; they select complete cached scenarios and never
retune or merely add fees back. Buy-and-hold uses the corresponding fee mode. Immutable
reports retain source/engine/plan/journal hashes and deterministic replay. Matrix exports
include all trials, parent matrix IDs, costs, trade changes and chronological checks.
Publish the matrix pointer only after both coins finish; errors retain prior results.

The page adds v4→v5 closed-trade comparisons matched by entry hour. A missing closed
trade is explicit, open contribution remains separate, and compounded equity can change
later quantities. Hourly excursions are diagnostic only: the high in an exit candle may
follow the exit, so they do not establish tick order or an achievable optimal fill.
Source fingerprints for v4 and earlier engines remain unchanged. Rollback uses the
original view and artifacts without deleting v5 evidence.
