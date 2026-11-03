# Event ontology and evidence extraction

Module 05, Iteration 1. Extraction produces attributed, **unverified assertions**. It does
not establish that an event happened. No clustering, corroboration score, trading signal
or order is implemented. Source independence graphs are Iteration 2.

## Commands

Use the pinned runtime in `README.md`:

```sh
pnpm news extract --provider fixture
pnpm news extract --provider fixture --field APPROVED_SNIPPET
pnpm news extract --snapshot <verified-news-snapshot-path>
pnpm news extract --provider fixture --ontology <ontology.json>
pnpm news extract --provider fixture --persist
```

Output is a strict `news-extraction-batch.v1` JSON report. Redirect stdout to retain the
full batch; it includes evidence, configuration and per-document diagnostics. Default input
is the separately labelled synthetic extraction corpus. `--snapshot` verifies a Module 04
snapshot by rebuilding its evidence/review results and uses only its selected article
versions. It is mutually exclusive with `--provider`. At most 100 documents enter a batch.
No feed or article page is fetched and no model API is called by these commands.

`--field` accepts `TITLE` (default) or `APPROVED_SNIPPET`. Offsets refer to that field alone.
Unavailable or unlicensed snippets return `INPUT_POLICY` without calling the adapter.
There is no arbitrary full-text, URL or model-endpoint CLI input. Source/version hashes,
source policy, matching fixture/public provenance and decision cutoff are checked before
extracting. Excluded or not-yet-available versions yield no claims. Unknown historical
availability can be inspected for research, with descriptive-only canonical claims.

## Ontology and literal grammar

`defaultNewsOntology()` contains security incident, insolvency, regulatory action,
exchange outage, listing, delisting, ETF decision, token unlock, rate announcement and
macro shock. English/Russian literal phrases, predicates, curated entity aliases,
mentioned asset symbols and quantity units are configurable through `NewsOntologySchema`.
Configuration strings are escaped as literal phrases; they cannot inject executable regex.
Duplicate event types and unit symbols are rejected. Ambiguous matching triggers do not
produce a guessed event type.

`literal-news-grammar.v1` is a deterministic, intentionally limited parser. It handles one
configured trigger per supported sentence, known entity aliases before that trigger,
explicit quantity/unit pairs, simple negation/hedging and explicitly cued ISO dates.
It supports `en` and `ru` exactly; other languages go to review. This is not general NER,
translation or unrestricted news understanding. Unknown entities and missing values stay
explicitly unknown. Unsupported clauses can be omitted; `EXTRACTED` describes the returned
supported assertions rather than exhaustive coverage of every statement in a document.

Quantities remain decimal strings with a declared unit and exact evidence. USD and EUR
are distinct; token amounts and percentages have separate kinds. There is no FX conversion,
summation or cross-article amount merging. Scaled/localized magnitudes such as `1.2 million
USD` and `1,000 EUR` keep the explicit unit but a null normalized value and require review.
An unqualified dollar glyph remains an unknown unit. No binary floating-point amount math
is used.

Event time has an exact span, granularity and optional UTC instant. Year/month/day values
retain that precision with a null instant. Only explicit UTC second/minute timestamps
become instants. Invalid calendar dates, relative dates, local offsets and multiple candidate
dates stay unknown. Publication/receipt metadata never supplies an unstated event date.
Asset mappings mean `MENTIONED`; they do not infer direct financial exposure.

Negation yields `NEGATED`, hedges/questions/quotes yield conservative `UNCERTAIN`, and
literal affirmative statements yield `AFFIRMED`. These describe the text. Every canonical
EventClaim remains `UNVERIFIED` with missing, uncalibrated factual confidence. The simple
sentence-wide rules can overflag double negation and complex scope; they never promote a
denial to a confirmed event. Exact evidence is retained for later review.

## Evidence and point-in-time use

Each result includes the selected source/article version and hashes, field identifier,
ontology/config/prompt hashes, complete configuration, adapter versions, software version,
fixed seed 0, start/completion times and a hash of a bounded response when available.
The raw adapter response is not retained. Supporting spans are half-open UTF-16 code-unit
ranges `[start,end)` and retain exact text; no Unicode normalization changes the source
field. Emoji and case-folding edge cases are covered by fixtures.

New `news-extraction-*` schemas contain typed subjects, predicates, amounts, time,
language, entities, polarity, mentioned assets and unknown-field lists. The original
`event-claim.v1` remains unchanged. Its compatibility projection stores the full typed
assertion in `object.value` as canonical JSON, with `UNSPECIFIED` only when the richer
subject field is null. Consume the richer candidate and its polarity; a predicate alone
does not mean the event occurred. Each compatibility `eventId` is an unclustered placeholder,
not a corroborated event group.

