# News review, corrections and snapshots

Module 04, Iteration 3. All execution remains disabled. The local API/CLI reviews permitted
article metadata and preserves source evidence, corrections and decision-time views.
Semantic extraction starts in Module 05.

## Commands

Use the pinned runtime in `README.md`. Review commands default to labelled synthetic
fixtures; `--provider live` restores the existing public polling journal without HTTP.

```sh
pnpm news review --provider fixture
pnpm news coverage --provider fixture
pnpm news snapshot --provider fixture --mode REPLAY
pnpm news verify-snapshot --artifact <absolute-snapshot-path>
pnpm news review --provider live
pnpm news snapshot --provider live --mode RESEARCH
pnpm news serve-review --provider fixture --port 3002
```

`review`, `coverage` and `snapshot` accept `--at <UTC timestamp>`; default is current UTC.
Future queries are rejected by the service. Snapshots accept `--mode RESEARCH|REPLAY`,
`--allow-estimated` and `--out <directory>` (default `data/news-snapshots`). Snapshot
generation time is actual CLI time. An identical frozen library request, including generation
time and code version, publishes the same content hash; separate CLI calls have new times.

All review commands accept `--review-dir <directory>`; defaults are
`data/news-review-fixture` and `data/news-review-live`. Public input also accepts
`--journal <directory>` (default `data/news-live`). Keep a review directory associated with
its input corpus. Target hashes prevent applying a ledger to different evidence. Review
commands do not poll feeds or alter the poll journal, quotas, source policy or raw evidence.

The review fixture corpus combines the original seven captures with five additional
synthetic cases from `tests/fixtures/news/review-cases.json`. It contains nine current
article occurrences, ten versions and twelve captures: seven verified receipts, one
archived estimate and one unknown historical availability. Its first-observation coverage
is 77.78%; there are two rejected feeds and one rejected item. English/Russian coverage
is eight/one articles. The original `news fixtures` command, registry and state hashes
remain unchanged.

## Availability and replay

| Tag                       | Basis                                                                                                      | Replay behavior                                                                                                           |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `POINT_IN_TIME_VERIFIED`  | Captured receipt with `OBSERVED` evidence; processing time gates use. Synthetic receipts remain synthetic. | Eligible after effective availability unless excluded. This tag verifies observation time, never the truth of an article. |
| `POINT_IN_TIME_ESTIMATED` | `ARCHIVED_CAPTURE` or an explicitly documented analyst availability estimate.                              | Excluded by default; requires `allowEstimated: true` / `--allow-estimated`.                                               |
| `DESCRIPTIVE_ONLY`        | Unknown historical availability and no analyst estimate.                                                   | Always excluded from replay, including when estimates are enabled. Publication time cannot promote it.                    |

The first observed receipt is preserved across article updates. Article versions become
visible at processing time. Every correction becomes knowable at its server-recorded time.
An availability estimate uses the latest of the proposed time, original processing time
and correction recording time; it cannot grant access in an earlier replay. Publication
corrections change only the effective publication field. They never prove first availability.
Correcting an unknown publication time leaves unknown availability descriptive.

`NewsReviewService.articles({decisionAt, mode: 'REPLAY'})` and snapshot `result.articles`
are the gated replay interfaces. Use the reviewed effective fields and eligibility;
embedded original versions preserve evidence. Snapshot `input` is reconstruction/audit
metadata and includes excluded/descriptive records; it is not a replay selection.
No trading engine is implemented here.

## Queue and manual corrections

Queue items retain source/version hashes, known time and a document-version or rejected
capture/item target. Categories cover unparsed feeds/items, source storage restrictions
and missing/uncertain/inconsistent provider or availability timestamps. No rejected body
or unapproved excerpt is added to the queue. Legal acknowledgement records review and
does not expand storage rights. Suspicious publication metadata can coexist with a
defensible actual first receipt. Unparsed counts remain visible after acknowledgement.

Write a JSON request file using a target and `correctionHeadHash` returned by the queue:

```json
{
  "schemaVersion": "news-correction-request.v1",
  "target": { "kind": "DOCUMENT", "versionId": "<version-id>" },
  "operator": "analyst:local",
  "reason": "Explain the evidence and decision",
  "expectedHeadHash": "sha256:<current-64-digit-head>",
  "action": { "kind": "EXCLUDE" }
}
```

```sh
pnpm news review-correct --provider fixture --request <request.json>
pnpm news review-persist --provider fixture
```

