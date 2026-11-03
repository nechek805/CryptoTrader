# Source independence graph and corroboration

Module 05, Iteration 2. The graph groups attributable assertions, preserves dependency
evidence and reports disagreement/withdrawal. A corroborated or official statement remains
fallible. There are no trading signals, financial results or probability estimates.

## Commands and inputs

Use the pinned runtime in `README.md`:

```sh
pnpm news graph --provider fixture
pnpm news graph --provider fixture --at 2026-01-01T09:06:03Z
pnpm news graph-review --provider fixture
pnpm news graph --batch <saved-extraction-batch.json> --graph-dir data/my-news-graph
pnpm news graph --provider local --graph-dir data/my-news-graph
pnpm news graph-decide --provider local --graph-dir data/my-news-graph --request <decision.json>
pnpm news graph-persist --provider local --graph-dir data/my-news-graph
```

Default provider is `fixture`, using `data/news-graph-fixture`. It seeds thirteen separately
labelled synthetic source observations and one synthetic wire withdrawal on a fixed fixture
clock. Original source/extraction fixtures remain unchanged. Repeated seeding is idempotent
and does not replay a fixture withdrawal after a later manual restore.

`--batch` imports a strict saved `news-extraction-batch.v1`, including the CLI's optional
persistence reports. It cannot be combined with `--provider`. It defaults to the `local`
journal at `data/news-graph-local`; choose `--graph-dir` to isolate corpora. Exact repeated
results add zero records. `local` reads existing graph evidence without fixture seeding.
No feed, URL, LLM or third-party endpoint is contacted. File import is bounded to 64 MiB;
manual request files to 16 KiB.

Source/claim extraction results are revalidated for grounding, hashes and temporal policy.
Conflicting metadata for an immutable source version, article version or article processing
instant fails before journal publication. Import stamps graph knowledge at actual service
receipt; it never pretends the graph had been running at an older article timestamp.
Nodes separately preserve article first observation, extraction completion and graph receipt.

The CLI is the human interface; `NewsGraphService.query`, `observe` and `decide` provide
strict validated library interfaces. No new HTTP server or frontend was added. Existing
operational readiness/news review services remain separate.

## Conservative identity and dependencies

Automatic clusters require a unique literal `case LABEL` / `дело LABEL` inside the claim's
support, a known subject, precise day/minute/second event time and known units/values for
any extracted amounts. Identity includes the case label, ontology event type/predicate,
normalized curated subject, time precision/value, amount/unit tuples and mentioned assets.
Decimal lexical zeros normalize exactly without floating-point arithmetic or FX conversion.
Different labels, dates, currencies or other typed details stay separate.

Without sufficient identity, the article receives a provisional cluster. Similar typed
fields produce `POSSIBLE_MATCH` review items rather than a guessed cross-article merge.
Shared labels with different details produce `DETAIL_CONFLICT` review items. A case label
and matching metadata are a conservative heuristic, not proof of a globally unique incident;
source mislabelling or coincidentally identical incidents can still require analyst review.
Cluster IDs depend on identity, not the current list of members. No split/merge override
or temporal event-snapshot export is introduced in this iteration.

Dependency edges preserve separate claim/article occurrences and evidence:

