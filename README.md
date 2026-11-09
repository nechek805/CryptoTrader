# Crypto Intelligence Research Platform

Research-only crypto intelligence, built from the specifications in `project_roadmap/`.
All executions are simulated. Explicit CLI commands can capture public market data;
there are no exchange accounts, real order placement, withdrawals or established alpha claims.

**Implementation: all roadmap modules and iterations through Module 16.**

[Historical news strategy research](docs/news-strategy-tests.md) adds a six-month,
all-token LONG/SHORT study at `/news-strategy-tests`, with bounded fitting, fees,
source coverage and explicit historical-availability gates. V3 adds structured
event gates, stronger evidence requirements and walk-forward comparisons while
preserving the frozen V1/V2 results; minute diagnostics remain separate.

[News V4](docs/news-strategy-v4.md) connects free public announcement/incident and
government archives, adds a 36-month common comparison for V1–V4, and preserves
all original reports. No extra API keys or live news execution are introduced.

[Live news collection](docs/live-news-engine.md) adds scheduled RSS/Atom feeds,
source management, immutable article revisions and replaceable AI analysis at
`/news-engine`. Provider credentials stay private; the market paper run remains separate.

Production services use [Docker Compose and BullMQ](docs/compose-deployment.md):
API, web, separate paper worker, Redis, PostgreSQL, gateway and queued backups.
The owner's HTTPS domain and paper-run database are preserved.
The full research/paper path includes immutable evaluation, an authenticated dashboard,
pre-registered experiment controls and a detached optional entity prototype (DEFER).
The thirty-day acceptance exercise is explicitly synthetic; a real elapsed forward
study still requires eligible providers, unchanged frozen code and actual wall time.
Start `pnpm dashboard` for the local research console. See [dashboard](docs/dashboard.md),
[experiment runbook](docs/experiment.md), [frozen synthetic findings](docs/experiment-2026-11-03-findings.md)
and [optional extension decision](docs/module16-decision.md).
Risk gates, evidence-linked decisions and four persistent virtual portfolios now support
conservative quote/trade fills, source health, controls and exact restart/replay.
Try `pnpm paper start --feed synthetic --directory data/paper/my-day`;
see [paper broker](docs/paper-broker.md).
Four isolated candidate portfolios now share a frozen opportunity grid and common
assumptions, with conservative versioned fusion policies and immutable audit reports.
Try `pnpm fusion fixture`; see [fusion isolation](docs/fusion-isolation.md).
News decisions now retain grounded explanations, source-safety cases and a frozen later
comparison with cash/always-long markouts, including false positives and missed events.
Try `pnpm news-audit fixture`; see [news replay and handoff](docs/news-audit.md).
Conditional estimates now use chronological event-study samples, historical controls,
minimum block counts and cost/uncertainty gates. Try `pnpm news-edge fixture`;
see [conditional news hypotheses](docs/news-edge.md).
News-only rules now produce evidence-linked LONG/SHORT/HOLD candidates from immutable
as-of events, with independent-origin, timestamp, withdrawal and freshness gates.
Try `pnpm news-signal fixture`; see [news signals](docs/news-signals.md).
Predeclared cost/volatility/parameter/feature experiments now retain every attempted
cell, risk-adjusted net rankings, uncertainty and immutable handoff/archive receipts.
Try `pnpm robustness fixture`; see [market robustness](docs/market-robustness.md).
Deterministic TypeScript logistic regression now uses verified Parquet, TRAIN-only
scaling and validation calibration, with held-out diagnostics and causal HOLD/candidate
inference. Try `pnpm ml fixture`; see [market ML](docs/market-ml.md).
Cash, buy-and-hold, SMA/EMA crossover, breakout and z-score reversion now produce causal
candidates and costed synthetic reports. Try `pnpm backtest market-fixture` or
`pnpm backtest market-matrix`; see [market baselines](docs/market-baselines.md).
Symmetric long/short fixtures retain signals with execution disabled. Next is Module 11
Iteration 2, Risk Engine.
News now supports immutable as-of event inputs, explained confidence/uncertainty, declared
asset context, prospective split/merge lineage and offline provenance graphs. See
`docs/news-events.md` for commands and handoff, `docs/news-independence.md` for source rules,
and `docs/news-extraction.md` for extraction limits. Assessments remain fallible.
Event-study CLI/API adds exact-close point-in-time alignment, returns, benchmark subtraction,
OHLC excursions, volatility and drawdown with explicit missing coverage. Run `pnpm study fixture`
and see `docs/event-study.md`. Seeded matched controls, BTC factor/basket adjustment,
directional lag analysis, censored recovery and taxonomy/concentration are documented
in `docs/event-controls.md`; try `pnpm study controls-fixture`.
Versioned hypothesis cards, period-reuse checks, uncertainty reports and a gated News Strategy
research handoff are documented in `docs/hypothesis-registry.md`; try `pnpm study hypothesis-fixture`.
The feature catalog, point-in-time indicators, warm-up/missingness and source audits are
documented in `docs/technical-features.md`; try `pnpm features fixture`.
BTC-relative/lagged features, a historical liquid universe, breadth/concentration,
deterministic regimes and individually timed derivative inputs are documented in
`docs/cross-asset-features.md`; try `pnpm features cross-fixture`.
Chronological train/validation/test panels, global purge/embargo, leakage/survivorship
reports, immutable Parquet and the TypeScript client are documented in
`docs/dataset-panels.md`; try `pnpm features dataset-fixture`.
The availability-ordered scheduler, read-only Strategy context, no-trade control,
candidate logs, snapshots and reproducible manifests are documented in
`docs/replay-kernel.md`; try `pnpm replay fixture`.
Cash/spot market and limit simulation, reservations, partial fills, protective exits,
costs and the balanced journal are documented in `docs/spot-execution.md`;
try `pnpm replay spot-fixture`. All execution is virtual; live execution stays disabled.
Frozen execution manifests, cash/buy-and-hold comparisons, gross/net results, equity/
exposure curves and fee/slippage/latency/gap scenarios are documented in
`docs/backtest-controls.md`; try `pnpm backtest fixture` or `pnpm backtest run --manifest ...`.

