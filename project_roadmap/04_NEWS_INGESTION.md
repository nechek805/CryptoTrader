# Module 04 — News Collection, Licensing and Temporal Capture

## Objective
Collect source-attributed news and official disclosures through authorized feeds. Preserve what the system **actually observed** and when. Do not confuse historical article metadata with historical tradability.

## Dependencies
02. Provider designs must allow GDELT and approved RSS/official sources as optional adapters; verify terms before enabling any source.

## Iteration 1 Prompt — Provider Registry and Fixtures
Create `NewsProvider`, `NewsSource`, and `NewsDocument` stores. Add a declarative registry containing source owner, region, reliability notes, publication type, update cadence, access method, redistribution/license restrictions, source independence group, polling limit and allowed fields. Implement fixtures for official security statements, independent reporting, syndicated copies and false rumors; parse feeds without treating article content as executable instructions. Enforce URL allowlists, safe HTTP, payload size limits and SSRF protection.

### Acceptance
Fixture parser handles language differences, time zones, missing published time, updated headlines and malformed XML/JSON; source registry rejects unknown feeds by default; article hash and version recorded.

## Iteration 2 Prompt — Live Ingestion and Deduplication
Implement one permitted RSS/official feed adapter and one optional news aggregation adapter behind flags; license-check gates must be documented. Scheduler records `firstObservedAt`, `publishedAt` if available, `updatedAt`, `availableAt` and ingestion latency. Canonicalize URLs, detect duplicate content and reposts while preserving separate article occurrences and attribution. Store minimal permissible excerpts and hashes rather than copying whole paywalled articles. Add retries with exponential backoff, request quotas and dead-letter handling.

### Acceptance
Same article republished by multiple channels does not become multiple independent facts; delayed/updated articles retain the original first-seen record and version history; rate-limit fixture does not create hot retry loop.

## Iteration 3 Prompt — News Review Queue and Historical Caveats
Create analyst review interfaces/API for unparsed articles, legal restrictions and suspicious timestamps. Implement an append-only corrections ledger and an export `news snapshot` with source/version hashes. Tag historical records as `POINT_IN_TIME_VERIFIED`, `POINT_IN_TIME_ESTIMATED` or `DESCRIPTIVE_ONLY`; the last category must be excluded from trading replay. Add a report of percent of articles with defensible first-observed timestamps and source coverage by language.

### Acceptance
A fabricated historical publication time cannot satisfy the point-in-time gate; corrections do not rewrite past decision views; a manual analyst override records operator, reason and timestamp.

## Handoff / Review Prompt
Create a provenance-ready article fixture package and a source license ledger. Explain which historical/news feeds can be used for real-time paper signals versus descriptive studies only. Do not implement semantic event claims here.
