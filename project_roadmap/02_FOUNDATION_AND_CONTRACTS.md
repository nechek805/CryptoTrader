# Module 02 — Foundation, Repository and Domain Contracts

## Objective
Create the TypeScript monorepo, core schema packages, reproducible dev environment and deterministic test harness. Every later module depends on shared semantics rather than ad-hoc interfaces.

## Inputs and Dependencies
`01_MASTER_PROMPT.md`. No provider credentials, no live order or customer data.

## Iteration 1 Prompt — Runnable Skeleton
You are implementing **Module 02, Iteration 1 only**. Create a pnpm TypeScript monorepo with the packages/apps in the master layout (empty packages only where necessary). Enforce strict TypeScript, shared tsconfig, ESLint/Prettier, Vitest, a Docker Compose stack with PostgreSQL and Redis, `.env.example` containing *no secrets*, a health endpoint, a CLI `doctor` command, CI workflow and contributor README. Install a supported Node LTS and pin tooling with a lockfile. Add a one-command local startup with fixture-only mode and a dry-run smoke test. Make no external authenticated requests. Stop after documenting exact test commands and running available checks.

### Acceptance
`pnpm install`, `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm dev` are documented; `docker compose up` health probes work when Docker is available; no unused public trading endpoints; tests are runnable offline.

## Iteration 2 Prompt — Schemas, Clocks and IDs
Implement versioned Zod schemas and TypeScript types for `EventEnvelope`, `MarketBar`, `NewsDocument`, `EventClaim`, `SignalCandidate`, `RiskDecision`, `SimulatedOrder`, `SimulatedFill`, `LedgerEntry` and `ExperimentManifest`. Define typed UTC time and time-unit conversion helpers, `availableAt` gate, monotonic synthetic clock, deterministic IDs and canonical hashing. Use arbitrary precision decimal representation (e.g., decimal.js) for money and quantities. Build a deterministic mock clock and a controlled-seed random source. Include contracts for missing/uncertain values, quality flags and provenance. Document the semantics of all time fields and never infer milliseconds/microseconds from the number of digits.

### Acceptance
Round-trip serialization tests; randomized malformed timestamp rejection; sample fixtures validate; timestamps with future `availableAt` are ineligible; money never uses float equality; code review demonstrates a model cannot see data later than its decision.

## Iteration 3 Prompt — Persistence and Event Log
Implement PostgreSQL migrations and repositories for raw event envelopes, normalized market bars, news documents, run metadata, experiments and append-only audit. Idempotent upserts require source+raw ID or content hash. Add database transactions, pagination, retention controls and data provenance references. Separate immutable raw ingestion from derived corrections. Provide seed/clean commands for local fixtures, migration rollback/forward tests and duplicate-delivery tests.

### Acceptance
Ingesting same fixture twice leaves exactly one logical record; derived updates preserve history; no full licensed articles in logs; migration from a clean DB is reproducible; run manifest captures code/config/data hashes.

## Handoff / Review Prompt
Audit the module against Master Invariants 1–10. Identify any timestamp ambiguity, schema drift or insecure defaults; run actual gates, fix blocker defects, write `docs/adr/0001-foundation.md`, then provide an interface summary to Modules 03 and 04. Do not start those modules.