`firstKnownAt`, `lastUpdatedAt` and eligible claim availability start at **extraction
completion**, including when input is an older snapshot. Claim availability is never
backdated to publication, receipt or the requested data cutoff. Verified receipt evidence
can yield temporally eligible assertions; factual status remains unverified. Estimated or
unknown input yields descriptive-only claims in this iteration. `extractedNewsClaimsAt`
validates the result and applies the canonical availability gate. This temporal selection
does not certify correctness or authorize a trading action.

## Replaceable structured adapter boundary

`NewsClaimAdapter` is an injected interface returning unknown JSON/string data under an
AbortSignal. The shipped adapter is local and deterministic. Injected structured adapters
accept **synthetic inputs only** in this iteration; public source text is blocked. No SDK,
credentials, external endpoint or real LLM integration is shipped. A future external adapter
needs explicit source-processing rights, transport/rate policy and its own validation before
activation. A content-retention license alone does not grant permission to send text to a
third-party model.

`news-extraction-prompt.v1` tells an adapter to treat text as inert data, preserve offsets,
units, unknowns and negation, and never verify facts or invoke tools. The frozen prompt is
versioned and hashed. Known instruction-like patterns are quarantined before invocation.
This heuristic is not a complete prompt-injection detector. Structural validation, exact
evidence reconciliation, immutable provenance and the absence of execution capabilities
provide additional boundaries.

Structured responses must match `news-structured-extraction.v1`. Every candidate is
reconciled against the supported deterministic grammar, including every exact offset,
entity, quantity/unit, polarity, omitted field and duplicate. Reordered valid candidates
are normalized; unsupported model interpretations go to review. This intentionally limits
the seam to the current grammar; it does not claim a tested general-purpose LLM extractor.
Invalid/empty/oversized responses, attempted verification fields, changed negation,
invented entities and provider errors produce sanitized `REVIEW_NEEDED` results without
accepted claims. Valid assertions with unknown fields remain present and flagged for review.
Review status is in the extraction result; no automatic analyst override is created.

Default session limits are 100 attempts, 5-second timeout and 65536 response bytes. An
injected adapter requires at least 1000 ms between attempts. Attempts are reserved before
invocation, including failures; concurrent work is refused and there are no automatic
retries. Timeout aborts and stops further invocation in that extractor session because an
injected callback might ignore cancellation. Quotas are in-process, not a durable provider
scheduler. No background process is started.

| Adapter                       | Model version                                   | Prompt version               | Per-document external API cost                                |
| ----------------------------- | ----------------------------------------------- | ---------------------------- | ------------------------------------------------------------- |
| Shipped deterministic parser  | `literal-news-grammar.v1`                       | `news-extraction-prompt.v1`  | USD 0; no external calls. CPU/storage cost is not estimated.  |
| Injected test/structured seam | Caller-declared version, retained in provenance | Must match the pinned prompt | Unknown/null; no fabricated usage, price or free-model claim. |

No live model quality, latency or paid-provider pricing was measured. Synthetic adapters in
tests validate the boundary rather than the behavior of an external model.

## Persistence, fixtures and handoff

`--persist` needs a migrated PostgreSQL schema, `DATABASE_URL` and optional
`DATABASE_SCHEMA`. `persistNewsExtraction` validates grounding and canonical invariants,
then appends the versioned result to existing raw evidence/audit storage. A repeated exact
result adds zero. A newly timed extraction is a new observation and can add a result.
No SQL migration or existing article/claim schema changes. Raw audit-record availability
describes the extraction receipt; consumers must apply each canonical claim's research-use
gate. Database projection does not make descriptive evidence tradable.

The 19 synthetic documents in `tests/fixtures/news/extraction-cases.json` cover all ontology
types, denials, currency separation, Russian aliases, quantities, Unicode, empty extraction,
unsupported language and instruction-like text. The CLI produces 17 unverified assertions:
14 affirmative, two negated and one uncertain. Fourteen documents extract without missing
supported fields; five need review. These counts are fixture behavior, not model accuracy.
The old ingestion/review fixture registry and hashes remain unchanged.

See `docs/progress.md` for actual checks and preserved read-only snapshot results, and
ADR 0010 for the design boundary. Module 05, Iteration 2 source independence and corroboration
is documented in `docs/news-independence.md`. Event studies, impact estimates and signals
remain later work.
