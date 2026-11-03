# ADR 0009: Prospective news corrections and reproducible review snapshots

Date: 2026-10-31 (Europe/Moscow). Status: accepted for Module 04, Iteration 3.

## Context

Historical publication metadata cannot establish that the system knew an article at that
time. Analyst review needs auditable overrides while preserving captured evidence and old
decision views. Existing article storage already has immutable revisions and capture hashes.

## Decision

Add strict versioned contracts and a local review service/API/CLI. Derive temporal tags
from receipt evidence: observed is verified, archived is estimated and unknown is descriptive.
Replay excludes descriptive data and defaults to verified observations only. An explicit
flag permits estimates. Observation verification never verifies an article's claims.

Store manual corrections as a separate append-only hash chain with exclusive ownership,
fsync and optimistic head checks. Require operator/reason/evidence identity, and stamp time
from the service clock. A correction is knowable only from that time. Clamp availability
estimates to correction/original-processing time; publication corrections cannot grant
historical availability. Target exact article versions or rejected capture/item identities.
Allow only acknowledgement of rejected evidence, never invented parsed articles.

Keep old NewsDocument, capture, parser/store and database contracts unchanged. Reviewed
fields are a new versioned overlay. Optional PostgreSQL projection stores correction payloads
through existing append-only raw evidence and audit interfaces, with synthetic target flags
preserved. It never rewrites document history or acts as automatic local-ledger recovery.

Publish content-addressed, immutable JSON review snapshots with metadata-only reconstruction
input, source/version hashes, correction prefix, selected articles, queue and coverage.
Verify by rebuilding all derived data. JSON is a deliberate choice for this bounded audit
export instead of the master's default Parquet analytical datasets. Analytical feature
tables and trading replay adapters remain later work. Input metadata is audit evidence;
only the gated result is the replay selection.

Expose a separate explicit loopback API. Protect writes with a locally stored random token
and reject browser-origin writes. Declare local operator identity without claiming multiuser
authentication. Keep health readiness and polling separate. Source rights cannot be expanded
through an acknowledgement or override.

## Consequences

Past views remain stable after exclusions, date corrections and resets. Snapshots preserve
licensing/provenance and can be checked offline without retaining raw bodies. Coverage
reports verified receipt percentages and actual language/source observations; rejected-feed
counts disclose gaps outside the measurable article denominator.

The ledger/snapshot filesystem is a trust boundary, hashes are not signatures, and the
service is single-host with a finite corpus and no frontend/RBAC. A running API must restart
to load later captures. Stale locks, corrupt chains and capacity limits require operator
inspection rather than silent repair/rotation. Corrections apply to exact versions and do
not automatically carry to new publisher revisions. No semantic claim extraction is added.
