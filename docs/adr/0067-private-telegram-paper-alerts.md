# ADR 0067: Private Telegram paper-position notifications

Status: accepted, 2026-11-08.

The user requested open/close position notifications and owner-only bot interactions,
with credentials in `.env`. Existing financial and research engines must remain frozen.

Use a separate outbound-only Compose service, a restricted PostgreSQL role, durable
event cursors and outbox, and an independent BullMQ delivery queue. Read only committed
live-paper fills; do not add callbacks, triggers or network calls to the trading worker.
Skip historical events on first installation and preserve offsets on restart.

Validate both private-chat and sender IDs against the configured owner. Always send
to the environment recipient. Commands expose status only; no trading controls. Keep
token-bearing URLs and raw upstream errors out of logs. No deployment backups are made.

Retries tolerate transient failures, but Telegram has no client idempotency key:
delivery remains at least once across the send/ack crash boundary. Read-only ledger
access isolates notifier failures from financial state.
