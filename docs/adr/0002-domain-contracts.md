# ADR 0002: Versioned temporal contracts and deterministic research primitives

Date: 2026-10-30
Status: accepted for Module 02, Iteration 2

## Decisions

Add strict versioned Zod domain contracts while preserving the existing operational v1
interfaces. Keep primitive schemas and domain invariants in `@crypto/contracts`; core
depends on contracts for deterministic helpers. Both use pinned decimal.js 10.6.0 with
private contexts, avoiding shared global precision settings. There is no dependency cycle.

Normalize domain UTC strings to nine fractional digits, supporting 1970–9999 and rejecting
offset/local/leap-second input. Use explicit-unit bigint epochs and reject lossy conversion.
Use half-open market bars with duration matching the declared interval. Preserve raw
provider values and units separately. `SyntheticClock` is also the mock clock; timers and
wall time do not advance it.

Use nullable availability plus explicit basis/use labels. Only observed or defensible archived
captures qualify for eligibility; uncertain historical news remains descriptive. A decision
view validates, detaches, filters and deeply freezes inputs. Normalized temporal envelope
payloads cannot be promoted by earlier or more permissive envelope metadata. These are
contracts for trusted application code, not a security boundary around arbitrary model code.

Serialize financial amounts as bounded branded decimal strings (80 total digits, at most
36 fractional places). A 256-digit calculation context preserves finite arithmetic within
the supported input bounds; validate output limits rather than silently round. Division
requires an explicit scale and rounding choice. Validate cross-field arithmetic only after
its operands validate so malformed external data returns Zod issues rather than exceptions.

Define `canonical-json.v1` and SHA-256 content hashes explicitly rather than implying that
ordinary JSON insertion order is canonical. Reject ambiguous/non-JSON values. IDs include
a namespace and `id.v1` hash context. Use versioned Mulberry32 for repeatable non-security
randomness, and record seed/algorithm in reproducibility metadata and experiment manifests.

Represent missing/uncertain values without coercing them to zero or certainty. Retain source
chains, contradictions and quality flags. Validate simulated lifecycle and causal fill
constraints without implementing a broker. Immutable risk audits freeze nested reason arrays.

## Consequences

Callers must parse/normalize before hashing and use decimal helpers instead of numeric
money arithmetic. Imported availability needs attributable capture evidence. Candle adapters
must normalize inclusive provider end timestamps to exclusive domain ends. Providers with
dates before 1970 or unsupported timestamp precision require an explicit versioned decision.

There is no persistence migration because these domain records are new and not stored.
Production data collectors, dependency verification, independent-source corroboration,
slippage/queue/fill modelling, ledger idempotency and experiment launch remain later modules.
See `docs/contracts.md` for field semantics and exact public helper contracts.
