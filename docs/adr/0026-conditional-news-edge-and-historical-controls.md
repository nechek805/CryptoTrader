# ADR 0026: Conditional news edge with historical matching and chronological gates

Status: Accepted. Date: 2026-11-01. Scope: Module 10 Iteration 2.

Training and inference bind the same news grouping and novelty policy fingerprint.
Changing those feature definitions requires new estimates rather than reusing a cohort.

Estimate simple conditional block means instead of introducing an opaque text or market
model. Reuse Module 06's validated news observations and exact-close event-study price
paths. Keep prices restricted to historical outcomes and controls. The operational producer
uses frozen estimates and news-only context, preserving independence from market/baseline
producers. It retains Module 10 I1's news admission and separate freshness veto.

The versioned plan freezes direction/horizon search, taxonomy/series/recurrence strata,
decision lag, benchmark, pre-news matching, non-event anchors, sample thresholds, costs,
uncertainty and multiplicity before training. Materialize only the known fitting prefix.
Descriptive-only events remain quarantined with null labels. Purge complete pre/outcome
windows at period edges and forbid cross-phase lineage or price/control reuse.

Use unit-beta benchmark subtraction plus matched non-event excess returns to address
prevailing drift and baseline distributions. Match pre-news relative movement only in
historical analysis; never request a live pre-price feature. Separate repeated patterns
from first-seen events. These controls do not identify causation or undiscovered news.

Shared lineage, controls, bar IDs and overlapping windows form connected blocks. Jointly
bootstrap gross and excess block means; nominal multiplicity counts all hypotheses,
horizons, metrics and phases, including failed attempts. Inadequate independent blocks or
bootstrap tail resolution must abstain. Intervals describe conditional mean uncertainty,
not factual confidence, population guarantees or individual event forecasts.

Choose sign/horizon on TRAIN alone, using the worse gross/excess bound after cost and a
nonzero uncertainty buffer. Check that fixed choice in later VALIDATION without fallback.
Inference reports the validation cohort's conditional magnitude and mean intervals,
both cohorts' counts and vintage. It rejects decisions before model availability and
abstains outside the fitted news scope/delay or below current conservative cost bounds.
Validation is a gate; later untouched evaluation is still required.

Persist self-contained content-addressed models via synced no-replace atomic files.
Semantic verification rebuilds every fit and control, including exclusions/negative
results. Imported model objects cannot bypass verification; only locally constructed,
deeply frozen instances are cached by identity. Existing artifacts and SQL are unchanged.
Synthetic source/price evidence remains diagnostic, never promotion or real execution.

Module 10 Iteration 3 owns adversarial explanations/replay and time-separated incremental
value testing. No fusion, risk sizing, paper broker promotion or live order API is added.
