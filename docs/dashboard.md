# Research dashboard and operations

The new **Live paper trading** page at <http://127.0.0.1:3100/live-paper> uses real
public SOL/XRP feeds on five exchanges and a separate persistent PostgreSQL
database. Its 24-hour positions and P&L are independent of the historical and
synthetic research pages described below. See [live paper trading](live-paper-trading.md).

Run `pnpm dashboard` directly; no per-session PATH command is needed. The launcher reads
`NODE_RUNTIME_DIR` from the project `.env`, checks the pinned Node version, and uses it
for the dashboard and its child processes. Relative runtime paths follow the project
folder when it is moved. Windows also detects the installed portable runtime when the
setting is empty. Existing process environment settings take precedence over `.env`.
Use `pnpm dashboard --check` to verify runtime selection without starting servers.
The workspace also pins `useNodeVersion` so pnpm can bootstrap before `.env` is read,
even when the system Node version differs. pnpm caches that runtime after first use.

Startup verifies the
synthetic archives before starting the UI at http://127.0.0.1:3100 (API 3101).
The launcher allows up to five minutes for the accumulated immutable research
archives to verify on a cold start; it prints the verification message while waiting.
The local synthetic dashboard opens automatically with read access. There is no token
prompt or demo-entry button. These are virtual balances and fictional inputs.
Known fixture tokens exist only in fixture mode; deployment refuses them.

For a separately operated deployment gateway, set OPS_MODE=deployment,
OPS_PAPER_STORE, distinct random OPS_READ_TOKEN/OPS_ADMIN_TOKEN (32–200 characters),
OPS_ALLOWED_ORIGINS (HTTPS), and optionally OPS_EVALUATION_BUNDLE. Supply these through
the process secret environment, not command arguments or committed files. Run
`pnpm dashboard:api` behind an authenticated TLS reverse proxy that preserves Origin.
The API itself binds loopback, trusts no forwarded IP headers, and logs no request bodies.
Do not expose the Next development server as a deployment. `pnpm web:build` builds the UI;
`pnpm --filter @crypto/web start` serves the production build locally.

Examples below use a token held in session memory. Never paste it into shared logs:

```powershell
$headers = @{ Authorization = "Bearer $env:OPS_READ_TOKEN" }
Invoke-RestMethod http://127.0.0.1:3101/overview -Headers $headers
Invoke-RestMethod 'http://127.0.0.1:3101/signals?portfolio=NEWS_ONLY&limit=25' -Headers $headers
Invoke-RestMethod http://127.0.0.1:3101/provenance -Headers $headers
```

`/signals/:id` traces cutoff/source/risk/fills/PnL; `/features` distinguishes known risk
measurements from unattached predictive vectors. `/curve` is bounded chart data;
`/equity` supplies full paginated inputs. `/studies`, `/correlations`, `/parameters`,
`/telemetry` and `/alerts` expose read-only research/operational details. `/exports/json`,
`/exports/csv`, `/exports/md` download reports. Pagination uses limit (1–100) and offset;
portfolio and symbol are exact filters. News snapshots are context, not silently joined
to a paper decision. Original content is not republished. Missing prices create gaps.

Admin POST `/controls` accepts action PAUSE/RESUME/STOP/KILL, reason and exact manifestHash.
Each accepted control appends an immutable event; queued requests take effect at a later
worker event. Kill cannot be cleared within the same frozen manifest. Read sessions
cannot control a run. Local fixture run is completed, so its controls remain disabled.
An appended bad day cannot be deleted. Source badges describe the replay clock shown in
the header, not current Internet availability. Refresh/reopen to read a newer store;
deployment reads share a five-second cache and verify that the committed prefix only
advances. A frozen attached evaluation retains its own original paper/report hashes.
there is no live push subscription or production multi-user state service.

Back up a verified committed prefix and verify restoration:

```powershell
pnpm paper backup --directory data/paper/run --destination data/backups/run-2026-11-03
pnpm paper replay --directory data/backups/run-2026-11-03
pnpm paper status --directory data/backups/run-2026-11-03
```

The backup directory must be empty and separate. Pending control requests are excluded;
record/review them separately. To recover, stop the owned worker, retain the original
store, replay the backup, compare its report/log hashes, and resume the verified backup
only if its status and frozen protocol permit. Never merge event histories manually.
Rollback stops the dashboard, restores the previous application version and opens its
compatible immutable artifacts; do not downgrade or overwrite a running experiment.
Code changes create a new experiment ID (Module 15).

Observed checks: 200 authenticated API requests completed below the 15-second test
bound, followed by 40 admitted/10 rate-limited requests; malformed market/RSS bursts
survived with no fills. `data/dashboard/dependency-audit.json` records zero production
findings. Screenshots in `data/dashboard/screenshots/` document desktop trace and mobile
rendering. These are local evidence, not a public deployment or long-running load result.
Local alerts are the paper log, CLI status and dashboard API; no external messages sent.

The **Market strategy tests** sidebar page adds the frozen v1/v2/v3 comparison across
ten public crypto/USDT histories and a USDT cash control. See
[the step-by-step guide](market-strategy-tests.md) for results, strategy descriptions,
trade inspection, source assumptions, exports and exact replay. It uses independent
10,000 virtual USDT accounts and does not change the four native paper portfolios.

The **SOL & XRP strategy lab** sidebar page opens the latest separate v5 exit profiles,
V1–V5 comparisons on the same frozen history, fees on by default, all development
trials, chronological checks and matched v4→v5 trades. Its **V4 research archive** keeps
the original v4 page and settings. See [v5 results and reproduction](sol-xrp-v5-2026-11-06.md).

**Long & short tests** adds original long-only, short-only and combined modes for
every retained token, including SOL/XRP V4/V5. Borrowing, collateral, loan balances,
long/short contributions and explicit costs are inspectable alongside the original
results. See [the long/short guide](long-short-market-tests.md) for assumptions,
step-by-step testing and reproduction. Existing market pages link to this comparison.
