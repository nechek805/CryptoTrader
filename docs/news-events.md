# Temporal event snapshots and impact metadata

Module 05, Iteration 3. Event snapshots preserve what the recorded system could know at
a cutoff. Confidence is explained evidence support, not a probability that an event is true.
Asset relationships and expectation comparisons are declared metadata; no price effect,
strategy, event-study return or trade is computed here.

## Commands

Use the pinned runtime in `README.md`:

```sh
pnpm news events --provider fixture --at 2026-01-01T09:45:00Z
pnpm news event-snapshot --provider fixture --at 2026-01-01T10:35:00Z
pnpm news event-verify --artifact <snapshot-path>
pnpm news event-provenance --artifact <snapshot-path>
pnpm news event-inputs --artifact <snapshot-path> --at 2026-01-01T09:00:00Z
pnpm news event-inputs --artifact <snapshot-path> --purpose NEWS_SIGNAL_INPUT
pnpm news event-decide --provider local --graph-dir <graph-directory> --request <decision.json>
pnpm news event-persist --artifact <snapshot-path>
```

`events` and `event-snapshot` accept `--at <UTC>` (current UTC by default), optional
`--graph-head` and `--metadata-head` for exact journal prefixes. The snapshot command accepts
`--out <directory>` (default `data/news-event-snapshots`). Generation time is actual CLI time.
`event-verify`, `event-provenance`, `event-inputs` and `event-persist` consume a frozen
artifact and do not open or mutate source journals. DOT provenance is written to stdout;
redirect it to a `.dot` file for an offline Graphviz viewer. Original event/claim IDs appear
in labels, with source-dependency and lineage edges. No browser, remote renderer or URL
fetch is required.

Default provider `fixture` uses the **separate** `data/news-events-fixture` graph and
`event-metadata` subdirectory. It seeds the labelled synthetic temporal scenario, idempotently.
Existing Module 05, Iteration 2 journals stay unchanged. `--provider local --graph-dir ...`
opens an existing graph without seeding. `--event-dir ...` selects a separate curator journal;
otherwise it is `<graph-dir>/event-metadata`. Commands acquire graph then metadata locks,
and release both on completion. There is no background event service.

## Knowledge time and frozen evidence

Publication, article receipt, extraction completion, graph receipt, curation and snapshot
generation are separate timestamps. Event knowledge starts from graph receipt. A report
published at 08:30 but first received at 09:10 is unavailable at 09:00. A confirmation
received at 10:00 does not enter a 09:45 snapshot. Snapshot creation now does not backdate
an actual capture or operational event record.

Filtering occurs before graph reconstruction, context application and lineage resolution.
Snapshots embed only the selected graph and curator prefixes, their resolved heads,
input/config hashes, policy/software version, UTC nanosecond clock semantics and fixed seed 0. Future source records, mappings, expectations and identity decisions do not alter an old
snapshot or its input hash. Tied timestamps can be narrowed to exact heads. A metadata
prefix referencing graph evidence beyond a pinned graph head is incompatible and rejected.

History stores first rumor, first independent corroboration, first official statement and
corrections separately. Milestones retain original source knowledge time and the time the
current event identity could know that history. A child created by curation cannot acquire
its new identity retroactively. Corroboration milestones require two asserted original-reporting
components; a quotation alone does not create one. Later withdrawal leaves these earlier
milestones and the dispute interval intact. Source-review hashes carried by extraction are
retained as references; the snapshot does not invent their absent operator details.

Snapshots use fsynced staging and atomic hard-link publication into
`news-event_<sha256>.json`. Existing files are never replaced. Verification rebuilds source
and curator ledgers, identities, assessments, mappings and reports, then checks full content
and filename hashes. Renaming tampered derived data to a new hash does not bypass rebuilding.
An identical frozen request, including generation time/software version, produces the same
artifact. New CLI calls use new generation times and can produce new hashes.

