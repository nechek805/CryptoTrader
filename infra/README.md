# Local infrastructure

Run the root `compose.yaml` with `pnpm infra:up`. PostgreSQL and Redis have readiness
probes and persistent development volumes. `pnpm infra:down` preserves stored data.

The fixture application does not depend on either service. Explicit persistence commands
and integration tests require PostgreSQL. `local-postgres.ps1` can start/stop an isolated
Windows fixture cluster using installed PostgreSQL binaries, with no Docker dependency.
It sets connection environment variables in the current PowerShell session; see
`docs/persistence.md`.

The owner-authorized VPS deployment uses `compose.production.yaml` and the
templates in `infra/compose`. See [Compose operations](../docs/compose-deployment.md).
Generated secrets live under `/etc/crypto-trader/compose`. Shared host nginx and
Certbot remain the HTTPS edge; unrelated server applications are preserved.
Previous `infra/vps` systemd templates remain available for rollback.
