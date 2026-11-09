# 0058 — Authenticated VPS deployment of forward paper trading

Date: 2026-11-06. Status: accepted. The owner explicitly requested deployment to
their Ubuntu VPS and `crypto-trader.nechek805.org`, with nginx and a registered
HTTPS certificate. This uses the owner's infrastructure, not Sites hosting.

## Boundary

The deployment remains simulated. All exchange requests are public GETs;
positions, balances and fills are internal PostgreSQL records. No exchange
credentials, funded accounts or real order APIs are introduced. The existing
VPS applications and their services, nginx vhosts, containers and databases are
preserved. The SSH password is used only for authentication and is not embedded
in source, shell arguments, website credentials or deployment archives.

`OPS_MODE=hosted-paper` combines the existing clearly labeled synthetic research
overview and retained historical archives with the separate live public-feed
paper service. Unlike local fixture mode, it uses DEPLOYMENT security, fresh
random reader/admin tokens, HTTPS origin checks and no fixture auto-login.
Historical financial sources and immutable result IDs are unchanged.

## Browser authentication

The dedicated nginx HTTPS vhost requires an operator login for the whole site,
including API paths. nginx injects a separate random proxy secret only into its
loopback API upstream and replaces any client-supplied value. The API accepts
that header only in DEPLOYMENT mode, checks its hash in constant time, and grants
the authenticated operator ADMIN access. The proxy secret must differ from both
API token hashes. Anonymous and forged-header requests remain unauthorized;
mutation requests still require the configured Origin when using proxy/session
authentication. Deployment READ tokens cannot mutate paper runs or research jobs.
No application API token is sent to JavaScript or requested from the operator.

Proxy credentials are trusted only because nginx enforces login and port 3101
binds exclusively to loopback. Do not publish that port, remove `auth_basic`, or
forward client proxy headers unchanged. Token-based deployment remains available
without enabling the proxy boundary. Local fixture behavior remains unchanged.

## Runtime and persistence

Node 24.22.2 and pnpm 10.34.9 are installed under `/opt/crypto-trader/runtime`,
leaving the server's system Node intact. The current workspace snapshot, including
all six historical market research trees, is deployed as a versioned release.
`/opt/crypto-trader/current` selects the release; its `data` symlink targets
`/var/lib/crypto-trader/data`, which survives code updates. Preserve frozen source
bytes: changing line endings can invalidate content-addressed historical engines.

The production Next.js build and API/worker run as the unprivileged
`crypto-trader` user in separate systemd services. Restarts are automatic and the
services are enabled at boot. The API owns the existing fenced PostgreSQL worker
lease and resumes any saved run's original deadline. Closing a browser, SSH
connection or local desktop does not stop the server processes.

An independent PostgreSQL 17 container uses its own Docker network and persistent
volume. It binds `127.0.0.1:55439` and does not reuse the server's existing
PostgreSQL container. Container restart policy is `unless-stopped`; credentials
are generated on the server and stored in root-only environment files.
The application database role owns its database and schema but has no superuser,
role-management, database-creation, replication or row-security bypass privileges.
The separate cluster administrator is not placed in the app environment.

The server has one CPU and approximately 2 GiB RAM. The deployment adds its own
2 GiB swap file and memory limits for the new services; it does not stop other
applications. A cold startup verifies the accumulated historical archives before
the API becomes ready. Prefer local historical research while collecting forward
results on this small server; large synchronous research jobs share API CPU.

## TLS and backups

The new nginx vhost is validated before reload. A separate Let's Encrypt
certificate is obtained with the existing Certbot account through the HTTP
webroot challenge. Other vhosts and certificates are unchanged. HTTP redirects
to HTTPS, while the challenge directory remains available for renewal. The
existing Certbot timer renews the certificate; the dedicated deploy hook reloads
nginx when this domain's certificate changes.

A daily systemd timer writes transaction-consistent compressed `pg_dump` backups
to `/var/backups/crypto-trader`. The script validates each archive's catalog
before publishing it and retains seven days of backups. Backups and generated
login details are private; they are not web routes or committed source.

See [VPS operations](../vps-deployment.md) for status, recovery and update commands.
