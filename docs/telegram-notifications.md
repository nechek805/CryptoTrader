# Telegram paper-position notifications

The independent `telegram` Compose service watches committed live-paper ledger events.
It sends alerts for an opening fill and for a completed close, including exchange, token,
side, entry/exit price, USDT value, fees, financing, final net P&L and position/run IDs.
Partial closing fills do not generate final-close alerts. All messages say SIMULATED.
Historical research runs do not generate Telegram alerts.

The separate [news forward experiment](news-forward-paper.md) has its own outgoing
notifier and durable outbox in the news database, using the same private recipient.
Alerts identify `NEWS_V6`. It does not poll Telegram updates. The existing bot's
`/status` and `/positions` commands continue to show the market account; the news
dashboard shows the new experiment. News-alert retry failures are retained for
operator review; the original bot's `/start` recovery applies to its market outbox.

Set `TELEGRAM_ENABLED=1`, `TELEGRAM_BOT_TOKEN` and `TELEGRAM_USER_ID` in a private
`.env`. The production file is `/etc/crypto-trader/compose/telegram/.env` (mode 600).
It also supplies `TELEGRAM_DATABASE_URL`, `REDIS_URL` and `TELEGRAM_DASHBOARD_URL`.
Never put credentials or the actual owner ID in source, images, browser code or logs.
`infra/compose/prepare-telegram.py` provisions a restricted database role and private
runtime configuration. It does not create backups.

Only the configured user's private chat is accepted: both sender and chat IDs must
match, the chat must be private, and bot senders are rejected. All other updates are
silently ignored. Every outgoing message uses the configured recipient, never an
incoming chat ID. Commands are read-only: `/start`, `/help`, `/status`, `/positions`.
`/start` also retries exhausted deliveries after the owner unblocks the bot.
If Telegram requires initial contact, open the bot's private chat and press Start.

The service has SELECT access to the financial runs, positions and event tables and
writes only its own notification schema. It cannot change trades. A singleton lease,
transactional cursor/outbox, unique position-event keys and persisted Telegram offset
preserve progress over restarts. First installation skips pre-existing history;
positions already open can still generate future close alerts.

BullMQ delivers outbox IDs with one worker, rate limiting, eight attempts, exponential
backoff and Telegram's retry-after delay. Failed alerts remain visible in the outbox.
Delivery is at least once: a crash after Telegram accepts a message but before the
database acknowledgment may produce a duplicate. Normal scans and restarts do not
replay acknowledged alerts. Telegram outages do not block the trading worker.

Build and start only the notifier with the production Compose file and private project
env. No incoming port, nginx change, trading-worker restart or database backup is
required. `/tmp/telegram-status.json` and the container health check expose polling and
scan freshness without credentials. Existing bot webhooks cause startup to fail safely.

Unit tests cover authorization, secret redaction, message formatting and API failures.
PostgreSQL/Redis integration tests use isolated schemas and synthetic positions, with
mocked Telegram delivery; they never send synthetic trades to the real owner.

Production verification on 2026-11-08 confirmed a healthy notifier, one acknowledged
connection message, preserved cursors after restart, no duplicate welcome, and no
financial-table write privileges. Existing financial/news service start times and
frozen source hashes were unchanged. `pnpm check` passed 1,202 tests in 71 files;
the six PostgreSQL/Redis notification integration tests and runtime doctor passed.
Backups remain disabled and absent.