These are bounded metadata/audit JSON exports, not analytical Parquet feature tables.
All fields come from permitted title/snippet extraction or explicit local curation; raw
feed/page bodies and raw LLM responses are absent. Existing source policy in
`docs/news-live.md` still governs evidence. No external model or network request is enabled.

## Confidence and uncertainty

| Grade             | Meaning                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| `UNVERIFIED`      | Evidence does not support a stronger declared assessment.                                         |
| `ATTRIBUTED`      | A primary official assertion is known, without certifying underlying truth.                       |
| `MULTI_ORIGIN`    | The graph reports at least two supported origin components.                                       |
| `DISPUTED`        | Eligible affirmative and negated assertions conflict.                                             |
| `WITHDRAWN`       | Supported affirmation was withdrawn under graph rules.                                            |
| `IDENTITY_REVIEW` | Identity is provisional, split, merged or awaiting assignment; no automatic confidence promotion. |

Explanations retain the underlying graph status and review limitations. The uncertainty
band is deliberately broad: minimum authenticated origin count 0, maximum active affirmative
article occurrences. It is labelled `UNAUTHENTICATED_ORIGIN_COUNT_NOT_PROBABILITY`.
Source-group/first-hand declarations and inferred dependencies can be wrong. The band is
not a calibrated statistical interval or factual probability. Canonical EventClaim v1
remains unverified; no old claim schema is rewritten.

`firstKnownAt` belongs to the event identity. `lastUpdatedAt` includes later support and
applicable context/curation. `availableAt` gates the complete current row. Mixed or
descriptive-only evidence is conservatively excluded from replay. Superseded/unassigned
events are excluded, while conflicts and withdrawals remain inspectable for research.
Temporal eligibility never itself verifies an event or authorizes an action.

## Declared asset context, novelty and surprise

Text mentions produce `MENTION_ONLY` entries. `DIRECT` and `SECOND_ORDER` relationships
require a recorded `MAP_ASSET` rule matching canonical subject and event type. Each mapping
retains symbol, reference, operator rationale, rule hash, supporting claim IDs and knowledge
time. Mentioning BTC does not automatically establish BTC exposure; a second-order ETH
mapping in the fixture is explicitly fictional counterparty context. No impact direction,
size or price elasticity is inferred.

Novelty is scoped to this corpus and the configured lookback window (default 24 hours).
`FIRST_SEEN_IN_CORPUS` and `REPEATED_PATTERN` compare only earlier eligible subject/type
observations. They do not establish global uniqueness. Update kinds distinguish new reports,
repost-only observations, corrections and review. Curated/provisional identities have unknown
pattern novelty rather than a fabricated surprise score.

`EXPECT` records a declared subject/type/case and explicit quantities/units. Only an
expectation recorded **before first receipt** can enter comparison. Later expectations
cannot rewrite historical surprise. `SCHEDULED_MATCH` / `EXPECTATION_MISMATCH` compare
normalized decimal quantity/unit tuples from an active affirmative assertion; different
units return `NOT_COMPARABLE`, with no FX conversion. Missing, disputed or unsuitable
evidence returns `UNKNOWN`. These markers compare declared text values, not market surprise,
unexpected returns or a forecasting model.

## Audited split/merge and curator input

The event metadata journal is separate from graph v1. Decision requests require both
current heads, operator and a nonempty reason:

```json
{
  "schemaVersion": "news-event-decision.v1",
  "expectedGraphHeadHash": "sha256:<current-64-digit-graph-head>",
  "expectedHeadHash": "sha256:<current-64-digit-metadata-head>",
  "operator": "analyst:local",
  "reason": "Explain the evidence and identity decision",
  "action": {
    "kind": "MERGE",
    "eventIds": ["<active-event-id-one>", "<active-event-id-two>"],
    "label": "reviewed incident"
  }
}
```

Other actions:

- `SPLIT`: `eventId`, plus at least two `partitions` containing unique `label` and
  nonempty `claimIds`. Membership must cover the parent exactly, without overlap or
  unknown/future claims.
