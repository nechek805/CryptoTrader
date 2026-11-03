# ADR 0012: Frozen temporal event metadata and prospective identity lineage

Date: 2026-11-01 (Europe/Moscow). Status: accepted for Module 05, Iteration 3.

## Context

Graph v1 records source assertions, dependencies and withdrawals. Research needs immutable
as-of event inputs with explicit uncertainty, asset context and identity corrections.
Publication timestamps and retrospective metadata must not create historical availability.

## Decision

Keep graph v1 and canonical claim/article schemas intact. Add a separate versioned event
metadata ledger for source-head-bound split/merge, asset-context and expectation decisions.
Require operator/reason, optimistic heads and service recording time. Store resolved parent/
child memberships and validate semantic targets on replay. Retire parent identities while
preserving their IDs; new claims under retired bases remain unassigned until reviewed.

Publish content-addressed immutable JSON snapshots containing only then-known graph and
metadata prefixes. Resolve exact heads for timestamp ties; rebuild every derived field on
verification. Separate original source milestones from event-identity knowledge time, and
retain rumor/corroboration/official/correction history independently. Source publication
cannot backdate receipt, extraction or graph knowledge.

Expose explained evidence grades and broad unauthenticated-origin count bounds rather
than probabilities. Preserve direct/second-order mappings as declared context with record
hashes and references, keeping text mentions separate. Surprise compares only declared
expectations recorded before first receipt and exact matching units. Novelty is scoped to
past observations in the configured corpus window. Do not infer price direction or effect.

Supply typed event-study/news-signal input selectors with temporal/descriptive gates,
including stricter abstention filtering for future signal consumers. Emit escaped DOT
provenance linking events, claims, sources and identity lineage without remote rendering.
Reuse append-only PostgreSQL raw evidence for curator records and snapshot projection.

## Consequences

Future confirmations, rules and identity corrections do not alter an old frozen result.
Splits/merges retain audit IDs and cannot silently assign later evidence or promote factual
confidence. Context declarations remain fallible and fixture schedules remain synthetic.
The package supports later research joins without implementing returns, causality or signals.

JSON is the bounded audit/handoff format; analytical Parquet tables remain research work.
Journals/filesystem ownership is a trust boundary, hashes are not authentication, and local
IDs/references are declarations. Capacity, partial-write and incompatible-prefix failures
require inspection; no automatic repair or restoration is added. Source graph/metadata
locks coordinate explicit local commands. Large files can exceed the existing database
envelope limit and still remain valid local exports. No dependency or SQL migration is added.
