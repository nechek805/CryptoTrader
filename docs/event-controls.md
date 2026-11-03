# Cross-asset and event controls

Module 06, Iteration 2 adds descriptive controls to the exact-close event study. There
are no strategies, trading signals or execution. Correlation and lead/lag relationships
do not establish causality or executable forecasts. Keep the explicit selection and
coverage qualifications with exported results.

## Commands

Use the pinned Node 24.22.2 and pnpm 10.34.9 runtime described in the README:

```powershell
pnpm study controls-fixture
pnpm study controls-verify --artifact 'data/event-controls/event-controls_<printed hash>.json'
pnpm study controls-report --artifact 'data/event-controls/event-controls_<printed hash>.json'
pnpm study controls-serve --artifact 'data/event-controls/event-controls_<printed hash>.json' --port 3011
```

The fixture is entirely synthetic and reproducible. The report prints Markdown with
adjustments, empirical baseline counts, fit parameters/cutoffs, source identities,
directional lag tables, censored recoveries, taxonomy and concentration. The immutable
JSON also retains exact pair timestamps, selected/excluded bar IDs, candidate decisions,
original source manifests, input/config hashes and software version. Controls artifacts
have their own `event-controls-artifact.v1` schema and filename namespace. Publication
syncs a staging file and atomically refuses replacement; verification recomputes both news
semantics and the analysis. File size is bounded to 64 MiB. There is no new SQL migration.

To change a frozen request without changing evidence, export its request as JSON:

```powershell
$controlsArtifact = Get-Content 'data/event-controls/event-controls_<hash>.json' -Raw | ConvertFrom-Json
$controlsArtifact.result.request | ConvertTo-Json -Depth 30 | Set-Content 'data/event-controls/request.json' -Encoding utf8
pnpm study controls --artifact 'data/event-controls/event-controls_<hash>.json' --request 'data/event-controls/request.json'
```

`controls --artifact` also accepts an original verified `event-study_<hash>.json` and
uses its frozen evidence. The new request selects a single horizon; run separate
predeclared requests for other horizons. Inputs are local verified artifacts only;
providers are never contacted. Old `event-study-artifact.v1` schemas and results remain
unchanged; a regression check reconstructs the previous iteration's exact artifact hash.

`controls-serve` explicitly binds a separate loopback service. POST the JSON request to
`/research/event-controls`. Strict Zod input/output validation, a 16 KiB request limit,
generated request IDs, no-store headers and sanitized errors match the original study
API. The health API continues to describe fixture readiness. Both request JSON files
and API bodies are bounded to 16 KiB.

## Request and data policy

`EventControlsRequestSchema` in `packages/contracts/src/event-controls.ts` is the binding
public contract. The fixture's exported request is a complete editable example:

| Field                                | Meaning and limits                                                                                                                                                   |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `study`                              | Existing `event-study-request.v1`: explicit events/decisions, source/instrument asset list, interval, clock, analysis/generation cutoff and assumed round-trip costs |
| `horizonSeconds`                     | 60, 300, 900, 3600, 14400, 86400, 259200 or 604800; must be a whole number of declared intervals                                                                     |
| `fitLookbackBars`                    | 3–1000 consecutive interval returns; fit ends one interval before the selected event decision                                                                        |
| `factor`                             | Explicit source/instrument for the declared BTC market factor; no automatic source substitution                                                                      |
| `basket`                             | 1–10 distinct instruments with positive integer basis-point weights summing exactly to 10,000                                                                        |
| `lags`                               | Up to 11 distinct signed lags, each -20 to +20 bars                                                                                                                  |
| `controls.from/to/strideSeconds`     | A predeclared inclusive grid of 1–256 timestamps, with stride a positive multiple of the study interval                                                              |
| `controls.sampleCount/seed`          | 1–32 samples without replacement, using versioned Mulberry32                                                                                                         |
| `controls.blackoutSeconds`           | Additional symmetric margin around news/selected-event response windows                                                                                              |
| `controls.timeOfDayToleranceSeconds` | Optional circular UTC time-of-day distance, 0–43,200 seconds; null disables matching                                                                                 |
| `controls.volatilityTolerance`       | Optional nonnegative decimal string: absolute difference in pre-window BTC realized volatility; null disables matching                                               |
| `taxonomyFilter`                     | Empty for all; otherwise retain observations with any selected frozen ontology type                                                                                  |

All prices use the shared original gate: exact closes, defensible availability at each
bar's own simulated close decision, bounded by analysis cutoff. Estimated, descriptive,
late, stale, ambiguous or gapped data cannot be promoted into a complete path. Fit and
lag returns require genuinely adjacent bars; gaps never become a multi-interval return.
Private 256-digit decimal arithmetic is rounded half-even to 36 fractional digits.
Requests are limited to 250,000 inspected price points plus attempted lag pairs; larger
designs must be split into explicitly recorded smaller studies. The original horizon,
cost, source and asset-selection assumptions remain visible in the nested study request.
Its benchmark field is retained for compatibility; controls adjustments use the explicit
`factor` and `basket` fields instead.

## BTC factor and basket adjustment

For decision `t` and interval `d`, training closes cover
`[t - (fitLookbackBars + 1) * d, t - d]`. No return ending at or after the event decision
fits the model. Training requires complete paired asset/BTC paths and nonzero BTC
variance. Ordinary least squares fits interval simple returns `asset = alpha + beta * BTC`;
alpha is the intercept, not a profitability claim. The report preserves coefficients,
paired sample count, cutoff and evidence IDs. Missing fit coverage and zero variance
produce explicit statuses and null coefficients.

