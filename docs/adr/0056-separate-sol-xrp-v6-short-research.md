# ADR 0056 — Separate SOL and XRP V6 short research

Date: 2026-11-06. Status: accepted for local retrospective research.

The user requested diagnosis of SOL/XRP short trades, especially SOL's loss, separate
improved V6 strategies, preservation of old versions and comparison on the same history
with fees on. Preserve all frozen V1–V5 engines/contracts and their 204 directional
comparison cells, original datasets, matrix pointers, report IDs and fee preferences.
Add new V6 contracts, engine, analysis, search, local service and artifact root
`data/short-v6`. Existing `/long-short-tests` defaults to V1–V6 and a V6 research tab;
its original V1–V5 comparison remains accessible through the original component/service.

The short extension's SOL V5 has 15 closed shorts, five wins and ten losses, net
−16.978633874406392683 USDT. Actual fills earn +14.67447 before trading fees and
borrowing; trading fees 28.28199323 and borrowing 3.371110644406392683 make the net
negative. Slippage 16.02008 is already embedded in fills. Three losing trades had at
least 2.5 entry ATR of favorable excursion on full candles before their exit candle.
The diagnosis uses excursions descriptively, never as signal features or fill claims.
Shallow downtrends and overly distant targets motivate separate short-side rules.

XRP V5 has nine shorts, three wins and six losses, net +28.08323995196347031 USDT.
Its losing trades include repeated signals near MA200 and extended entries far below
it. Test a bounded distance from that average rather than copying long-only filters
without a short-specific test. Hypotheses are informed by previously seen diagnostics;
neither the earlier development slice nor the later check is independently unseen.

Register 25 SOL candidates: unchanged V5 baseline plus 24 combinations of minimum
MA200 fall over 24 hours / current ATR14 in {0, 0.5, 0.75, 1}, short target in
{2.5, 3, 4} ATR, and trailing off/on at 1.5 entry ATR. Trailing activates only after
a completed close reaches three entry ATR of profit, never from intrabar lows. Its
stop only moves down and first applies to the following candle. Preserve SOL's
2.5 ATR stop and all V5 long-side entry and target rules.

Register 19 XRP candidates: unchanged V5 baseline plus 18 combinations of minimum
(MA200 − signal close) / ATR14 in {0, 0.75}, maximum in {3, 4, 6}, and short target
in {3, 3.5, 4.5} ATR. Keep the 2 ATR stop, lower-half close, 0.8–2 ATR signal range,
falling MA200 and cost gate. XRP has no new trailing rule. Short targets are chosen
at the signal close and carried to the next-open execution; the cost gate rechecks
that chosen target. Long-side conditional V5 targets remain unchanged.

Rank only SHORT_ONLY development net P&L with STANDARD fees on the first 2,944 of
4,416 candles. Require at least two closed trades, no insolvency and hourly drawdown
≤2%. Ties prefer baseline/no trailing, then fewer trades, then canonical candidate
hash. Require the complete distinct registered grid, one frozen parent, one dataset,
one window and the correct mode/cost setting. Retain all 44 development reports,
including inferior and ineligible candidates. Replays of identical profiles are not
new hypotheses. Earlier V4/V5 tuning, asset selection and the untuned short extension
remain additional disclosed selection bias; there is no maximum-future-profit claim.

Freeze the winner before computing the later 1,472 candles and full-period outcomes
in all three direction modes. Each slice resets to 10,000 USDT, uses prior indicator
context and creates no pre-window orders. Slice P&L is not additive. Later and combined
profits never rank candidates. Publish later deterioration and zero-trade checks;
improvement on the full period is not sufficient evidence of generality.

Keep all execution assumptions and risk caps: next-open fills, adverse-first OHLC
exits and worse gaps, tick/lot rounding, 0.25% risk, 10% allocation, 1% prior volume,
2% daily loss limit, 100% short collateral and locked proceeds. Trading fees remain
0.10% per fill, slippage 0.05% plus ticks, and borrowing the same hypothetical 10%
annual simple entry-notional charge. Historical lending availability/rates remain
unknown. Preserve explicit margin/default debt and the existing stop on insolvency.
No live orders, leveraged position sizing, futures funding series or native forward
eligibility gate changes.

The no-change V6 engine reproduces V5 fills, decisions (excluding added diagnostics),
summary and ledger in all modes/costs. The selected V6 LONG_ONLY account reproduces
the V5 long-only result; combined long quantities/opportunities can change as short
timing and account equity change. Source fingerprints create distinct V6 reports.
Keep original report cells byte-equivalent and append only 12 selected V6 cells:
two coins × three modes × two cost settings, giving 216 cells and 36 profiles.

Save separate atomically written V1–V6 fee preferences, default on. The global switch
applies to every coin/mode/position in this comparison; per-version switches choose
complete cached scenarios without retuning. Publish a matrix pointer only after both
coins finish. Failed jobs retain previous completed evidence. Requests cannot supply
URLs, paths, risk overrides or arbitrary tuning profiles. The UI includes original
trade diagnostics, matched V5→V6 closed trades, all trials, earlier/later evidence,
profile descriptions, unchanged long comparisons, sources, exports and exact replay.
