# ADR 0008: Bounded durable news polling and conservative duplicate evidence

Date: 2026-10-31 (Europe/Moscow). Status: accepted for Module 04, Iteration 2.

## Context

Live metadata needs attributable receipt time, storage permission, durable quotas and
replay after interruption. Syndicated discovery cannot count as independent confirmation.
The master defaults to BullMQ/Redis for background work; this checkout currently operates
through finite explicit local CLI captures and has no unattended news deployment.

## Decision

Add fixed, reviewed CISA official RSS and optional GDELT DOC RSS profiles behind separate
CLI flags. Store metadata and byte hashes only, never raw bodies or excerpts. Restrict the
index query and all article URLs to CISA. Expire approval rather than silently continuing
under an obsolete review. Preserve configuration provenance independently from article time.

Use a finite single-host coordinator with an exclusive file lock and fsynced hash-chained
JSONL. This is a documented choice in place of the default Redis worker for this slice.
Persist reservations before HTTP, retain retry/dead-letter state, and reconstruct identical
article versions without prohibited raw text. No process remains after CLI exit. A future
distributed worker must introduce shared quotas, leases and a migration of journal evidence;
multiple local journals are not a distributed scheduler.

Version live parser results/store state as v2 so uncertain dates can remain null without
changing legacy v1 fixture semantics. Keep raw date strings, actual observation/processing
times and all article revisions. Reuse existing PostgreSQL append-only stores and strict
NewsDocument v1. Projection is replayable independently from capture.

Group canonical URLs and normalized permitted title/language hashes as possible dependencies.
Keep each source occurrence and original URL. Filter by decision availability before grouping.
Record zero confirmed facts; title equality and channel count establish no semantic truth.

## Consequences

The iteration has bounded durable retries, quotas and real read-only capture without an
always-running service. File ownership remains a trust boundary; hashes are not signatures.
Journal corruption, policy mismatch and stale locks require explicit operator inspection.
Capacity is finite, with no automatic quota-resetting rotation or dead-letter replay.

GDELT remains optional; its API data license does not license publisher content. Robots
review availability and the exact metadata-only permission interpretation are recorded in
`docs/news-live.md`. Unknown publication timestamps remain uncertain; actual receipt still
supports future point-in-time use. Analyst review/corrections/export are Iteration 3;
semantic claims are Module 05.
