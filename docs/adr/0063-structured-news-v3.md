# ADR 0063: separate structured news V3 comparison

Date: 2026-11-08. Status: accepted.

V1 lost on non-actionable protocol headlines, and V2 selected unstable macro
groups with too few examples and no economic expectations. Retuning against
already viewed final prices would not establish an edge.

Preserve the legacy engine and frozen reports. Append V3 in a separate immutable
store with explicit parent hashes, status-aware facts, point-in-time expectation
requirements, stronger sample/uncertainty/cost gates and chronological folds.
Copy legacy models exactly and retain the same fees and hourly execution.
Separate minute diagnostics measure timing without changing comparative fills.

The current corpus cannot support V3 trade selection; HOLD is an expected result,
not a profitable prediction. Missing consensus and historical first-availability
remain visible. No paid provider, new keys, LLM training or live strategy promotion
is introduced. Future consensus/archive ingestion requires genuine point-in-time
data and its own recorded protocol.

The existing BullMQ research worker routes versioned jobs to separate tables;
original API/financial worker source and running containers remain independent.
Tests cover semantic failure cases, causal cutoffs, long/short costs, missing data,
authorization, immutable parent references and real Redis consumption.
