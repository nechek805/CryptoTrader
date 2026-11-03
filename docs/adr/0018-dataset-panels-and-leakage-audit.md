# ADR 0018: Verified panels with separate label clocks and global temporal splits

Status: accepted, 2026-11-01. Scope: Module 07, Iteration 3.

Construct panels from semantically rebuilt technical/cross artifacts with explicit
series/source bindings and historically known instrument/group metadata. Allowlist
registered predictor columns; configuration fingerprints prevent incompatible definitions
from sharing a column. Untrusted feature proposals are audit-only. Audit actual referenced
bar clocks as well as claimed watermarks; arbitrary mathematical leakage cannot be
inferred automatically. Preserve all excluded candidate evidence and reasons.

Keep predictor and label lineage separate. Pin entry prices at feature time; observe
each future close at its own fixed publication-lag cutoff and finalize the label only
when that window matures. Require complete intermediate paths and known mappings; missing
or delisted exits stay null. Later corrections cannot silently revise earlier labels.

Use chronological half-open train/validation/test windows. Purge earlier labels globally
across symbols/groups when their support touches the next partition, and apply explicit
post-boundary embargo. Reject future, unknown and conflicting evidence. No random splits,
automatic imputation or preprocessing fitting. Explicit cohort disclosures and zero-row
coverage report selection effects without claiming a complete historical universe.

Publish versioned artifact/manifest JSON and included-row Parquet with the existing pinned
DuckDB writer. Use exact decimal strings, canonical nanosecond UTC and stable column/row
ordering. Stage/sync then atomically publish; verify existing outputs before reuse.
Verification rebuilds source/panel semantics and checks every flat Parquet field against
its typed record and expected included rows, in addition to hashes. The TypeScript reader
separates predictor matrices from explicitly requested supervised labels.

The test workspace now references the same already-pinned DuckDB dependency to construct
a poisoned-Parquet failure fixture. No new runtime dependency version, SQL migration,
network adapter, Python logic, trading endpoint, model or strategy is introduced.
Existing technical/cross schemas and historical artifacts remain compatible. Feature
publication latency is unmodeled; gross labels have no fill/cost or performance meaning.
This completes Module 07 and hands typed datasets to 09/11; next implementation is
Module 08, Iteration 1 only.