`btcBetaAdjustedReturn` is asset cumulative gross return minus beta times BTC cumulative
gross return. `marketModelAdjustedReturn` subtracts the compounded expected interval
path: `product(1 + alpha + beta * BTC interval return) - 1`. Nonpositive projected price
multipliers are flagged `INVALID_PROJECTION`, with a null market-model result. These
are descriptive one-factor residuals without causal or performance interpretation.

The basket is fixed opening weights times each constituent's cumulative gross return;
it is not rebalanced each bar. Relative return subtracts that basket return from asset
gross. A missing constituent leaves basket and relative return null; weights are never
silently renormalized. Explicit inclusion of an analyzed asset in its own reference
basket should be disclosed when interpreting results.

## Random comparison baseline

The grid is declared before sampling. For every event, candidates use the same horizon,
interval, pre-fit length and **joint complete-case universe** of all analyzed assets,
BTC and basket constituents. A missing event cohort produces no baseline. A candidate
with any missing training/response path is excluded; complete selected controls have
the same number of usable observations as the event. This conservative policy can
exclude otherwise complete individual assets and creates a disclosed coverage-selection
effect. No missing move is replaced by zero.

Blackouts include every news observation in the frozen graph known by analysis time
and all requested event decisions. Each spans `[news time - margin, news time + horizon

- margin]`; no candidate's fit or outcome interval may intersect it. Responses beyond
  the frozen news snapshot cutoff are excluded. This is retrospective corpus exclusion,
  not a predictive feature and **not proof of a news-free world**. Unobserved events,
  incomplete collection and delayed receipts can still contaminate controls.

Optional time-of-day matching uses circular UTC nanoseconds. Optional volatility matching
uses only the BTC training window, with unannualized sqrt(sum(log returns squared)). No
post-event return or recovery magnitude chooses a control. Eligible candidates are
shuffled using Mulberry32 and sampled without replacement. Each event seed is the root
seed XOR the first 32 bits of the canonical hash of its `{eventId, decisionAt}` selection;
the derived unsigned seed is stored. Reordering selections or taxonomy drill-down does
not perturb another event's sample. The artifact records every candidate status,
selected timestamp, training volatility and complete evidence IDs.

For each asset the baseline reports `count(|control gross| >= |event gross|) / N`, using
the same 36-digit reported precision for both magnitudes. No selected controls means
null frequency. These are empirical sample fractions, not p-values, confidence bounds
or population estimates. Overlapping sampled outcomes are counted explicitly; neither
nonoverlapping controls nor events are assumed statistically independent. Negative
findings and matching failures remain in the report.

## Lead/lag, recovery and concentration

Lag correlations are separate for the pre-event fit and post-event response segments.
For lag `k`, pair BTC return ending at `u` with asset return ending at `u + k*d`.
Positive `k` means **BTC leads the asset**, negative means **asset leads BTC**, zero
is contemporaneous. Both adjacent-return inputs must be available at their respective
close decisions; pair known time is the later close. Segments never borrow observations
across their boundaries, and post-event pairs remain bounded by analysis cutoff.
Pearson correlation needs at least three pairs and nonzero variance. Sample counts and
timestamps accompany each lag. Post-event correlations are retrospective descriptions,
never features available at the event decision. Searching several lags introduces
multiple-comparison bias; no significance is asserted here.

Recovery is close-based: first observe a close strictly below the entry close, then a
subsequent close at or above entry. `recoverySeconds` measures seconds from the selected
event anchor, not from the first below-entry close. `NO_DRAWDOWN` has no recovery duration.
An observed decline without observed recovery is `RIGHT_CENSORED`, with a null recovery
duration, last continuous observation and `HORIZON_END`, `ANALYSIS_CUTOFF` or `DATA_GAP`
reason. Data after the first gap cannot establish recovery. Missing entry or incomplete
coverage before any decline has its own status. No average over recovered cases is
presented as the recovery time for all cases; no survival estimator is claimed.

Taxonomy is rebuilt only from claims known at each selected event decision. Drill-down
groups exact sorted type combinations, so mixed types do not double-count aggregate
groups. Reports retain observation, unique event ID and complete response counts.
Movement concentration sums observed absolute gross returns across selected assets and
observations; connected shared lineage IDs form one group. Group shares, largest share
and Herfindahl concentration describe that selected movement mass, not portfolio risk
or market-cap concentration. Missing movement is null; genuine flat movement is zero,
and zero total movement has undefined shares/HHI. Repeated event IDs and overlapping
event outcome windows are counted rather than treated as independent evidence.

## Acceptance fixture and handoff

The fictional BTC/ETH training returns give ETH alpha zero and beta exactly two. Over
the five-minute response, ETH moves +0.1 while BTC is flat and SOL moves -0.1. A 50/50
BTC/SOL basket returns -0.05; ETH basket-relative return is +0.15 and beta-adjusted return
+0.1. Its compounded market-model residual is approximately 0.101389898989899. ETH
recovers at +240 seconds. SOL is explicitly right-censored at +300 seconds; later prices
do not turn that horizon-specific observation into a completed recovery. Flat BTC
event response and control exceedance frequencies retain the negative comparison
evidence; the event label does not imply an abnormal move across all assets.

Iteration 2 ends with these descriptive results. Next is Module 06, Iteration 3:
hypothesis cards/registry, period separation, statistical uncertainty and sample reports.
No hypotheses, validation claims, trading rules or automatic SHORT instructions are
created by this iteration.
