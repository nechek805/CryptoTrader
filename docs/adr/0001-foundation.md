# ADR 0001: Fixture-first TypeScript foundation

Date: 2026-10-30
Status: accepted for Module 02, Iteration 1

Completion note (Module 02 review, 2026-10-30): Iterations 2/3 now provide the versioned
domain/time/decimal primitives and immutable PostgreSQL event/revision/audit persistence.
ADRs 0002/0003 record those decisions. See `docs/foundation-handoff.md` for the reviewed
interfaces and actual checks. The decisions/limits below describe the original skeleton.

## Context

The project initially contained only the supplied roadmap. Module 02 must create a runnable,
reproducible development foundation before defining financial contracts or storing data.
The surrounding Projects directory is an unrelated Git checkout with existing changes.

## Decisions

- Initialize a standalone repository at CryptoTraider, preserving the enclosing checkout.
  Work begins on `codex/foundation`; no commit, remote or publication is implied.
- Pin Node 24.22.2 LTS, pnpm 10.34.9 and exact direct dependencies, with a pnpm lockfile.
  Install a checksum-verified portable Node under ignored `.tools/` for this workstation.
  Use the Node 24 LTS line rather than adopting a newly promoted major during bootstrap.
- Use strict TypeScript and NodeNext ESM. Internal source exports run through `tsx`;
  packaging production artifacts will be a separately scoped change.
- Use Fastify and Zod for the only HTTP route, `/health`, and runtime input validation.
  Use versioned operational schemas only; financial/domain contracts remain Iteration 2.
- `pnpm dev` runs a finite fixture task then starts a loopback-only API. Config rejects
  every non-fixture data mode. There are no exchange connectors, trading routes, signals,
  balances, orders or hidden mock provider substitutions.
- A synthetic three-symbol inventory demonstrates the package/worker/API path. It has
  no market prices, claims or strategy outputs. Fixture time and health time are distinct.
- Keep PostgreSQL/Redis optional until persistence is implemented. Compose provides
  loopback-only development services and health probes. Doctor marks them `not-required`
  instead of claiming successful connectivity. Local trust authentication carries no secret
  in `.env.example`; production deployment must choose proper authentication separately.
- Reserve later packages using private manifests and READMEs, without speculative code.
  The web workspace deliberately has no Next.js dependency before its backend gates.
- Tests and dry-run smoke use local fixtures/Fastify injection and require no provider
  credentials, authenticated requests, Docker or network access after dependency install.
- Generate correlation IDs locally. Redact authorization/cookies from structured logs;
  startup/CLI failures never reflect invalid environment values or fixture contents.

## Consequences and limits

This slice proves local wiring and failure behavior only. It does not establish point-in-time
research integrity, trading performance, persistence, live data quality or paper execution.
There are no money values requiring decimal representation yet. Iteration 2 adds domain
schemas, UTC/time-unit semantics, availability gates, decimal-safe values, hashes, seeded
randomness and clocks. Iteration 3 adds versioned database migrations and audit history.

Runtime configuration rejects unsupported modes before creating a listener. Dependency
installation and Docker image pulls require network access; fixture checks after installation
do not. Compose runtime verification requires a running Docker daemon. Exact image tags
are pinned but not digests. The project layout follows the master; no module is skipped.
