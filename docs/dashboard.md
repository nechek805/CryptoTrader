# Research dashboard and operations

Use the pinned Windows runtime from README, then `pnpm dashboard`. Startup verifies the
synthetic archives before starting the UI at http://127.0.0.1:3100 (API 3101).
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
