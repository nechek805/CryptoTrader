# Independent strategy isolation

Module 11 Iteration 1 collects immutable canonical candidates into BASELINE, NEWS_ONLY,
MARKET_ONLY and FUSION portfolios. Each portfolio has a distinct deterministic identity
and the same declared initial virtual capital, currency, opportunity grid, snapshot,
fees and execution assumptions. The baseline is cash. These are candidate portfolios;
balances, positions, fills and portfolio performance are not produced in this iteration.

## Offline commands

Use pinned Node 24.22.2 and pnpm 10.34.9, following the Windows runtime instructions
in the root README. The fixture is entirely synthetic and credential-free:

```powershell
pnpm fusion fixture --out data/fusion-synthetic.json
pnpm fusion verify --report data/fusion-synthetic.json
pnpm fusion run --input data/fusion-input.json --out data/fusion-replayed.json
```

The output parent must already exist. `fixture` without `--out` prints the complete
report under `artifact`. A saved report's `input` is the versioned input for `run`.
Output files use exclusive creation; an existing path is rejected. Verification parses
the strict schema and rebuilds the report, all candidate decisions and the hash chain.
Repairing checksums after modifying a decision does not make it valid. CLI inputs are
limited to 16 MiB. Fixture CLI reports bind the current implementation's working-tree hash;
recorded replay retains the input code version. No new dependency, SQL migration or earlier
schema change is needed.

The fixture has three windows: contradictory news/market candidates produce HOLD;
agreement produces one fusion LONG despite repeated component candidates; one explicit
component HOLD makes default fusion HOLD. It creates zero orders. Synthetic decisions
are diagnostics and do not establish incremental edge or trading readiness.

## Freeze and producer boundary

`FusionPlanSchema` declares the complete opportunity grid, common assumptions, three
producer identities/configuration hashes, code version, seed and versioned policy. Each opportunity fixes
its ID, symbol, decision time, feature cutoff, horizon, expiration and prefix snapshot
hash. Windows must be chronological, complete and unique by symbol/decision time.
The policy records a historical TRAIN interval, dataset hash, selection report hash,
report availability and freeze timestamp. Selection evidence must be available by the
freeze, strictly before every decision. TEST selection is rejected. Freeze the plan's
canonical hash before running the decision cohort.

`collectFusionRun(plan, producers)` accepts three synchronous, trusted in-process ports.
Bind each port to its own existing news/market provider instance and its own state;
baseline supplies cash HOLD. Each callback receives only its own arm identity, one
deeply frozen opportunity and deeply frozen common assumptions. It receives no sibling
candidates, positions, PnL, outcomes or mutable account object. Each returned submission
is immediately parsed into a separate copy before another callback runs. The collector
owns no shared strategy state and never copies positions or outcomes between arms.
Arbitrary trusted callback closures are not sandboxed; adapters must not capture other
arms' private state. External source text is never executable producer code.

`runFusion(input)` accepts recorded submissions for deterministic replay. Each submission
attests the same prefix snapshot and execution assumptions. Canonical candidates must
match their declared producer, portfolio, opportunity, decision clock and horizon;
equivalent seconds/minutes horizons are compared exactly. Their code version, seed, fee hash,
producer configuration and dataset references must match the frozen declarations. Earlier cutoffs and shorter
validity remain possible; fusion takes the earliest component expiration. Candidate
generation time cannot be after the decision. Every rationale requires a content hash
and availability reference no later than its candidate cutoff. Evidence must be ELIGIBLE,
with OBSERVED or ARCHIVED_CAPTURE availability and the cohort's explicit SYNTHETIC/RESEARCH
origin; descriptive, estimated or unknown availability cannot enter fusion. Shared evidence
identities cannot change their contents or timestamps between arms/windows. Upstream source and
model artifacts remain responsible for validating the referenced content and causal
input prefix. References and timestamps do not authenticate a provider or prove that
an external historical report was honestly registered before its stated freeze.

Exact duplicate candidates within an arm collapse to one, with duplicate counts retained.
Conflicting duplicate IDs, reused identities across arms, and multiple distinct candidates
for an arm/window are rejected. Missing submissions become explicit cash/HOLD candidates
with `missingArms` recorded. Missing news or market always forces fusion HOLD. All
component candidates remain unchanged and separately identifiable in the report.

## Versioned policies

| Policy                       | Behavior                                                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| AGREEMENT_ONLY (default)     | Both components must emit the same non-HOLD side.                                                                                                |
| DISAGREEMENT_HOLD (opt in)   | Opposite sides abstain; one explicit directional candidate plus one explicit HOLD may pass. Missing input still abstains.                        |
| WEIGHTED_CALIBRATED (opt in) | Both directional components require compatible, known calibration and weighted support above the frozen threshold. Opposite sides still abstain. |

The illustrative defaults are equal news/market weights and a 0.25 minimum weighted
support. Both weights and the threshold must be positive. For each component, support
is `sideSign * (2 * p - 1)`, requiring `p > 0.5`. The weighted score uses decimal
arithmetic, `newsWeight * newsSupport + (1 - newsWeight) * marketSupport`.

`p` must be an explicitly KNOWN calibrated probability of a positive **net** return
in the candidate's direction for the same horizon. Its model version must match a
referenced calibration artifact from TRAIN or VALIDATION, whose sample period ended
before artifact availability, available by policy freeze and candidate cutoff. This
does not convert factual confidence, conditional mean returns or arbitrary rule scores
into calibrated probabilities. Current conservative news rules have no such probability
and therefore abstain under this policy. Fusion's own calibration remains MISSING;
combining probabilities does not create a newly calibrated predictive model.

Every output includes its deterministic reason. Fusion references both component IDs
and the policy hash. The report retains the exact input, per-arm candidates, source
references, common assumptions, input/policy hashes and a chained window journal.
No ordering, sizing, stop execution, costed performance or improvement claim is inferred
from agreement or a positive weighted score. Execution is DISABLED and promotion is
NOT_AUTHORIZED.

## Handoff

Next is Module 11 Iteration 2: deterministic risk gates, stops/position policies, sizing,
kill switch, loss/exposure/liquidity controls and failure tests. It receives each arm's
own immutable candidate plus the frozen common assumptions; it must not turn component
candidates into additional fusion orders. Paper-broker accounts and ledger state remain
Module 12. See [ADR 0028](adr/0028-isolated-candidates-and-frozen-fusion.md).
