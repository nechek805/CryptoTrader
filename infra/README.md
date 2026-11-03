# Local infrastructure

Run the root `compose.yaml` with `pnpm infra:up`. PostgreSQL and Redis have readiness
probes and persistent development volumes. `pnpm infra:down` preserves stored data.

The fixture application does not depend on either service. Explicit persistence commands
and integration tests require PostgreSQL. `local-postgres.ps1` can start/stop an isolated
Windows fixture cluster using installed PostgreSQL binaries, with no Docker dependency.
It sets connection environment variables in the current PowerShell session; see
`docs/persistence.md`. Production deployment, queue workers and exporters remain later work.