- `MAP_ASSET`: `subject`, `eventTypes`, `symbol`, `relationship` (`DIRECT` or
  `SECOND_ORDER`) and `reference`.
- `EXPECT`: `anchorKey`, `subject`, `eventType`, `amounts` (`value` decimal string and
  `unit`) and `reference`.

The service supplies recording time; clients cannot backdate it. Stale heads, inactive or
duplicate parents, invalid partitions, rehashed target substitutions and policy mismatch
fail closed. Operations retain exact parent definitions, child definitions, target hash,
reason, operator and source graph head. Parent IDs become inactive and point to new child
IDs; their audit history remains. A merge never silently reuses a parent ID.

Membership is pinned at the identity decision. Later source claims under a retired base
identity become `UNASSIGNED`, and related lineage branches are withheld from replay until
explicitly resolved. A reviewer can merge the active branch with its unassigned evidence;
the new operation records another identity and preserves earlier views. No guessed split
assignment silently discards a later contradictory report.

`events.jsonl` is bounded to 64 MiB/5000 records and protected by `events.lock`. Entries are
hash-chained, fsynced and bound to graph/policy config and exact graph heads. Semantic
targets are revalidated on restart. A partial write stops further writes in that session;
there is no automatic repair, rotation or policy migration. The graph's existing limits
and event-view limit of 3000 identities also apply. Confirm stale lock PIDs have stopped
before removing only the lock; preserve damaged evidence for inspection. Hashes protect
integrity, not authenticity against an owner who can rewrite the whole corpus. Operator
IDs and context references are declared local identities/evidence, not independent authentication.

## Downstream interfaces and persistence

`newsEventResearchInputs(snapshot, decisionAt, purpose)` revalidates the artifact and
rebuilds at the requested cutoff. It refuses a cutoff beyond the frozen dataset.
`EVENT_STUDY` returns active temporally eligible rows; historical rumor/conflict/withdrawal
can be studied without treating them as truths. `NEWS_SIGNAL_INPUT` additionally removes
records with explicit abstention reasons, including unverified/disputed/withdrawn or
identity-review states. Neither interface creates SignalCandidate, orders or a trading
policy. Module 06 must still enforce market-data availability on joins, and Module 10
must supply its own evaluated signal/risk logic.

`event-persist` requires a migrated PostgreSQL schema, `DATABASE_URL` and optional
`DATABASE_SCHEMA`. It writes selected curator records plus the validated snapshot as
append-only raw/audit evidence, with fixture flags and parent hashes. Exact repeats add
zero; NewsDocument history stays unchanged. No SQL migration or graph-v1 rewrite occurs.
The existing 1 MiB raw-envelope database bound can reject a large snapshot even when its
64 MiB local file export is valid; the transaction rolls back. Local journals/artifacts
remain the recovery source, with no automatic database-to-journal restoration.

## Synthetic handoff

`tests/fixtures/news/temporal-cases.json` and `newsTemporalEventFixtures()` supply seven
fictional reports, nine graph records and five curator records. The scenario includes a
delayed rumor, copied report, independent corroboration at 10:00, official statement,
denial and withdrawals, a split/remerge and later unassigned evidence. Asset and prior
expectation declarations use a synthetic pre-receipt clock and claim no real foresight.

The exported nine-snapshot package in `data/news-event-fixture-export/` covers 09:00,
09:45, 10:05, 10:15, 10:25, 10:35, 10:45, 10:46 and 11:01 UTC. Its content-addressed index
records each cutoff/hash/path. This demonstrates no event, rumor, corroboration, official
statement, dispute, correction, split, merge and quarantine without rewriting old views.
Actual verification/persistence counts and index hashes are recorded in `docs/progress.md`.

Module 05 handoff is complete. The deterministic/untrusted-extractor safeguards from
`docs/news-extraction.md` and source-independence limits from `docs/news-independence.md`
remain in force. Next is Module 06, Iteration 1: reproducible event studies. No historical
reaction measurements, impact forecasts or financial results have been implemented here.
