# News registry and fixture ingestion

Module 04, Iteration 1. Verified 2026-10-31 (Europe/Moscow). All news inputs supplied here
are locally authored synthetic data. Execution remains disabled. Live news collection,
scheduling and repost deduplication were subsequently implemented in Iteration 2; see
`docs/news-live.md`. Semantic claims remain a later module. This document preserves the
Iteration 1 fixture evidence and original checks.

## Commands

Use the pinned Node 24.22.2 / pnpm 10.34.9 PATH from the root README.

```powershell
pnpm news registry
pnpm news fixtures
pnpm news fixtures --persist
```

`registry` prints the source license/policy ledger. `fixtures` reads only known local files,
ingests them, and prints hashes, article versions and diagnostics. `--persist` uses
`DATABASE_URL` and `DATABASE_SCHEMA`; run `pnpm db:migrate` for that configured namespace
first. It is transactional and repeatable. Unsupported URLs, credentials and flags fail
without reflecting their values. No command starts a news poller or contacts fixture hosts.
Existing operational health/doctor still describe fixture application readiness.

The local ledger is `tests/fixtures/news/registry.json`; capture order/times are in
`tests/fixtures/news/captures.json`. Disabled optional RSS/Atom and GDELT provider records
reserve adapter types. They have no enabled source, terms approval or ingestion behavior.
Their presence does not grant a data license or assert independence.

## Registry and stores

Strict versioned contracts live in `packages/contracts/src/news-ingest.ts`:
`news-provider.v1`, `news-source.v1`, `news-registry.v1`, `news-capture.v1`,
`parsed-news-item.v1`, `news-parse-result.v1`, `news-document-version.v1`, and `news-store.v1`.
The existing strict `news-document.v1` remains unchanged.

Each source declares owner, region, reliability notes, publication type, independence group,
languages, exact feed URL, allowed article origins, format/access method, cadence, per-day/
minimum-interval polling policy, allowed fields, license reference/restrictions, excerpt/raw
retention permissions, live approval, payload/item/timeout bounds, revision and `knownAt`.
Publication types are official security, independent reporting, syndicated and unverified
rumor. These labels describe attributable source policy; they are not verified event claims.

Registry versions are copied, frozen and checked for unique identity, known provider, policy
consistency, URL safety and increasing knowledge time. A source lookup requires a known
enabled provider and an exact configured feed. Unknown feeds are rejected. Source policy
changes apply by knowledge time; a revision change between capture and processing fails
closed instead of weakening policy. Fixture/live permissions cannot be interchanged.

`NewsProvider` accepts a resolved source and returns a versioned capture. A fixture ID is
specific to `FixtureNewsProvider`; future RSS/JSON/GDELT adapters can read a source without
a fixture ID. The fixture provider accepts only manifest IDs, bounded regular files and valid
UTF-8, preserving original feed bytes/hash. It performs no network requests.

`NewsIngestStore` retains captures, parse diagnostics and append-only versions. Identity is
source plus provider item ID. Reusing an ID for another canonical URL is a conflict. A later
headline/content update creates a version linked to its predecessor, preserves first observed
time and changes the normalized content hash. A-B-A reversions create a third version.
Exact repeated captures and unchanged latest content do not create another document version;
new capture occurrences are still retained. No cross-source semantic deduplication occurs.

`history` and `documentsAt` validate cutoffs. They select the latest version knowable at the
cutoff before checking eligibility, so an unknown/descriptive correction cannot resurrect an
older eligible version. Returned state/views are detached or frozen. The store is bounded to
1,000 captures and 2,000 document versions; it is a fixture/local integration boundary.

## Feed parsing and temporal evidence

Supported profiles are RSS 2.0, Atom with the standard Atom namespace, and JSON Feed 1.1.
Only registry-approved fields become normalized metadata. JSON body/HTML fields are ignored.
An approved snippet is reduced to inert text and bounded by the source license. Disallowed
snippets are absent, even when supplied in the feed. Raw retention is a separate permission:
metadata-only sources retain an empty body, `HASH_ONLY`, original byte hash and allowed
parsed fields. Unsupported raw content is not placed in document receipts or database rows.

Strict XML parsing refuses DTD/entity declarations, unknown entities, stylesheet processing
instructions, malformed trees and excess depth/nodes/attributes/text. No XSLT, external
entity, enclosure, image, article page or feed-provided command is executed or fetched.
Instruction-like article text remains untrusted data. Consumers must continue escaping text
if a later UI displays it. This slice does not extract or verify semantic event claims.

RSS numeric/GMT/UT time offsets and ISO timestamps with explicit offsets normalize to UTC
nanoseconds. Offset-free times, unknown local abbreviations, negative-zero unknown zones,
invalid calendar dates, mismatched RFC weekdays and leap seconds are refused. Nine fractional
digits survive conversion. Host-local timezone and timestamp magnitude are never inferred.
Missing publication time is accepted and flagged; it is not synthesized from capture time.
Provided invalid item dates quarantine the item. Future provider timestamps are marked
uncertain and remain separate from local knowledge time.

`publishedAt`/provider `updatedAt` and their raw source strings stay distinct from actual
`observedAt`, processing availability and first observation. A document becomes available
when its capture is processed. Publication metadata cannot backdate availability. Captures
with `UNKNOWN` historical availability remain `DESCRIPTIVE_ONLY` with null availability.
Synthetic observed fixtures are eligible only as synthetic inputs; they are not evidence of
real historical news availability or a paper-tradable signal.

