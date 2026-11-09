# ADR 0068: Independent live news paper experiment

Status: accepted, 2026-11-09.

The owner requested news-driven simulated trading after V6 historical comparison.
Collection already runs, but it does not create positions. Add a complete independent
forward path instead of mutating the frozen market worker or historical engines.

Freeze the existing V6 report and per-token selections. Use the same deterministic
news categories, actual observed availability, a five-minute minimum processing
delay and the next UTC hour. Ignore initial snapshots, old news, duplicates and
unclear categories. Historical qualification remains false; the run is exploratory.

Use five separate 10,000-USDT venue ledgers shared by ten tokens, collateralized
long/short exposures, conservative public-book fills, fees, borrowing, portfolio
risk limits and a 24-hour deadline. Persist immutable evidence, a hashed event chain,
positions and state in a new schema. A BullMQ worker plus PostgreSQL lease fences
duplicate writers and resumes the same run after restart.

Expose an authenticated dashboard with filters, exports, evidence and controls.
Add a separate outgoing-only Telegram queue/notifier; the original bot keeps sole
ownership of getUpdates. All credentials remain in protected private `.env` files.
No real-money endpoints, research refits, source-permission changes or deployment
backups are introduced.
