# 0059 — Compose services and durable BullMQ jobs

Date: 2026-11-06. Status: accepted.

The owner requested Compose for the application and BullMQ for queued work.
`compose.production.yaml` manages PostgreSQL, Redis, a public-feed paper worker,
Fastify API, Next.js, authenticated nginx gateway and maintenance worker.
Shared host nginx and Certbot remain the HTTPS edge for this and other sites.
They forward this site's requests to the loopback gateway on port 3110.

## Scheduling and transactions

BullMQ 6 Job Schedulers enqueue public-feed checks every five seconds. One worker
processes ticks and START/PAUSE/RESUME/STOP commands with concurrency one and a
PostgreSQL advisory lease. The frozen financial engine still enforces freshness,
hourly decisions, risk limits, quote consumption and the saved run deadline.
Its legacy recursive timer is never started in Compose mode. Historical CLI
research and news fixtures remain explicit finite operations; this change does
not start an unconfigured live news crawler.

Controls have priority 1 and ticks priority 10, including scheduler templates.
BullMQ's unprioritized jobs outrank positive priorities, so leaving recurring ticks
unprioritized could starve controls when feeds are slower than the schedule.
The paper worker uses a small image layer over the common Node runtime base so
queue adapter changes can deploy without interrupting API archive verification.

Ticks have three attempts, exponential backoff and bounded completed/failed
retention. Failed jobs remain in BullMQ's failed set for inspection. Ticks older
than 90 seconds are discarded; subsequent jobs use actual fresh public quotes.
Retries are at least once. Durable engine watermarks and deterministic position
identity prevent duplicate financial actions. No missing interval is filled with
invented executions. Lost database leases mark the worker unhealthy and trigger
a process restart to acquire a fresh lease.

Every control receives a UUID and expected run ID. Its identity, input and response
commit inside the same immutable START/CONTROL event as the state transition.
Retrying a committed UUID returns its original response even after Redis job
removal. Reusing an ID for another action or targeting a different run is rejected.
Commands expire after two minutes except STOP; expiry never cancels a committed
receipt. The adapter temporarily decorates the legacy store's `change` method
only while executing a serialized command on the leased transaction connection.
It must not be used with concurrent handlers on that store. TICK event payloads
and financial engine source bytes remain unchanged.

A separate versioned PostgreSQL namespace records adapter boot hashes and the
prior ledger head. Existing events are never rewritten. Authenticated private RPC
connects the API to the writer; the API has its own database read facade. Only
internal networks expose RPC, Redis and PostgreSQL. Dashboard queue status shows
health, counts and last completed tick.

## Persistence and maintenance

Redis uses a password, AOF with every-second fsync, `noeviction` and a durable
volume. PostgreSQL reuses the existing external volume. Historical research stays
mounted from its existing directory. Containers use restricted users, memory/log
limits and restart policies; Node images have read-only roots.

A separate queue schedules daily PostgreSQL custom-format backups at 02:35 UTC.
The maintenance worker has no Docker socket, proxy secret or RPC token. It uses
the restricted database role and matching PostgreSQL 17 client, validates each
archive, writes by atomic rename, and keeps eight days of its own files. Backup
identity makes retries reuse a completed archive. Previous host backups remain.
AOF can lose roughly a second on sudden host failure; PostgreSQL receipts remain
authoritative for committed controls. Off-server backups are a separate recovery
requirement beyond this same-server backup boundary.

See [Compose operations](../compose-deployment.md) for deployment and rollback.
