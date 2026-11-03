# ADR 0011: Conservative event identities and source-dependency accounting

Date: 2026-10-31 (Europe/Moscow). Status: accepted for Module 05, Iteration 2.

## Context

Extracted assertions retain exact support but remain unverified. Counting channels or
lexically similar statements as independent evidence would credit wire rewrites multiple
times. A denial, later attribution or withdrawal must not erase earlier observations.

## Decision

Use strict versioned graph contracts and a single-host append-only observation/review
journal. Stamp actual graph receipt separately from article/extraction time; only the
labelled fixture seeder uses synthetic scenario clocks. Validate immutable source/article
identities and all extraction results before append. Preserve existing persisted schemas
and project graph records into existing PostgreSQL raw/audit storage.

Require a precise literal incident anchor plus matching typed identity fields for automatic
cross-article grouping. Keep missing/ambiguous identities provisional and currency/date/
detail conflicts separate. This trades recall for fewer unsupported incident merges.
Dependency components include explicit retained attribution links, article/URL identity,
source groups and conservative high-overlap inference. Keep cycles as observed evidence
without origin credit; reject new manual cycles. Never fetch attribution URLs.

Count active eligible affirmative root components using explicit original-reporting or
primary official cues under corresponding source policy. Expose an origin-fraction score
with transparent counts rather than a factual probability. Maintain new graph statuses
UNVERIFIED/CORROBORATED/OFFICIALLY_STATED/DISPUTED/RETRACTED while preserving canonical
EventClaim v1 as unverified attribution. Contradictions and withdrawals remain inspectable.

Require operator, reason, target hash and optimistic head for acknowledgement, exact-claim
withdrawal/restore and dependency curation. Record decisions at service time and rebuild
views after filtering to the requested cutoff. Do not let review force truth, independence,
source rights, event merges or confidence numbers.

## Consequences

Wire copies contribute one origin; independent reporting can corroborate; official statements
remain fallible; retractions and later conflicts preserve old views and the evidence timeline.
Human review is available through explicit CLI and validated library interfaces. No new
web service, credentials, outside model call or trading behavior is introduced.

Literal incident labels, declared origin groups, self-asserted reporting and lexical overlap
are fallible heuristics. General semantic clustering/citation inference is not claimed.
Unclear records remain reviewable. Journals have finite capacity, exclusive ownership and
no automatic repair or migration. Tied timestamps retain ledger order; precise observed
views should retain their returned head/result. Hashes do not authenticate a malicious
filesystem owner. Temporal event snapshots, split/merge lineage, confidence/impact metadata
and event studies remain later work.