Malformed whole feeds produce explicit rejected-feed records and no partial accepted items.
Bad item schemas, article origins, language/date/text fields and duplicate provider IDs yield
indexed rejections. Every occurrence of a repeated provider ID is rejected. Allowed languages
come from item/feed metadata or the explicit registry default; no language model guesses.
Syndicated fixtures share the independent reporter's registry independence group. There is
no automatic upstream document graph or corroboration score; five articles do not imply
five independent facts.

## HTTPS and SSRF boundary

The low-level `readNewsHttps` primitive is tested for future adapters. It requires a validated
`PUBLIC_HTTPS` source with explicit live approval. The fixture registry approves none.
An eventual adapter must resolve its authoritative registry entry first; it must not construct
source policy from article content or an untrusted request body. Poll scheduling/quotas and
authorized source activation are Iteration 2 work; they are not an active service here.

URL policy permits HTTPS with ordinary hostnames and the standard port. It rejects credentials,
IP literals/encoded-IP forms, local/single-label hosts, fragments, backslashes, controls,
nonstandard ports and encoded traversal/path tricks. Article origins must match the exact
source allowlist. Feed URLs are exact registry entries; article URLs are not fetched.

DNS validates all A/AAAA results, refusing mixed public/private answers, private/link-local/
loopback/multicast/reserved ranges, mapped addresses and tunnel/translation ranges. It then
pins the chosen validated address into the actual socket lookup. TLS hostname/certificate
checks retain the original hostname. No second hostname resolution or redirect following
can substitute a private endpoint. Requests use GET, no proxy agent/cookies/authorization,
fixed headers, identity encoding and bounded DNS/request deadlines. Non-200 responses,
redirects, wrong content types and compression are refused. Declared and streamed sizes
are capped; a stalled body has a deadline.

Sources allow at most 256 KiB, 100 items and a 10-second stage timeout. Fixture policy is
32 KiB, 10 items and one second. XML additionally caps depth at 16, nodes at 3,000,
attributes at 16 per element and text at 16,384 characters per node. All HTTP tests use
injected transport/DNS and make no external feed requests. Actual network source readiness
has not been established.

Parser/range handling uses exact pinned `sax` 1.6.1, `ipaddr.js` 2.5.0 and development
types `@types/sax` 1.2.7. Implementation references are the official
[sax documentation](https://github.com/isaacs/sax-js) and
[ipaddr.js documentation](https://github.com/whitequark/ipaddr.js). DTDs are explicitly
rejected by this application; parser defaults are not relied on for source authorization.

## PostgreSQL compatibility and actual checks

`persistNewsStore` uses existing transactional append-only storage:

- Versioned provider/source policy records become typed registry raw events.
- Capture/parse receipts preserve bytes only when licensed, otherwise hashes and approved fields.
- Existing `appendNewsDocument` retains news history and source references.
- Version metadata receipts retain original publication/update strings, independence group,
  source policy hash and the actual database version ID.

Registry configuration is fixture/derived evidence; optional disabled providers are not labelled
as captured real news. Ingested public documents would retain their own public origin. Existing
SQL migrations, `news-document.v1`, research-run schemas and old market evidence are unchanged.
These new versioned payloads require no SQL migration. A failed registration rolls back as one
transaction; aliases, captures, versions and receipts are idempotent on exact repeat.

Fixture acceptance results:

| Input                                        | Outcome                                                                                       |
| -------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Official security RSS, then changed headline | One article, two immutable versions; same first observation                                   |
| Independent Atom                             | Russian and English articles, explicit offsets, nanosecond update, one missing published time |
| Syndicated JSON                              | Separate occurrence, shared independence group, no retained body or snippet                   |
| False-rumor JSON                             | Unverified fixture label; instruction-like content stays inert                                |
| Broken XML and JSON                          | Two rejected feed captures, no partial documents                                              |

Actual 2026-10-31 checks passed: **189 offline tests** (54 news tests), **23 actual PostgreSQL
18.4 tests** (three new), `pnpm check`, `pnpm run doctor`, and frozen offline dependency
installation. All 17 original roadmap hashes verified. The isolated project PostgreSQL cluster
was stopped afterward; the separate Windows service was untouched. Remote CI/Docker were
not run locally. No external news feed was fetched.

The fixture CLI reports 3 providers, 4 sources, 7 captures, 5 article occurrences, 6 versions,
2 rejected feeds and 1 hash-only capture. Registry hash:
`sha256:49af08079add7bf352122040c9dbc195c4ff52e4642dafaf27242c65fd5844e8`.
Final fixture state hash:
`sha256:132f2643937d0bcad93d13aea0457f4d42a0c0c8f4a479653aae6b47aafcaee3`.

An actual fixture registration into isolated namespace `crypto_fixture_news` created 7 registry
records, 7 captures, 6 document versions and 6 metadata receipts. Audit: **46 entries** with head
`sha256:c04a35353f690d967410ff89c1bccb327e25c1720e2baba5ca711edd63a4face`.
Repeating the command added zero records and retained that head. Current code at capture:
`working-tree:sha256:2a5c6eabff88bf962d583499e3ed556a7bd34480d21b2347ec356cd42d02b8b5`.

Next is Module 04, Iteration 2: approved live ingestion, scheduling, occurrence-preserving
URL/content deduplication, retries and dead-letter behavior. Review each source's current
terms before enabling it. Historical publication metadata alone remains descriptive for
trading research. No semantic event claims are part of Module 04.
