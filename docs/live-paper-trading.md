# Live multi-exchange paper trading

Run `pnpm dashboard`, then open <http://127.0.0.1:3100/live-paper> or choose
**Live paper trading** in the sidebar. Your local `.env` persists the database
and live-feed settings, so they do not need to be entered for every run.

Wait for SOL and XRP to show LIVE on Binance, Bybit, OKX, Bitget and MEXC.
Each feed loads approximately 299 completed hourly candles for V6 initialization.
Click **Start 24-hour paper run** once. There is one active run at a time, with
10,000 virtual USDT on each exchange, 50,000 total. Fees remain on. No exchange
account, token prompt, API key or real funds are required.

The start time and fixed deadline appear above the five exchange accounts.
V6 waits for new eligible hourly crossovers: a run can correctly make no trades.
The latest decision explains HOLD. You can inspect positions and P&L throughout
the run; there is no requirement to wait until the next day. Closing the browser
does not stop trading. Keep the terminal process running and prevent the machine
from sleeping. Restarting `pnpm dashboard` restores the saved run and original
deadline, but cannot recover market moves that happened while it was stopped.

**Pause entries** leaves risk monitoring and exits active. **End run and close
positions** cancels new proposals and requests paper closure using fresh books.
The same happens automatically after 24 hours. A disconnected exchange can keep
the run in STOPPING until it returns; its last marked profit is explicitly stale.

Filter positions by run, exchange, token, long/short, working/win/loss/breakeven,
open/closing/closed, opened or closed UTC range, and minimum/maximum net profit.
Select the sort field and direction. **Inspect** shows the signal metrics, fees,
fill times and original exchange quotes. WORKING positions may currently be
profitable or losing; WIN and LOSS describe the final result after full closure.
Position value is entry notional; exchange open value uses remaining marked
notional. Open P&L includes estimated closing fees and conservative bid/ask marks.

Export JSON, CSV, TSV or Markdown using the buttons above the table. The export
uses all matching rows and the current sort, not only the displayed page. JSON
contains complete position/fill details. Each export has a consistent database
snapshot; live results can change between separate exports.

CLI inspection and deterministic recorded-input verification:

```powershell
pnpm live-paper status
pnpm live-paper verify
pnpm live-paper verify <RUN_ID>
```

State lives in PostgreSQL schema `crypto_live_paper_v1`; original research data
remains under `data/`. Do not delete `.tools/postgres-live-paper` to clear a screen:
it contains the persistent database. New runs preserve previous runs and positions.
Back up that cluster with PostgreSQL tools when retaining results matters.

Windows launcher settings (already saved in this checkout's `.env`):

```dotenv
LIVE_PAPER_ENABLED=1
LIVE_PAPER_AUTO_DB=1
LIVE_PAPER_DATABASE_URL=postgresql://research@127.0.0.1:55439/postgres
```

On another machine, configure a PostgreSQL URL; `LIVE_PAPER_AUTO_DB=0` uses your
managed database. Windows automatic startup requires PostgreSQL binaries in
`C:/Program Files/PostgreSQL/18/bin` or a configured `PG_BIN_DIR`. The cluster binds
only to loopback; it is a local development facility, not internet hosting.

These positions are cash-settled simulations using spot books. Shorts do not
claim real borrowing availability or perpetual funding. Fees are estimated, and
five-second samples can miss moves between observations. See
[ADR 0057](adr/0057-live-multi-exchange-paper-trading.md) for all execution, sizing,
freshness and recovery assumptions. Historical research pages and results remain
available and are separate from these forward results.

The independent [Telegram notifier](telegram-notifications.md) reports future opening
fills and completed closes to the configured private owner. It reads committed ledger
events and cannot modify trades. `/status` and `/positions` provide read-only bot views.
