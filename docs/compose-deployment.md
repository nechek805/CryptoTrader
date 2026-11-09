# Compose deployment and BullMQ operations

Live news adds `news-api`, `news-collector` and `news-analyzer`, with a separate
database and compatible AI provider. See [news operations](live-news-engine.md)
for source permissions, the additional image build and private configuration.

Production uses `compose.production.yaml`. Default `compose.yaml` remains the
loopback-only development database fixture. Local `pnpm dashboard` still works.

On the VPS, run as root from `/opt/crypto-trader/current`:

```sh
docker compose --env-file /etc/crypto-trader/compose/project.env -f compose.production.yaml ps
docker compose --env-file /etc/crypto-trader/compose/project.env -f compose.production.yaml logs --tail 80 worker api
docker compose --env-file /etc/crypto-trader/compose/project.env -f compose.production.yaml up -d --wait
```

No environment values must be entered on each run. Private service environment
files and Compose settings persist under `/etc/crypto-trader/compose`.
`infra/compose/prepare.py` generates them once from the previous protected VPS
settings and refuses to overwrite secrets. Do not print expanded configuration
or commit those files. Validate with `config -q`.

## Services and storage

| Service     | Responsibility                                      | Persistence                            |
| ----------- | --------------------------------------------------- | -------------------------------------- |
| gateway     | Website login, API proxy authentication             | Protected host config                  |
| web         | Next.js dashboard                                   | Image, temporary cache                 |
| api         | Fastify research APIs and paper read/control facade | Existing research directory            |
| worker      | BullMQ ticks, public feeds, sole paper state writer | PostgreSQL and research directory      |
| postgres    | Runs, positions, sources, immutable journal         | External `crypto-trader-pgdata` volume |
| redis       | BullMQ schedules, jobs, retries, events             | `crypto-trader-queue-data` volume, AOF |
| maintenance | Disabled; optional `backups` profile only           | No backup files retained               |

Only `127.0.0.1:3110` is published. Shared host nginx terminates HTTPS and proxies
to the gateway, which enforces the existing website login. Host Certbot renewal
stays active. PostgreSQL, Redis, API, web and worker have no host ports. Docker
boot and `unless-stopped` policies restart services; schedules persist in Redis.
Closing SSH or a browser does not stop the stack.

The live-paper page displays BullMQ health and counts. Authenticated
`GET /api/queue-status` provides connection status, last tick and adapter hash.
Port 3102 requires a private RPC token and must remain internal. Failed jobs stay
in BullMQ's failed set; investigate the reason before retrying a control command.
API and worker have separate event loops. A cold API start verifies all historical
archives and can take several minutes on this one-CPU VPS.

## Build, restart and verify

```sh
docker compose --env-file /etc/crypto-trader/compose/project.env -f compose.production.yaml build api
docker compose --env-file /etc/crypto-trader/compose/project.env -f compose.production.yaml build worker
docker compose --env-file /etc/crypto-trader/compose/project.env -f compose.production.yaml up -d --wait
docker compose --env-file /etc/crypto-trader/compose/project.env -f compose.production.yaml restart worker
docker compose --env-file /etc/crypto-trader/compose/project.env -f compose.production.yaml exec -T worker node --import tsx apps/cli/src/live-paper.ts verify
```

Node services share a common runtime base; the paper worker adds a small queue
adapter layer so operational fixes can deploy independently of API archive checks.
Build the API base first, then the worker. Preserve frozen financial source bytes during
a run. Restarting resumes its saved deadline; downtime cannot create backfilled
trades. Shutdown drains active jobs. A lost PG lease requires a process restart.
Redis recovery resumes durable jobs; PG receipts prevent duplicate committed
controls even after Redis job removal. AOF fsync is once per second, so sudden
host failure can lose recent queue data.

Server backups were disabled and removed at the user's request on 2026-11-08.
The maintenance container is removed, its BullMQ queue is paused with no scheduled
or pending backup jobs, and the old host backup timer is disabled. Normal Compose
startup excludes the optional `backups` profile. `BACKUPS_ENABLED=0` is persisted
in the private project configuration; the maintenance command and host backup
script exit without creating files unless explicitly enabled. Do not create
pre-deployment dumps or configuration backup copies, or re-enable scheduling,
unless the user asks to change this policy. Live databases and research history
remain present.

## Migration and rollback

Stop the old systemd writer before starting the Compose worker. Reuse the exact
PostgreSQL volume, and never run two PG servers against it. Run ID, balances,
positions, deadline and events survive. Frozen financial sources stay unchanged;
queue adapter identity is recorded separately. Disable old API/web/backup units
after Compose routes pass. Shared nginx and Certbot remain independent.

For rollback, stop Compose worker and maintenance first, then gateway/API/web and
PG. Preserve both volumes. Restore the old nginx vhost and release symlink. Start
the retained old PG container only after the new one is stopped. Start legacy
API/web units, run `nginx -t` and reload nginx; keep the backup timer disabled
unless the user changes the backup policy. Inspect run and journal integrity. Committed
queue controls remain in PG; their extra START/CONTROL metadata is compatible
with the financial recording verifier.

Never use `down -v`, remove `crypto-trader-pgdata`, delete research data, or run a
global Docker prune on this shared server.

## Telegram position alerts

The `telegram` service uses its own private `telegram/.env`, restricted PostgreSQL
role, notification schema and BullMQ queue. Its thin image extends the pinned worker
image without modifying the financial engine. Deploy only this service with
`up -d --no-deps --wait telegram`; do not restart the trading worker or create backups.
No inbound port or nginx route is needed. See [Telegram notifications](telegram-notifications.md)
for configuration, owner-only commands, delivery guarantees and health checks.

## Tests

```powershell
$env:TEST_DATABASE_URL='postgresql://research@127.0.0.1:55439/postgres'
$env:TEST_REDIS_URL='redis://127.0.0.1:6379/0'
pnpm exec vitest run --config vitest.integration.config.ts tests/paper-queue.integration.test.ts
pnpm check
pnpm run doctor
```

Use isolated Redis/PG fixtures. Integration tests cover schedules, authentication,
command receipts after job removal, controls under slow-feed load, run fencing, retained failures, lease loss and
restart recovery. They never place exchange orders or start a production run.