Actions are `EXCLUDE`, `RESET`, `SET_PUBLICATION_TIME` (UTC `publishedAt` or null),
`ESTIMATE_AVAILABILITY` (UTC `estimatedAvailableAt` and nonempty `evidenceReferences`),
and `ACKNOWLEDGE` (queue `category`). Rejected capture/item targets accept only an
`UNPARSED` acknowledgement; they cannot manufacture parsed articles. A reset clears
earlier overrides for that version prospectively. Corrections target a specific immutable
version; a later publisher revision needs its own review. New article versions do not
silently inherit an earlier version's manual decision.

Operator and reason are mandatory. The service supplies `recordedAt`; client-supplied
recording timestamps are rejected. A stale global head fails with a conflict, so concurrent
requests cannot silently overwrite decisions. Every entry records the exact evidence hash,
previous ledger hash, code version, operator, reason, action and recording time. There is
no edit/delete operation. Historical queries include only then-known corrections.

`corrections.jsonl` is bounded to 64 MiB/5000 records, fsynced before publication, protected
by an exclusive `corrections.lock` and checked on restart. A partial write poisons further
writes in that session. Corrupt/partial chains fail closed; no automatic repair or rotation.
Inspect stale lock PIDs and confirm the previous process stopped before removing only
the lock. Retain evidence journals. Hash chains detect changes but are not signatures
against an owner who can rewrite and recompute the complete corpus.

## Local API

`serve-review` binds only `127.0.0.1`, defaults to port 3002 and loads an immutable corpus
at startup. Restart to include later polling captures. It owns the correction ledger until
Ctrl+C. The normal fixture health API remains a separate service.

| POST route          | JSON input                                               |
| ------------------- | -------------------------------------------------------- |
| `/news/review`      | `{ "decisionAt": "<UTC>" }`                              |
| `/news/coverage`    | Same decision query                                      |
| `/news/articles`    | Decision query plus optional `mode` and `allowEstimated` |
| `/news/corrections` | The correction request above                             |

Read and write bodies/responses use strict Zod contracts. Writes require
`Authorization: Bearer <token>` and reject requests with an Origin header. A random local
token is stored in `<review-dir>/review-token.txt`; startup reports its path, never its
value. Treat this file as private and retain local filesystem access controls (POSIX mode
0600 does not replace Windows ACLs). There is no browser CORS grant or shared-user RBAC.
Operator IDs are declared local identities; the session token authorizes writes rather
than independently authenticating each operator. Logs omit request bodies and headers.
Invalid requests return sanitized errors; stale heads return 409. Body limit is 16 KiB.

## Export, persistence and coverage

Snapshots are metadata-only JSON artifacts named by content hash. They contain known
provider/source versions, source hashes, capture byte hashes and parser diagnostics,
article version hashes, then-known corrections, queue/coverage results and selected
articles. All raw bodies are stripped, including synthetic bodies. Approved snippets
remain governed by the immutable source policy. Future captures, source versions and
corrections do not enter an earlier snapshot. Export before the first known source policy
fails closed because there is no valid source registry to serialize.

Publication uses a fsynced staging file and atomic hard-link creation without replacing an
existing artifact. Verification rebuilds the store and derived reports, validates the
correction chain and target hashes, checks the filename/content hash, and enforces a
64 MiB file limit. Tampering with a report and renaming the file to its new hash still fails
recomputation. These are portable local JSON audit artifacts, not a Parquet analytical
dataset; ADR 0009 records this choice and backward compatibility.

`review-persist` projects correction records as versioned append-only raw evidence into
the existing PostgreSQL audit chain. It requires a migrated schema, `DATABASE_URL` and
optional `DATABASE_SCHEMA`. Exact repeats add zero. Projection never edits NewsDocument
history; reviewed reads reconstruct overlays from the local ledger/snapshot. PostgreSQL
projection is an audit copy, not automatic ledger restoration. Preserve the local journal.
No SQL migration or old persisted schema is changed.

Coverage counts the latest visible version per article occurrence. The defensible percentage
uses verified observations divided by all visible articles, with null for an empty corpus.
Excluded articles stay in that denominator because legal suitability and observation
evidence are separate measures. Replay eligible/excluded counts are reported separately.
Unknown numbers of lost articles in rejected feeds cannot enter the denominator; rejected
feed and item counts disclose that gap. Languages report actual observed article counts
and source IDs; source rows also expose declared versus observed languages. Coverage
does not measure corroboration, publisher-date reliability or completeness of the internet.

The source license ledger remains in `docs/news-live.md` and its versioned configuration.
Permitted live receipts can support future paper-research inputs after receipt/processing;
unknown historical metadata is descriptive, while archived estimates require explicit
opt-in. Rights, provenance, uncertainty and availability gates still apply. No semantic
claims or simulated financial results are produced. Actual checks and handoff are recorded
in `docs/progress.md`. Module 05, Iteration 1 extraction is documented in `docs/news-extraction.md`.
