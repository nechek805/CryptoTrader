# ADR 0015: Versioned hypotheses and temporal research handoff

Status: accepted, 2026-11-01. Scope: Module 06, Iteration 3.

Add immutable versioned cards and a self-contained registry artifact over verified news
snapshots and existing market bars. Per-card revision chains preserve authors, reasons,
recording times and old content; atomic no-replace files and semantic replay preserve
the old report lineage. Hashes provide integrity rather than proof of real historical
pre-registration. Existing study/control formats and database schemas are unchanged.

Selection/validation overlap, shared event lineage across phases and a card revision
recorded after validation starts require explicit reuse disclosure. Disclosed reuse is
exploratory. Response windows must fit within their declared period and use only prices
available at each close. Temporal news context is replayed at each observation decision.
Unknown/estimated first-seen archives have a literal descriptive-only variant and stay
out of measured returns, confidence intervals and tradable research inputs.

Report raw/complete/quarantined counts and connected lineage/overlapping-window units.
Estimate the mean of unit means with seeded block-bootstrap percentile intervals, using
Bonferroni nominal levels across all displayed card phases. Require at least three
units and disclose that conditional bootstrap coverage, independence and population
generalization are not established. Retain flat and contradictory examples. Synthetic
support, insufficient data, negative findings, inconclusive results and reuse have
distinct computed statuses. Author state does not assert successful validation.

Causal wording requires a declared causal design and justification; the observational
engine still requires causal review and does not endorse identification. No causal card
enters News Strategy handoff. Handoff matches registered card versions at each event's
own decision, carries only known news context/provenance and defaults to HOLD. Returns,
intervals, future revisions and final findings never become historical features. Semantic
handoff verification is required before a downstream consumer trusts eligibility.

Module 06 ends with synthetic exchange-outage, rate-announcement and listing reports,
a machine-readable registry and a gated News Strategy research dataset. It creates no
strategy, order, broker mode or automatic SHORT rule.
