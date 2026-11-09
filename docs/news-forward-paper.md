# Live news-only paper trading

The `/news-paper` dashboard runs an independent 24-hour forward experiment using
new public news and executable public spot books from Binance, Bybit, OKX, Bitget
and MEXC. The market-only run, historical news V1–V6 and source settings remain
unchanged. No exchange order or real account balance is used.

Each venue starts with 10,000 virtual USDT, shared across BTC, ETH, SOL, TRX, BNB,
XRP, DOGE, ADA, LINK and AVAX. USDT is cash. Total virtual starting capital is
50,000 USDT. The model for each token is copied from the frozen completed V6
report, including its selected case, holding horizon and category LONG/SHORT/HOLD
rules. The report hash is checked before startup. BTC's cash selection stays cash.
No parameters are refitted using current prices or forward results.

This is explicitly **exploratory forward paper research**. Historical models keep
`qualifiedForForwardTest: false`; starting an observational paper account does not
rewrite that research result or claim a proven edge. Live execution and portfolio
risk limits differ from the historical independent per-token accounts, so their
dollar P&Ls are not directly comparable.

## News eligibility and timing

Only article versions observed after the run starts can produce candidates. An
initial feed snapshot cannot trade. The source must still be enabled, approved,
at the recorded revision and fresh; the existing content-processing permissions
must allow the deterministic classifier. Publication time must be valid, no later
than collection availability, and at most two hours old. Versions available in
the future are not processed. Old archives and newly discovered old headlines
cannot be replayed into this live account.

The classifier and trained rules are the unchanged V6 taxonomy, with separate Fed
easing, tightening and other categories. Unknown, uncertain, resolved and unsupported
events produce HOLD. Shared publisher groups, category, affected tokens and a
six-hour publication window deduplicate repeated reports. Revisions cannot reopen
the same event; a correction cancels a pending candidate for the same article.
This does not establish independent confirmation or prove that a source is true.

The actual decision time replaces the historical publication proxy. A candidate
waits at least five minutes and then the next UTC hour, preserving the historical
hourly scheduling convention while using only information already received. Its
entry window expires after 90 seconds. The quote request must start after the
decision and entry time. Unsupported pairs, missing instrument filters or stale
books cause HOLD, never synthetic replacement prices.

The live AI extractor remains a separate evidence service with its existing budget.
V6's historical rules were fitted on deterministic news categories, so this forward
experiment uses the same classifier rather than substituting current LLM opinions.
The model cannot issue trading commands or act on instructions embedded in news.

## Simulated execution and risk

The service checks public instrument metadata for all 50 venue/token combinations.
Unavailable pairs are visible. Books are requested when a candidate or position
needs them. A BullMQ worker runs every 15 seconds, with one worker and a PostgreSQL
lease. Failed providers are isolated; existing exposures wait for fresh quotes.

Both directions reserve full entry notional. Sizing caps each entry at 10% of the
venue equity, combined open exposure at 20%, and estimated stop loss plus modeled
costs at 0.25% of venue equity. A 2% daily marked-equity loss blocks new entries and
requests exits. Entry spreads above 0.5% are rejected. These conservative portfolio
guards are additional forward-run constraints, not changes to frozen V6 training.

Fills consume at most 10% of displayed top-five book levels, obey quantity/price
grids, and apply 0.05% adverse slippage. Fees per fill are estimated: Binance,
Bybit and OKX 0.1%; Bitget 0.2%; MEXC 0.05%. Shorts assume simple borrowing at
0.0003% per hour. No real borrowing, perpetual funding or leverage is represented.
Partial closing fills require a new book sequence before consuming more liquidity.

Positions close on 2.5% stops, 5% targets, the frozen token holding horizon, risk
limits or the 24-hour run deadline. Open net P&L includes estimated exit fees and
financing. A stale mark is labeled stale. The deadline stops entries and requests
closes; missing liquidity can keep the run STOPPING after the deadline. Pausing
entries keeps monitoring and closing active. A restart preserves the original
deadline, balances, processed news, pending signals and positions.

## Dashboard, notifications and operations

The dashboard shows venue accounts, current positions, rule selection, decisions
and rejected-event counts. Filter by run, exchange, token, direction, result,
lifecycle, dates and P&L; sort numerically and export all matching rows as JSON,
CSV, TSV or Markdown. Position details include the immutable news version, source
configuration, rule and quote IDs. Historical runs remain selectable.

The separate `news-forward-alerts` service sends opening and completed-close alerts
to the same environment-configured Telegram owner, labeled `NEWS_V6` and SIMULATED.
It has its own durable outbox and BullMQ queue, read-only access to this ledger,
and no Telegram update polling; the existing bot remains the sole command poller.
Existing `/status` and `/positions` commands continue to describe the market run;
news positions are available at `/news-paper` and in news position alerts. Delivery
is at least once across Telegram's send/database-ack crash boundary. Exhausted news
delivery failures are retained for operator review, not retried indefinitely.

`news-forward/.env` supplies the enabled flag, restricted database URL, Redis URL,
frozen V6 report ID/hash and existing private operator credentials. A separate
`news-forward-alerts/.env` stores the bot settings. Both files have mode 600; no
secrets are baked into images or browser bundles. The forward role can read only
the required source/version/report tables and write its own versioned schema
`crypto_news_forward_v1`, in the existing news database. It cannot edit source
permissions, research reports or the market financial ledger.

`infra/compose/prepare-news-forward.py` prepares the roles, schemas and private
configuration without backups. Build the dedicated thin runtime and web images;
start only the two added services and the updated web container. Add authenticated
gateway routes to port 3104 and validate nginx before reloading it. Existing market,
collector, analyzer, historical research and primary Telegram containers stay up.
Do not create database dumps/configuration backups or re-enable backup schedules.

Unit and API tests use labeled synthetic news/quotes. PostgreSQL/Telegram-outbox
integration tests run in an isolated scratch database, without real Telegram
messages or exchange orders. Full `pnpm check` and `pnpm run doctor` are required.

## Initial production run

Run `110a004d-11a3-4367-b16f-85757c0ee574` started at **00:29:16 Moscow on
2026-11-09**, with deadline **00:29:16 Moscow on 2026-11-10**. It uses V6 report
`7764c794-c23f-4e64-9c17-09fd4f0b8c3d`, report hash
`sha256:37e3e39695ca1075d094aea659a927ae50d084dfdc00f322ef7d59bf617c345b`.
Forward engine hash:
`sha256:cf7f56082649e07e3dd7000ea73a60ebd9fbc63100bce03367622f396a05c39c`.
Profile hash:
`sha256:f397f8c296a8e3fcab1dbd84e0e1b11f08cd2ae0f6f00be6a29e6c027d157308`.

All 50 instrument checks passed. Fresh ETH books were verified on all five
exchanges without creating positions. Restart preserved the run, balances and
deadline; the event chain verified. News alert delivery and primary command
polling remain separate, with the news recipient ready. The initial account is
waiting in cash for genuinely new eligible news, not replaying historical trades.

Validation passed 1,213 tests in 73 files, 12 PostgreSQL/Redis integration tests,
doctor and a production Next build. Authenticated dashboard, four filtered export
formats, unauthenticated access rejection and cross-origin control rejection passed.
Existing service identities, source settings, historical reports and frozen engine
hashes were preserved. No backups were created or enabled.