| Relationship                                      | Basis                                                                                                                                                      |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WIRE_REPRINT`, `REWRITE`, `CITES`, `ATTRIBUTION` | Exact retained phrases followed by a URL to known evidence for the same event.                                                                             |
| `QUOTED_OFFICIAL`                                 | Exact `quotes official <URL>` link to known matching official-source evidence.                                                                             |
| `SAME_ORIGIN_GROUP`                               | Immutable registry independence group.                                                                                                                     |
| `SAME_ARTICLE`                                    | Shared article entity or canonical URL, including repeated extraction/versions.                                                                            |
| `INFERRED_SYNDICATION`                            | Same anchored event and polarity, at least eight shared tokens and default 95% token-set Jaccard overlap. This is a possible dependency and a review item. |

Attribution spans use the extraction field's UTF-16 offsets. URLs are metadata references;
they are not fetched. A missing/future/nonmatching target gives unresolved attribution and
no independent-origin credit. Automatic inferred/metadata edges point toward earlier known
evidence. Observed citation cycles are retained as a graph, grouped conservatively and sent
to review; circular references cannot manufacture independent roots. Manual links reject
cycles and cross-event joins.

The graph currently recognizes these explicit attribution phrases rather than performing
general citation-language extraction. It can miss paraphrases or implicit dependencies.
Inferred overlap can collapse genuinely separate reporting; the choice is conservative.
Source owner/group metadata and first-hand assertions can be wrong. Scores and statuses
therefore describe the documented evidence model, not established truth.

## Independence score and statuses

`evidenceIndependenceScore` validates one event's nodes/edges, groups connected dependencies,
and always collapses common article identities, URLs and source-origin groups. A contributing
root must be active, temporally eligible, not withdrawn and have no citation/inferred outgoing
dependency. Original-reporting credit additionally requires `INDEPENDENT_REPORTING` source
policy and a retained `independently reported` / `observed first-hand` cue in that assertion.
Official primary credit requires official-source policy and `officially stated` support.
Quotes and unresolved references do not create original reporting credit.

The score is the floor of **10000 × independent affirmative origin components / active
affirmative article occurrences**, or zero when the denominator is empty. It is labelled
`ORIGIN_FRACTION_NOT_PROBABILITY`, with component/root IDs and counts exposed. Three rewrites
plus one wire original contribute one origin and score 2500 basis points. Two distinct
original-reporting components contribute two origins. Neither value is a factual-confidence
percentage. Negated/uncertain statements never contribute affirmative origins.

| Status              | Rule, in priority order                                                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `DISPUTED`          | Active eligible affirmative and negated assertions coexist, even if their reporting origins are uncertain.                               |
| `RETRACTED`         | No supported affirmative origin remains and an affirmative assertion was explicitly withdrawn. Copies do not resurrect a withdrawn root. |
| `OFFICIALLY_STATED` | An active affirmative primary official root remains. It is an attributable statement, not unconditional verification.                    |
| `CORROBORATED`      | At least two supported affirmative origin components remain.                                                                             |
| `UNVERIFIED`        | Remaining cases, including denials alone, unresolved lineage and uncertain/provisional evidence.                                         |

Contradiction groups retain affirmative/negative claim IDs and whether conflict is active.
The original canonical `EventClaim.v1` objects remain `UNVERIFIED`; graph assessments are
new versioned projections. Old article/claim schemas and SQL migrations are unchanged.

## Human review and timeline

`graph-review` returns stable review IDs and the current journal head. Categories cover
ambiguous identity, possible matches, detail conflicts, unknown origins, unresolved/circular
attribution, inferred syndication, contradictions, withdrawals and extraction failures.
Zero-claim extraction failures retain separate review entries instead of becoming nodes.

Create a decision request using current IDs/head:

```json
{
  "schemaVersion": "news-graph-decision-request.v1",
  "expectedHeadHash": "sha256:<current-64-digit-head>",
  "operator": "analyst:local",
  "reason": "Describe the evidence and review decision",
  "action": { "kind": "RETRACT", "claimId": "<claim-id>" }
}
```

Actions are `RETRACT`/`RESTORE` with `claimId`, `ACKNOWLEDGE` with `reviewId`, and `LINK`
with `from`, `to` and an explicit dependency `relationship`. Each entry retains operator,
reason, exact target hash, code/config hash and service-supplied recording time. Client
recording timestamps and stale heads are rejected. Review cannot set truth/confidence,
grant source rights, force an event merge or declare independence.

Acknowledgement changes queue state only. Retraction/restore targets an exact claim,
retains original evidence and takes effect prospectively. Source-version changes select
the latest known article processing version and latest extraction per field; older claims
remain in history rather than supporting the current belief. Withdrawn denials remain in
contradiction history. An unretracted copy cannot claim fresh origin credit when its root
was withdrawn. A later new primary assertion can supply new support.

Queries filter journal observations and decisions **before** rebuilding clusters, links,
scores and statuses. A future official source or later dependency cannot leak into an old
view. The timeline includes every observation, acknowledgement, link, withdrawal and
restore, with retained original first-seen/extraction times on nodes. UTC timestamps can
tie at clock resolution; tied records retain ledger order and the cutoff includes all
then-recorded entries at that timestamp. Pin the returned head with a retained result
when identifying a precise observed decision view.

## Durability and operational limits

`graph.jsonl` is schema-validated, hash-chained and fsynced before publication. The process
owns `graph.lock` exclusively. Record indexes, previous hashes, config hashes, target
bindings and nondecreasing recording times are checked on restart. A projection is checked
before appending, and a failed partial write poisons later writes in that session. No
deletion or in-place correction exists.

Limits are 64 MiB/5000 journal records, default 100 distinct extraction results, 1000 nodes,
10000 edges and 10000 review entries. Limits fail closed without dropping evidence. There
is no automatic repair, compaction, background process or distributed coordination. Keep
one journal owner; inspect stale PIDs and confirm the former process stopped before
removing only its lock. Config changes require a reviewed migration, not silently reusing
the same journal under new inference rules. Filesystem owners can recompute hashes; these
are integrity checks, not authentication signatures. Operator IDs are declared local IDs.

Optional `graph-persist` requires a migrated schema, `DATABASE_URL` and optional
`DATABASE_SCHEMA`. It projects versioned graph records to existing PostgreSQL raw/audit
storage idempotently. Synthetic observations and fixture-only reviewer actions retain their
synthetic flags. It never rewrites NewsDocument history or canonical extraction status.
The local journal remains the recovery source; PostgreSQL is an audit projection, with no
automatic reverse restoration in this slice.

The source license ledger in `docs/news-live.md` still governs fields. Graphs reuse only
already permitted extraction evidence, retain no raw feed/page bodies, and never transmit
content externally. Tests and exact CLI/database checks are recorded in `docs/progress.md`.
Module 05, Iteration 3 event snapshots/context are documented in `docs/news-events.md`.
This graph iteration's checks and original evidence remain preserved. No measured financial
impact or evaluation is claimed.
