# News live ingestion and deduplication

Module 04, Iteration 2. Public read-only metadata; execution remains disabled. The
synthetic registry and its fixture hashes are unchanged. Claim extraction belongs to
Module 05; analyst review, corrections and snapshot export belong to Iteration 3.

## Commands

Use the pinned Node/pnpm runtime from `README.md`:

```sh
pnpm news poll --enable-live
pnpm news poll --enable-live --enable-aggregation
pnpm news poll --enable-live --duration-ms 60000
pnpm news poll-status
pnpm news poll-status --persist
```

`poll` requires explicit live enablement. Aggregation has a separate opt-in flag.
The default finite batch has a 15-second deadline and at most one attempt per selected
source; an explicit duration accepts 100–60000 ms. A source cooldown can end the batch
immediately. Nothing remains running after exit. `poll-status` rebuilds local state
without HTTP. Both commands accept `--journal <directory>` (default `data/news-live`)
and `--persist`. Persistence requires a migrated PostgreSQL schema and `DATABASE_URL`;
`DATABASE_SCHEMA` defaults to `crypto_research`. The existing local fixture-cluster
helper can be used with a separate `crypto_fixture_news_live` schema for verification.

## Source license ledger

The exact versioned profiles, gates, citations and source policy are in
`packages/connectors/src/live-news-config.ts`. Review profile date is 2026-10-31;
the gate expires **2026-11-30T00:00:00Z** and then refuses requests. The profile's
`knownAt` is configuration knowledge, never article first availability.

| Source                  | Endpoint and permission basis                                                                                                                                                                                                                                                                                                                                                   | Retention and independence                                                                                                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CISA alerts             | [Official RSS](https://www.cisa.gov/cybersecurity-advisories/alerts.xml), [robots](https://www.cisa.gov/robots.txt), government-authored material under [17 USC 105](https://www.copyright.gov/title17/92chap1.html#105). Robots review returned 200 and did not disallow the advisory path for this client.                                                                    | Titles, URLs, identifiers, language and provider date metadata only. Government-work treatment does not grant rights to third-party material, logos or media. No excerpts or raw feed bodies retained.                    |
| GDELT DOC RSS, optional | [Published API](https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/) and [GDELT terms](https://gdeltproject.org/about.html#terms); exact query restricts to English CISA publications, last day, ten results. Robots endpoint timed out during review; no claim of a successful robots check. This adapter requests only the documented API and never crawls article pages. | Metadata only, attribute GDELT and CISA. GDELT data terms do not grant publisher full-text rights. Only CISA article origins accepted. Both channels use `publisher:cisa`, so the index adds no independent confirmation. |

This local research approval is deliberately limited to attributable metadata, not a
general grant to republish feed content. Re-review the source before changing scope.
HTTP denials and redirects are terminal; the adapter does not work around them.

Both profiles enforce 900 seconds between requests and at most 96 requests in a rolling
24 hours, including failures and interrupted attempts. There is also a one-second global
gap. Requests have a five-second timeout, a 262144-byte limit, no redirects, strict UTF-8,
public DNS pinning and original-host TLS verification. CISA allows at most 100 parsed
items, GDELT ten. No arbitrary endpoints or article-body fetching are exposed.

## Durable scheduling and recovery

`poll.jsonl` is an append-only, hash-chained, schema-validated local journal. The process
holds `poll.lock` exclusively and fsyncs a quota reservation **before** every request.
Completion times conservatively anchor subsequent cooldowns and rolling budgets. Restart
replays outcomes without downloading content. An unfinished reservation becomes a spent,
retryable interrupted attempt on the next polling command.

There are at most three attempts per cycle. Exponential backoff starts at one second,
doubles, and caps at 60 seconds; source cooldown and HTTP Retry-After can extend it.
Retry-After is never shortened to the exponential cap. Network errors, 408, 429 and 5xx
are retryable. Denials, redirects, invalid formats and exhausted budgets enter a retained
dead-letter state and pause that source. Reports expose failures and due times; there is
no automatic dead-letter reset or analyst recovery interface in this iteration.

Use **one journal per polling installation**. Different directories or hosts do not share
quota reservations. Do not reset the journal to bypass limits. Config hash changes,
partial writes, chain mismatch and oversized journals fail closed. The journal is bounded
to 64 MiB/5000 records, the store to 1000 captures/2000 versions and deliveries to 5000.
There is no compaction or automatic rotation. A stale lock requires checking its PID and
confirming the former process has stopped before removing only that lock. Preserve damaged
journals for inspection; no repair command rewrites evidence. Hashes detect accidental
changes, not an attacker with write access who can recompute the entire chain.

The finite, single-host scheduler uses a local durable journal instead of the master's
default BullMQ/Redis background worker. ADR 0008 records this bounded implementation
choice. Distributed scheduling and unattended deployment remain outside this slice.

## Time, versions and duplicate evidence

Actual request start, receipt, parser completion, publication/update metadata and signed
publication lag are distinct. Network latency runs from request start after durable
reservation to receipt; processing latency runs from receipt to parser completion.
Document availability starts at processing completion, with the first actual receipt
preserved through later revisions. Historical publication dates never backdate availability.

The live parser uses `news-parse-result.v2` and the store emits `news-store.v2` when needed.
Legacy strict parser/store v1 remain readable and unchanged for fixtures. An invalid or
unknown provider timestamp is retained as raw date metadata with a null normalized value
and `UNCERTAIN_TIMESTAMP`. Only explicit numeric/UTC offsets and the fixed US zone
definitions in [RFC 5322](https://www.rfc-editor.org/rfc/rfc5322#section-4.3) are normalized;
unknown zones and negative-zero offsets are never guessed. A rejected old capture cannot
retroactively establish first-seen time for an unidentified article.

The current live profile also leaves two-digit publication years uncertain, even when
an obsolete RFC form could be interpreted. Actual CISA RSS used this form in the smoke
capture; all 30 articles therefore retain raw date metadata and null `publishedAt`.

Canonicalization removes fragments and known tracking keys (`utm_*`, `gclid`, `fbclid`,
`msclkid`), sorting remaining query parameters while preserving content identifiers. The
feed parser still rejects fragment-bearing article links. Original article URLs remain
in evidence. Stable provider IDs may change tracking aliases; changing the actual article
path conflicts rather than silently replacing its history.

Each channel occurrence and each observation stays attributable. Duplicate views filter
by availability before grouping matching canonical URLs or normalized title/language
hashes. These are **possible dependencies**, including reposts; the title hash is not a
full-body content hash. Broadly identical titles can collide, and paraphrases can be missed.
No full text is available for stronger matching. Groups always report `confirmedFacts: 0`;
multiple channels never become verified facts by article count. Independence groups
describe provenance, not truth.

The journal is the recovery source of truth. Optional PostgreSQL projection uses existing
append-only raw evidence and NewsDocument history, transactionally and idempotently.
If projection fails after capture, use `poll-status --persist` after repairing the database;
no new HTTP request is needed. Existing SQL migrations and `news-document.v1` are unchanged.

## Verification and handoff

Offline failure tests cover replay, interrupted attempts, 429 cooldown, exponential retry,
rolling quotas, dead letters, source expiry, unsafe endpoints, malformed data, uncertain
dates, tracking aliases, duplicate attribution, immutable first-seen/update history,
exclusive locks and corrupt journals. PostgreSQL tests cover the live parser's versioned
metadata projection and exact-repeat idempotency.

See `docs/progress.md` for actual commands, counts and live smoke evidence. The next
iteration recorded here was Module 04, Iteration 3, now documented in `docs/news-review.md`.
No semantic event claims are implemented.