## Prerequisites and installation

- Node **24.22.2 LTS**, pinned in `.node-version` and `.nvmrc`.
- pnpm **10.34.9**, pinned in `package.json`.
- Docker Compose v2 is optional for this iteration; the Docker daemon must be running for infrastructure checks.

Install Node with your version manager (`nvm install` on nvm-sh) or the
[official Node distribution](https://nodejs.org/dist/v24.22.2/). Then:

```sh
npm install --global pnpm@10.34.9
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev` is the one-command fixture startup after installation: it validates the bundled
three-symbol synthetic inventory, runs the finite fixture worker and serves
`http://127.0.0.1:3000/health`. Stop with Ctrl+C. It does not require `.env`, Docker,
network access or provider credentials. Initial dependency installation requires a registry;
all subsequent tests and fixture runs work offline with installed dependencies.

pnpm selects the pinned Node version automatically through `useNodeVersion` in
`pnpm-workspace.yaml`, downloading and caching it on first use if necessary.
The Windows dashboard can use the checksum-verified portable installation in the ignored
`.tools/node-v24.22.2-win-x64/` directory. Set
`NODE_RUNTIME_DIR=.tools/node-v24.22.2-win-x64` in `.env` once, then run
`pnpm dashboard` without setting PATH. Use `pnpm dashboard --check` to verify the selected
runtime. A relative directory remains valid if the project folder moves.

If pnpm is not installed globally, replace `pnpm` with
`npm exec --yes --package=pnpm@10.34.9 -- pnpm` in those commands.

## Configuration

Defaults work without a file. For overrides copy `.env.example` to `.env` (`Copy-Item
.env.example .env` in PowerShell). Node reads it for dev, doctor and smoke; existing
environment variables take precedence. Tests use explicit isolated configuration.

| Variable    | Default        | Allowed values                                |
| ----------- | -------------- | --------------------------------------------- |
| `DATA_MODE` | `fixture-only` | Only `fixture-only`; other modes fail startup |
| `HOST`      | `127.0.0.1`    | Loopback: `127.0.0.1`, `::1`, `localhost`     |
| `PORT`      | `3000`         | Integer 1–65535                               |
| `LOG_LEVEL` | `info`         | Fastify/Pino levels, including `silent`       |

Only these fields enter configuration. Credentials are neither required nor reported.
`fixtureAsOf` describes a synthetic fixture, while `checkedAt` is the current health
observation in UTC. The inventory is not historical market data and is not a research result.

## Commands and verification

Offline market demonstration (PowerShell):

```powershell
pnpm market import --provider fixture --symbols 'BTCUSDT,ETHUSDT,SOLUSDT' --from 2026-01-01T00:00:00Z --to 2026-01-01T00:05:00Z
```

This writes an immutable snapshot under `data/market` and reports 9 accepted candles and
7 quarantined fixture rows. Local public-archive input, checksums and optional `--persist`
are documented in `docs/market-import.md`.

| Command                          | Purpose                                                                  |
| -------------------------------- | ------------------------------------------------------------------------ |
| `pnpm install`                   | Install dependencies and update the lockfile intentionally               |
| `pnpm install --frozen-lockfile` | Reproduce the pinned dependency graph                                    |
| `pnpm dev`                       | Start the fixture worker and loopback health API                         |
| `pnpm run doctor`                | Validate runtime/config/fixture and print a JSON readiness report        |
| `pnpm smoke`                     | Run `smoke --dry-run` through the CLI using in-process HTTP injection    |
| `pnpm lint`                      | ESLint plus Prettier checks                                              |
| `pnpm typecheck`                 | Strict TypeScript checks across implemented apps/packages/tests          |
| `pnpm test`                      | Database-independent fixture/integration checks, including failure paths |
| `pnpm test:integration`          | Actual PostgreSQL tests using explicit TEST_DATABASE_URL                 |
| `pnpm check:db`                  | Normal checks plus actual PostgreSQL integration tests                   |
| `pnpm db:migrate`                | Transactional, checksummed PostgreSQL migrations                         |
| `pnpm db:seed`                   | Idempotent synthetic import and hashed run/experiment manifests          |
| `pnpm db:clean`                  | Reset only a reserved crypto_fixture_* schema                            |
| `pnpm check`                     | Lint, typecheck, tests, dry-run smoke and contract demonstration         |
| `pnpm demo:contracts`            | Validate ten synthetic contracts and demonstrate time gates/math/hashes  |
| `pnpm format`                    | Format source/docs; supplied roadmap files stay untouched                |
| `pnpm infra:up`                  | `docker compose up -d --wait` for local PostgreSQL/Redis                 |
| `pnpm infra:down`                | Stop infrastructure; retain named data volumes                           |

The dry run opens no listening socket, submits no orders and makes no provider calls.
Use `pnpm run doctor` explicitly: pnpm also has a built-in `doctor` command.
For a real local listener check while `pnpm dev` is running:

```powershell
Invoke-RestMethod http://127.0.0.1:3000/health | ConvertTo-Json -Depth 5
```

The response includes `schemaVersion: "health.v1"`, `status: "ok"`,
`mode: "fixture-only"`, `execution: "disabled"`, `instrumentCount: 3`,
`ordersCreated: 0`, and `postgres`/`redis` dependency statuses of `not-required`.
Doctor reports skipped dependencies honestly; it does not assert database connectivity.
Health responses have generated `x-request-id` correlation IDs and `Cache-Control: no-store`.
Health is the only public application route. Invalid configuration, missing/corrupt fixtures,
or a bind failure cause a nonzero startup exit without echoing configuration values.

## Local infrastructure

```sh
docker compose config --quiet
docker compose up -d --wait
docker compose ps
docker compose exec postgres pg_isready -U research -d crypto_research
docker compose exec redis redis-cli ping
docker compose down
```

PostgreSQL and Redis publish only to host loopback (5432 and 6379), have persistent named
volumes and readiness probes. PostgreSQL uses local development trust authentication;
this Compose stack is for a trusted local workstation. Do not deploy it as a production stack.
Fixture API mode does not connect to either service. Explicit persistence commands and
database tests require PostgreSQL. On this Windows workstation `infra/local-postgres.ps1`
provides an isolated native cluster using the installed binaries; see `docs/persistence.md`
for startup and environment variables. Docker image tags are pinned; digests are not locked.

## Workspace and contributor rules

For the real BTC hourly-history workflow, open `/market-test` in the local dashboard.
It provides a six-month, 10,000-virtual-USDT market-only retrospective test with source
inspection and hourly decision traces. See [the walkthrough](docs/btc-market-test.md).

Implemented source boundaries:

- `apps/api`: operational `buildApp` and explicit read-only `buildMarketQueryApp(data)`.
- `apps/worker`: `runFixtureWorker(fixtureUrl?)`, a finite local validation task.
- `apps/cli`: operational/persistence checks, market workflows and news registry/fixture commands.
- `packages/core`: runtime config, UTC/epoch helpers, monotonic/mock clocks, frozen decision
  views, decimal arithmetic, canonical hashing/deterministic IDs and seeded randomness.
- `packages/contracts`: ten versioned domain schemas/types plus compatible operational schemas.
- `packages/db`: versioned migrations, immutable raw/derived/research repositories,
  provenance references, historical reads, audit and bounded archival.
- `packages/connectors`: market readers/streams and bounded news parsers, fixture provider and HTTPS safety primitives.
- `packages/research`: normalization, Parquet/stream evidence, point-in-time `MarketData`, metadata/universe/quality queries and verified reports.
- `packages/news`: source registry, append-only article versions, point-in-time views and optional PostgreSQL registration.
- `tests/fixtures`: synthetic inputs with no licensed articles or real market claims.

`packages/strategies`, `risk`, `paper`, and `evaluation` implement isolated candidates,
deterministic risk, virtual execution, uncertainty and frozen assessments. `apps/web`
is a production-buildable Next.js research dashboard over the authenticated API.
The optional prototype in `research_prototypes/` is excluded from production imports.
TypeScript server/library source exports run through `tsx`; Next uses its own build.

Read the master prompt and the active module before editing. Validate each iteration,
validate external inputs with Zod, keep paper-only and point-in-time constraints, add a
meaningful failure-path test, update docs/ADRs and run `pnpm check`. Never commit `.env`,
credentials, dependency folders, downloaded runtimes or data outputs. Do not rewrite the
supplied roadmap files: their checksums are preserved in `PACK_SHA256.json`.

GitHub Actions checks Windows and Linux, and starts/health-checks Compose on Linux.
See `docs/contracts.md` for domain/time semantics, `docs/persistence.md` for database use,
`docs/market-import.md` for the importer, `docs/market-streams.md` for capture/replay,
`docs/market-quality.md` for universe/quality queries, `docs/adr/` for decisions and
`docs/news-registry.md` for news registry/parsing, and `docs/progress.md` for the handoff.

# Live paper trading

VPS hosting is available at <https://crypto-trader.nechek805.org/live-paper>, with
a separate operator login and persistent server processes. See
[VPS operations](docs/vps-deployment.md) for status, backups and recovery.

Start `pnpm dashboard`, then open <http://127.0.0.1:3100/live-paper>. The new
workspace runs SOL/XRP V6 against real public feeds from five exchanges, with
10,000 virtual USDT per exchange, persistent positions, a 24-hour deadline,
live profit inspection and filtered exports. No real exchange orders are sent.
See [the live paper guide](docs/live-paper-trading.md) for persistent `.env`
configuration, controls, recovery and recorded-input verification. Existing
historical strategy pages remain available.
