# ADR 0028: Isolated candidates and frozen fusion policies

Status: Accepted. Date: 2026-11-03. Scope: Module 11 Iteration 1.

Collect the existing canonical candidate contract into four separately identified arms
on one predeclared grid and common snapshot/execution assumptions. Use cash as the simple
baseline. Portfolio identities and capital commitments do not create broker balances or
simulate trades. Store exact input and immutable per-window results in a new versioned
report; no SQL migration or earlier artifact format changes.

Trusted synchronous producer ports receive only their own arm identity, an immutable
opportunity and immutable shared assumptions. The coordinator provides no portfolio state,
outcome or sibling-output capability. Producers own their own upstream provider/state;
closures are not a security sandbox. Clone each submission immediately. Source/model
artifact verification remains an upstream responsibility; preserve all evidence hashes,
availability references and candidates for downstream audit.

Require historical TRAIN-only selection receipts available before policy freeze and
strictly before the decision cohort. Hash the frozen policy and complete plan. Receipts
are provenance declarations, not authenticated preregistration. Default agreement-only
fusion abstains on any directional conflict or explicit component HOLD. The opt-in
disagreement policy may pass one direction with an explicit HOLD; missing inputs always
abstain. Weighted fusion requires bound calibrated probabilities for directional net
returns, never evidence confidence or untrained scores. Preserve missing calibration.

Collapse exact repeated candidates, reject conflicting identities/ambiguous windows,
and emit one fusion candidate referencing its components. Do not forward components
into fusion orders. Rebuild report semantics during verification, in addition to its
hash chain. Synthetic diagnostics cannot establish improvement or authorize promotion.

Stop before deterministic risk sizing and paper-broker work. Execution stays disabled;
the next iteration adds risk gates around each arm's own immutable candidate.
