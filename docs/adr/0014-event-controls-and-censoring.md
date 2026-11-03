# ADR 0014: Matched event controls and censored recovery

Status: accepted, 2026-11-01. Scope: Module 06, Iteration 2.

Add separate versioned controls requests/results/artifacts over the original immutable
news/market input. Share one strict exact-close price gate with Iteration 1, preserving
old artifact schemas and byte-level result identity. Controls do not introduce a trading
signal, execution mode, database migration or external data fetch.

Fit a transparent BTC one-factor model only on complete consecutive interval returns
ending one bar before the selected decision. Report beta-adjusted cumulative returns,
compounded alpha/beta expected-path residuals and opening-weight basket-relative returns
separately. Undefined fits and invalid price projections stay explicit and null.

Use a predeclared timestamp grid and seeded, event-specific sampling without replacement.
Controls share the event's complete joint universe, prehistory length, horizon and exact
availability gates. Exclude fits/outcomes overlapping observed-news response intervals,
and responses beyond the frozen news cutoff. Optional matching uses pre-event volatility
and circular UTC time only. Record candidate rejections, actual sample counts, empirical
exceedance fractions and overlapping control pairs. Corpus absence does not establish
the absence of an actual event, and these frequencies are not significance tests.

Signed lag convention is explicit: positive means BTC leads the asset. Every pair uses
two available adjacent returns entirely within its pre- or post-event segment. Post-event
correlations are descriptive, with direction, pair timestamps, known-at time, counts and
undefined/constant-series statuses. They never become pre-decision model inputs.

Recovery needs an observed below-entry close followed by an observed return to entry.
Stop at the first coverage gap. Unrecovered declines retain a right-censoring time and
reason; incomplete pre-decline coverage and no drawdown are separate states. Do not
impute durations or average only recovered cases into an all-event recovery claim.

Freeze taxonomy at each event decision and partition aggregates by exact type combination.
Concentration groups connected lineage IDs, discloses repeated/overlapping observations
and uses only measured absolute movement. This describes selected movement rather than
causality, strategy profitability or portfolio diversification. More advanced inference,
validation-period policies and hypothesis registration remain in Iteration 3.
