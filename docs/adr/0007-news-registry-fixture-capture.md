# ADR 0007: Policy-led news registry and immutable fixture capture

Date: 2026-10-31 (Europe/Moscow). Status: accepted for Module 04, Iteration 1.

## Context

News source access, storage rights and knowledge time must be explicit before enabling live
ingestion. A publication timestamp does not prove first availability. Repeated or syndicated
articles do not independently verify a claim. Existing PostgreSQL already supports immutable
NewsDocument history.

## Decision

Activate `@crypto/news` with a declarative, versioned provider/source registry and bounded
capture/document stores. Source policy includes ownership, region, independence, license,
allowed fields, polling and payload limits, known time and explicit live approval. Register
synthetic sources only; optional RSS/GDELT provider types stay disabled.

Parse RSS/Atom/JSON Feed as inert data with strict structural, namespace, URL and timestamp
rules. Retain only permitted normalized fields and raw bodies authorized by source policy.
Hash-only captures preserve attribution without retaining prohibited body text. A later
headline creates an immutable version; first observed time stays stable. Unknown historical
availability stays descriptive. No cross-source inference or event claims are performed.

Use native HTTPS with validated public DNS answers pinned to socket lookup, original TLS
hostname validation, no redirects, and bounded responses/deadlines. The primitive exists for
future approved adapters; this iteration enables no network feed or polling loop. Tests use
injected DNS/transport. Parser/range dependencies are pinned in the lockfile.

Persist registry/capture/metadata as new versioned event payloads and documents through the
existing append-only repository. Preserve strict old schemas and migration checksums. Config
records use fixture/derived provenance, and public captures must carry their own public origin.
Registration is transactional and exact-repeat idempotent.

## Consequences

Fixtures demonstrate attribution, copy dependencies, false rumors, language/timezone variance,
missing dates, changed headlines and malformed feeds without obtaining real article content.
The source ledger is reviewable in JSON/CLI. Safe transport does not establish source rights;
activation, scheduled quotas, retries, repost deduplication and source-specific terms checks
are Iteration 2. Analyst corrections/export are Iteration 3; semantic claims begin in Module 05.
See `docs/news-registry.md` for actual checks, storage boundaries and limitations.
