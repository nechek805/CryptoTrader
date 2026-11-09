# VPS paper-trading deployment

The current runtime uses [Compose and BullMQ](compose-deployment.md), replacing
the API/web systemd services and host backup timer described below. This document
retains the original deployment and recovery context; use the Compose runbook
for current status, logs and restarts. Shared host nginx and Certbot stay active.

Open <https://crypto-trader.nechek805.org/live-paper>. The website uses its own
operator username/password, not an exchange API token or the SSH root password.
The owner receives the generated login details through a private local file.
The server also stores them in `/etc/crypto-trader/website-access.txt`, readable
only by root. Do not copy this file, environment files or nginx proxy secrets
into the repository, logs or a public URL.

Once the ten feeds are LIVE, use **Start 24-hour paper run**. It runs on the VPS,
with 10,000 virtual USDT per exchange and fees on. The local computer and browser
can be closed. Check P&L and export filtered positions at any time. A network
outage blocks paper fills on the affected venue; a run awaiting fresh closing
quotes remains STOPPING rather than claiming completed-day profit.

## Status and logs

```sh
systemctl status crypto-trader-api crypto-trader-web
journalctl -u crypto-trader-api -u crypto-trader-web -n 50 --no-pager
curl -fsS http://127.0.0.1:3101/ready
docker inspect --format '{{.State.Health.Status}}' crypto-trader-postgres
systemctl list-timers crypto-trader-backup.timer certbot.timer
```

The API and web ports are 3101/3100 on loopback only. nginx exposes the protected
website on 443 and HTTP redirects/challenges on 80. PostgreSQL binds only to
127.0.0.1:55439. A cold API start verifies the historical archives and can take
several minutes on this one-CPU server. Other VPS applications are independent.

## Storage and persistent settings

| Path / resource                                          | Purpose                                              |
| -------------------------------------------------------- | ---------------------------------------------------- |
| `/opt/crypto-trader/current`                             | Symlink to the selected application release          |
| `/opt/crypto-trader/runtime`                             | Project-specific pinned Node and pnpm                |
| `/var/lib/crypto-trader/data`                            | Existing historical research and immutable artifacts |
| Docker volume `crypto-trader-pgdata`                     | Live runs, positions, quote evidence and journals    |
| `/etc/crypto-trader/app.env`                             | Persistent hosted mode, origins and app/DB secrets   |
| `/etc/crypto-trader/db.env`                              | Dedicated PostgreSQL container settings              |
| `/etc/nginx/sites-available/crypto-trader.nechek805.org` | This site's protected proxy configuration            |
| `/etc/letsencrypt/live/crypto-trader.nechek805.org`      | Certificate and private key                          |
| `/var/backups/crypto-trader`                             | Private compressed PostgreSQL backups                |

Do not delete the Docker volume or research data during code updates. Do not
reuse local fixture tokens on this public deployment. `OPS_MODE=hosted-paper`
enables authenticated hosting while local `.env` fixture mode remains unchanged.
The site retains the synthetic overview and historical pages; those balances
are separate from the real-public-data forward paper run.

## Restarts and recorded verification

The deployed application uses the restricted `crypto_app` database role. The
separate cluster administrator is root-only (`db-admin.env` where present) and
is not included in the application environment. Keep application source and
root-executed backup scripts owned by root after building a release; give the
service account write access only to its data and Next cache directories.

```sh
systemctl restart crypto-trader-api crypto-trader-web
```

systemd restarts the processes after failures and starts them at boot. The
database restores the same run and deadline. Missed market moves during downtime
are not backfilled. Avoid deliberately restarting during a 24-hour measurement.
Do not change execution source while a run is active: its engine hash is frozen.

For CLI status or replay, run as root with the persistent environment loaded:

```sh
set -a
. /etc/crypto-trader/app.env
set +a
cd /opt/crypto-trader/current
/opt/crypto-trader/runtime/node-v24.22.2-linux-x64/bin/node --import tsx apps/cli/src/live-paper.ts status
/opt/crypto-trader/runtime/node-v24.22.2-linux-x64/bin/node --import tsx apps/cli/src/live-paper.ts verify
```

The verification command checks recorded sources, decisions, fills and account
state without fetching a replacement price. It can verify a run in progress.

## Backups, TLS renewal and updates

Server backups were disabled and removed at the user's request on 2026-11-08.
The host backup timer stays disabled; the backup script defaults to disabled.
The Compose backup worker and schedule are also disabled. Do not create backups
or enable timers during a deployment unless the user explicitly requests it.

Check renewal with:

```sh
certbot renew --cert-name crypto-trader.nechek805.org --dry-run
```

For a code update, prepare a new directory under `/opt/crypto-trader/releases`,
install the locked dependencies and build Next.js there. Preserve source bytes,
symlink `data` to the persistent directory, and verify both build and financial
artifact compatibility before changing `current`. Keep the previous release
for rollback. Switch releases between runs where possible; do not reset the
database or regenerate old matrices as part of deployment. The source templates
are in `infra/vps`; `provision.py` is a first-install tool that refuses to
overwrite existing generated secrets or a preexisting site configuration.

This small VPS shares CPU with other applications. Run substantial historical
strategy searches locally while a forward run is collecting data. Monitor disk
space and keep the server's persistent data backed up separately when long-term
retention matters.
