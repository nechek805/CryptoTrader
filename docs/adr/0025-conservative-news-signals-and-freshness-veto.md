# ADR 0025: Conservative news rules with a separate freshness veto

Status: Accepted. Date: 2026-11-01. Scope: Module 10 Iteration 1.

The module requires market-independent news direction and HOLD on stale market data.
We keep a structural NewsSignalProvider over semantically validated as-of event snapshots
and place market eligibility in a separate adapter. Its minimal receipt contains only
timestamps, status, source/metadata IDs and a content hash. It can veto admission but
cannot set direction or strengthen support. Prices, features and baseline outputs never
enter event rules. A receipt hash is not authentication; the caller owns validated issuance.

Versioned, untrained rules combine reported amount, corpus novelty, a pre-recorded
quantity expectation, direct asset mapping, source independence, contradiction/withdrawal,
publication/first-known age and horizon. Attributed support is not factual confidence or
expected return edge. Canonical candidate score and calibration remain explicitly missing;
there are no invented stops, targets or orders. Publication lag is measured, not inferred
from event-day precision. All default evidence is synthetic.

Representative roots identify material independent support. Dependent copies retain their
source links without increasing support, restarting expiry or re-arming admitted opinions.
Expiry is anchored to first-known time. State is isolated and monotonic; a freshness veto
does not consume admission. Provider identity excludes unseen future records, while each
candidate hashes its known prefix. Therefore future corpus additions preserve earlier IDs.

Use a small event-snapshot replay rather than modifying Module 08's raw-input scheduler.
This completes the current acceptance slice without inventing a costed news backtest.
Frozen synthetic manifests, strict bounds, hash-chained decisions, atomic bundles and
semantic rebuilding provide reviewable evidence. Existing news, replay, market and model
formats are unchanged. Source receipt authenticity, truthful independence declarations,
historical corpus completeness and empirical edge remain unestablished.

Module 10 Iteration 2 must derive and test hypotheses only from eligible historical
event-study inputs, report sample sizes/vintage/uncertainty and reject thin or cost-negative
evidence. This ADR does not implement that statistical model, fusion or execution.
