# Implementation progress

Updated: 2026-11-09 (Europe/Moscow)

## Current boundary

News-driven live paper trading is implemented and deployed at `/news-paper`.
Run `110a004d-11a3-4367-b16f-85757c0ee574` started on 2026-11-09 at 00:29:16 Moscow,
with the original deadline 2026-11-10 00:29:16 Moscow. Five separate 10,000-USDT
venue accounts share the ten-token universe, with fees and simulated borrowing on.
All 50 public instrument checks passed. The frozen V6 report/model selections are
preserved; BTC remains cash. Only new, fresh, permitted post-start news can open a
candidate, after causal processing latency and a fresh public book. This is an
exploratory forward paper experiment; historical qualification remains false.

The separate BullMQ service has a fenced PostgreSQL writer, immutable evidence,
hashed event chain, restart-safe state/command receipts, daily risk limits and
paper-run controls. The dashboard includes rule explanations, filters, exports
and position evidence. A separate outbound Telegram notifier watches this ledger;
the existing market bot remains the sole command poller. All settings are in
private `.env` files. Source permissions are rechecked before pending entries fill.

Full check passed 1,213 tests in 73 files, including 11 new engine/API tests.
Twelve real PostgreSQL/Redis integration tests passed, including six new forward
ledger/control/alert tests; doctor and the production Next build passed. Four
filtered export formats and rejected cross-origin control passed on production.
Original market, news collector/analyzer/research and primary Telegram service
identities, frozen engines, source settings and historical reports are unchanged.
Backups remain disabled and absent. See [live news paper protocol](news-forward-paper.md)
and ADR 0068. Production restart preserved the run ID, balances, engine/profile
hashes and deadline. Its persisted event hash chain verifies, all 50 instrument
checks and fresh ETH books on all five venues passed, and the news Telegram
notifier is healthy with read-only ledger access. At final verification no new
eligible article versions or positions existed; every account remained in cash.

## Previous boundary: Telegram alerts

Telegram paper-position alerts are implemented as a separate Compose service with
an owner-only private-chat allowlist, `.env` credentials, read-only financial-ledger
access, transactional notification cursors/outbox, and an independent BullMQ queue.
It reports new opening fills and completed closes; read-only commands show current
run status and open positions. Initial installation skips past events. See
`docs/telegram-notifications.md` and ADR 0067 for retry and delivery limits.
Deployed and healthy on production. Telegram acknowledged the private connection
message, and restarting only the notifier preserved cursors and sent no duplicate
welcome. `pnpm check` passed all 1,202 tests in 71 files, including seven new unit
tests; all six isolated PostgreSQL/Redis integration tests and doctor also passed.
Actual production grants confirm SELECT-only
access to financial tables and no database CREATE permission. Financial/news source
hashes, existing service start times and the completed V6 report are unchanged.
Backups remain disabled and absent.

## Previous boundary: backups disabled

Server backups were disabled and removed at the user's request on 2026-11-08.
Removed 28 project backup/archive and configuration-copy files (124,691,124 bytes).
The maintenance container is removed, its BullMQ queue is paused with zero
schedulers or pending jobs, and the old host timer is disabled. Production
configuration persists `BACKUPS_ENABLED=0`; the optional Compose `backups`
profile and explicit startup guard prevent normal restarts from enabling it.
The host backup script also defaults to disabled. Future deployments must not
create server-side backups or `.before` copies unless the user changes this policy.
Live databases, research history and paper/news services are preserved. Compose
validation, disabled backup startup, doctor and dashboard API checks passed.

## Previous boundary: news V6

Current addition: **news V6**, based on exact V2 reproduction with separate Fed
categories and three independent single-factor tests. V1-V5, the frozen corpus,
market chunks and fees are preserved. New versioned storage/queue/API and the
six-version/ablation dashboard are implemented and deployed. Completed run
`7764c794-c23f-4e64-9c17-09fd4f0b8c3d` reproduces the original V2 model exactly
for all ten tokens before applying the independent changes. It reuses 179 V2
events and all 60 frozen market chunks without downloads.

V6 final net USDT: ADA +277.59, AVAX +253.41, BNB +173.78, ETH +161.56,
LINK +97.77, SOL +85.48, DOGE +6.86, XRP -28.05, TRX -81.46; BTC holds cash.
Six tokens retain unchanged V2. Category validation is selected for BNB, ETH
and TRX. BTC's concentration-adjusted validation score fails; its profitable
V2 final result does not override that decision. Each token has independent
10,000-USDT capital with fees on. Negative and rejected cases remain visible.

Report hash:
`sha256:37e3e39695ca1075d094aea659a927ae50d084dfdc00f322ef7d59bf617c345b`.
Engine hash:
`sha256:39bca38dfdb19cbffe25202a06eed427dc072f920bdad2d296219f7e1eb52f2d`.
Full check passed 1,195 tests in 70 files on Node 24.22.2. Doctor, production
builds and 26 real PostgreSQL/Redis integration tests passed. Production models
match local models exactly. Parent projection, old reports/source settings,
fee/account reconciliation, all-case JSON/CSV/Markdown exports (3,584 CSV
positions), idempotency and served UI bundle passed. A fresh backup restored
six reports, two corpora and all 46 source configurations in a scratch database.
Financial engines/container identities and existing collectors/analyzers remain
unchanged. Validation slices are explicitly in-sample diagnostics, not forward
tests, because configurations/gates were selected using the whole validation period.
See [V6 protocol](news-strategy-v6.md) and [ADR 0066](adr/0066-v2-single-factor-news-v6.md).

## Previous boundary: news V5

Current addition: **news V5**, a separate event-category reaction experiment
for all ten tokens, preserving V1–V4 and the exact frozen V4 history with fees on.
V2 trade attribution, costed category validation, immutable parent/chunk checks,
versioned BullMQ/API persistence and dashboard comparison are implemented.
Deployed and completed run `a91716ee-8374-4ef3-a10c-e69357143b05` on 2026-11-08.
The exact V4 corpus and 60 candle chunks were reused without downloads; 115
canonical V5 events were admitted. Seven tokens trade; BTC, ETH and TRX abstain.
V5 final P&L: AVAX +118.01, ADA +117.13, BNB +38.72, DOGE +6.86, XRP -25.99,
LINK -36.10, SOL -180.09 USDT. V5 does not improve V2 overall; negative results
are retained. Each token has separate 10,000-USDT capital and fees stay on.

Report hash:
`sha256:bb09ca42bbd12dd7f95f16e5d7cb8e10ed6b062730f252464486afcadbd64cb2`.
Engine hash:
`sha256:131542d051190629e51ddae023c602a750809835c7763b9af5c97678659ba606`.
Full check passed 1,186 tests in 69 files; 23 real PostgreSQL/Redis integration
tests, doctor and production builds passed. Production accounts reconcile and
all V5 model objects match the local replay exactly. Original reports, V1–V4
models, candle/corpus hashes and all 46 source settings are preserved. JSON,
CSV and Markdown exports, idempotent starts and the served V5 UI bundle passed.
A fresh backup restored five reports, two V4 corpora and 46 source configurations
in an isolated scratch database. Financial container identities/source bytes
and existing collector/analyzer images remain unchanged.
See [V5 protocol](news-strategy-v5.md) and [ADR 0065](adr/0065-costed-release-group-news-v5.md).

## Previous boundary: news V4

Current addition: free public archive adapters and **news V4**. The 36-month
24/6/6 study reruns all four versions on common data for ten tokens plus USDT;
original six-month reports and legacy engine bytes remain preserved. Nine new
sources bring the directory to 46. Versioned seed/corpus/report persistence,
BullMQ V4 routing and dashboard comparison/coverage/trade views are implemented.
Initial real-data research retains negative outcomes and V4 abstention; no final
period tuning or forced trades.

Deployed and completed run `57fb2088-801c-40d7-97fb-8877c79fc08c` on 2026-11-08.
All ten tokens have 26,304 verified hourly candles; the corpus contains 2,504
records and 79 eligible V4 events. Eight new collectors are healthy; GDELT's
current network failure and limited historical discovery are visible. Bybit
scanned 9,111 items and retained 377 current-universe records, 278 dated; archives
include 35 CPI releases, 30 dated jobs releases, 25 Fed statements and 82 XRPL
amendment changes. SEC date-only records remain excluded from trading.

V4 final accounts stayed in cash. ETH/ADA pass a training gate but yield only four
validation trades versus the required five. Other candidates lack sample/edge
support. Common-history V2 final P&L ranges from TRX -284.88 to ADA +277.59 USDT;
AVAX +253.41 and ETH +161.56. No model is live-qualified. These are new final
six-month results, not replacements for the old two-month evaluation.

V4 report hash:
`sha256:3fa77b06e434fda0ad1d94c3360acd592d7988a848488b6fca7badcb164f2530`.
Engine hash:
`sha256:fe420e11d8c194f4c988d4ca1cb84c58d791dad55d918a3f97bd43f4538736b7`.
Full check passed 1,179 tests in 68 files; 20 real PostgreSQL/Redis integration
tests, production build and doctor passed. A final shared-issuer metadata fix
unified Fed/SEC archives with their original feeds. Exact exchange pair symbols
such as BTCUSDT are mapped separately without altering publisher quotes. Forty
focused regressions, a full repeated check and repeated integration tests passed
after the corrections. The compatible news-v4.2 image contains them. Existing
37 source configurations were unchanged; only two
new source revisions record the corrected groups before the V4 request froze.

The initial V4 run `b98e08fa-30c1-41be-86de-67a8cc3fa13c` and its report hash
`sha256:dfadaa5978a2bc071d64b40e872e45dfb5fe32d709ca4852e8a4d3dca4ad12fb`
remain immutable and selectable. The symbol mapping correction added 13 retained
records and changed no evidence threshold, fee assumption or final-period result.

Production verification passed account reconciliation, prior-release time ordering,
macro deduplication, common markets/costs, old-report preservation, exports, served
UI bundle, authorization and idempotent starts. V4 survived a research-worker
restart. A new backup restored all three report hashes, V4 corpus and 46 sources
into a scratch database, which was removed. Financial and V1–V3 source hashes,
financial container identities and roadmap checksums were preserved. The live
paper run remains RUNNING without an API/worker error.
See [V4 protocol](news-strategy-v4.md) and [ADR 0064](adr/0064-free-archives-and-news-v4.md).

Previous addition: structured **news strategy V3** for all ten market tokens,
preserving V1/V2 and the exact six-month baseline with fees on. Separate immutable
V3 requests/reports, status-aware evidence, pre-release macro forecast gates,
12/20-sample uncertainty/cost gates, 72-hour purging and three walk-forward folds
are implemented. The dashboard adds side-by-side results, HOLD reasons, original
headline opinions and separate real one-minute reaction diagnostics. Initial
local real-data comparison: all V3 accounts stayed at 10,000 USDT with no trades;
24/24 minute windows loaded. Missing historical consensus and zero timely archive
coverage still prevent a tradable claim.

Deployed 2026-11-08; completed V3 run `b008ecd5-d62a-4bd5-8c8a-7955cb796d0f`
against baseline `618d26e8-d8ae-49b6-abdc-fc1d62615233`. All ten token accounts
stayed in cash; USDT remained the cash control. All 24 real minute windows loaded.
V3 report hash:
`sha256:d75df87f1c0bb6eecfc95eecb24cbf74d01bb49bb9c9370bc08bbbe3b468918c`.
Engine hash:
`sha256:4da5541369f97143116f9609176f6b3ad7c3f4c3a28d934570c5f5df8d1d84e3`.
V1/V2 recomputation reproduced the original report hash exactly. Full check passed
1,164 tests in 67 files; eight real PostgreSQL/Redis integration tests, production
build and doctor passed. Authenticated page/UI bundle, fees, account reconciliation,
exports and duplicate-start reuse passed. The report survived a research-worker
restart, and a fresh backup restored both report hashes into an isolated scratch
database, which was removed. Financial API/worker container IDs/start times and
five frozen financial files remained unchanged; the original ended paper run and
its deadline remain accessible. No live news strategy was enabled.
See [protocol](news-strategy-tests.md) and [ADR 0063](adr/0063-structured-news-v3.md).

Previous addition: **six-month news strategy research** at `/news-strategy-tests`.
All ten market tokens plus USDT cash are included. V1 fixed rules and V2 learned
event reactions use chronological 3/1/2-month splits, 36 candidates per token,
fees/slippage/assumed short financing and a +100 USDT research target. Archives
remain DESCRIPTIVE_ONLY; zero historically timely versions were found. Initial
research missed the profit target; losing/cash results are retained. A dedicated
BullMQ worker, immutable PostgreSQL requests/reports and persistent market cache
keep the study separate from the running market experiment.
Deployed and completed run `618d26e8-d8ae-49b6-abdc-fc1d62615233` on the VPS.
The report includes all ten real market snapshots, 25 aligned news events and
zero historically timely versions. V1 ETH: -121.88 USDT; V2 BNB: -14.98;
V2 AVAX: -32.03; other V2 accounts stayed in cash. JSON/CSV/Markdown exports,
account reconciliation and duplicate-start reuse passed. The report hash
`sha256:f8d82e79865241cf4313e9dc1b5e2308ec4faae6b1702334a138684c30291e94`
survived a research-worker restart. A producer-style Redis connection prevented
initial consumption; the fix uses worker connection settings, awaits readiness
and has a real BullMQ consumption regression test. Fourteen PostgreSQL/Redis
integration tests passed, production build and doctor passed; full check passed
1,150 tests, including a full repeat after the queue connection correction.
A fresh news backup restored into a scratch database with one completed request,
one report, 1,157 article versions and the exact report hash; the scratch database
was removed. The original market API and worker IDs, financial source bytes,
deadline and all ten fresh feeds were verified unchanged. See
[research protocol](news-strategy-tests.md) and [ADR 0062](adr/0062-historical-news-research.md).

Previous source expansion:

Current source expansion: all eleven SOL/XRP candidates from
`xrp_solana_news_sources.txt` are registered (37 total). Five collectors were added:
MIT-licensed XRPL blog index, XRPLF server releases, Solana status, Anza Agave
releases and Helius Atom. Six candidates have explicit setup/permission notes.
Three notification feeds collect metadata with AI off; XRPL and Helius allow
metadata AI. Undated initial archives are manual-only for AI. Old source settings
are preserved by insert-only seeding. Collection checks against real public
endpoints returned 171/10/25/10/201 items respectively. Deployed 2026-11-07 08:17 UTC: all eleven collectors healthy, 1,157 records,
filtered XRPL JSON/CSV exports verified and every prior source configuration
preserved. `pnpm check` passed 1,141 tests; nine PostgreSQL/Redis integration tests,
production build and doctor passed. The active paper engine stays
frozen. See `docs/live-news-engine.md` for access references and collection limits.

Previous news delivery baseline:

Current delivery: **live news collection and configurable AI**, deployed at
`/news-engine`. All 26 directory candidates remain visible; six official public
RSS/Atom feeds collect every five minutes through BullMQ. The collector and
analyzer have independent queues/containers and an authenticated news API. Source
management supports add/edit, enable/disable, manual collection, cadence, origin
and permission settings, with optimistic revisions and immutable history.

The first live snapshot collected 740 real articles. Nineteen actual DeepSeek
requests produced 18 validated structured analyses and one review-needed result;
no fixture replacement was used. Old articles in initial snapshots retain their
actual first-seen time today. AI classifies only permitted metadata/excerpts and
does not establish factual verification or drive the active market strategy.
The provider is configurable by public HTTPS compatible endpoint, model and
private key. A persistent 100-attempt UTC daily budget includes failures.

News uses database `crypto_news` and restricted role `crypto_news_app`, which was
verified to lack superuser, role/database creation and paper-ledger write rights.
Article versions, source history, poll receipts and AI requests/results are
append-only. Existing market-run source files and its original deadline remain
unchanged; the paper worker continued without restart during this delivery.
Source/provider credentials stay in ignored local/private server settings; the
collector/API receive no AI key and authenticated responses/exports contain none.

Validation: `pnpm check` passed all 1,138 tests in 65 files, lint, formatting,
typecheck, smoke and contracts; doctor passed. Seven real PostgreSQL/Redis news
integration cases passed, including durable schedules, source fencing/edits,
deduplication/revisions, permissions and AI budget receipts. The production image
build and live collection/DeepSeek calls passed. HTTPS news pages, filters and
exports returned 200; anonymous requests returned 401, foreign origins 403 and
stale source edits 409. A source edit/restore round trip retained original settings
and an audit trail. The daily BullMQ maintenance job now creates separate paper
and news dumps; a news dump restored successfully into a scratch database with
26 sources, 740 article versions and 19 AI results. Restarting both news workers
preserved those records, source revisions and schedules. All 17 roadmap checksums
remain unchanged. Browser visual
automation was unavailable; verification used the production build, HTTP/API,
database records and container checks. See [news operations](live-news-engine.md)
and [ADR 0060](adr/0060-live-news-and-compatible-ai.md).

## Previous Compose delivery

Current delivery: **Docker Compose and BullMQ**, deployed on the existing VPS.
`compose.production.yaml` manages the API, Next.js, isolated paper worker,
PostgreSQL, Redis, authenticated gateway and backup worker. Private environment
files persist in `/etc/crypto-trader/compose`; startup needs no manually entered
environment values. Shared host nginx/Certbot remain the HTTPS edge for this and
other sites. Previous API/web systemd units and the host backup timer are disabled.
See [Compose operations](compose-deployment.md) and [ADR 0059](adr/0059-compose-and-bullmq.md).

BullMQ schedules five-second public-feed checks and serializes paper controls;
another queue schedules daily database backups at 02:35 UTC. Retries are bounded,
failed jobs retained, control receipts committed inside immutable PostgreSQL
events, and Redis uses persistent AOF with no eviction. The dashboard displays
queue health and counts. News fixtures and historical research remain explicit
finite operations; no live news ingestion was enabled by this infrastructure change.

Run `f7024940-df8b-42f4-9989-9083e1a6c76a` resumed with the same original deadline,
accounts, positions, frozen financial engine and existing journal prefix. The
initial migration recorded a 25.127-second heartbeat gap, with no open positions
and no backfilled executions. Actual Redis and worker restart checks recovered
the same run/accounts/deadline with fresh ticks and zero failed queue jobs.
All ten venue feeds were fresh after the switch. Prior research trees and the
existing PostgreSQL volume are retained. Unrelated VPS services were preserved.

Validation: `pnpm check` passed 1,130 tests in 64 files, lint, formatting, type
checks, smoke and contracts; doctor passed. Six real Redis/PostgreSQL queue
integration tests passed, including retry receipts after job removal, fencing,
lost leases, controls during slow-feed overload and restart recovery. Controls
use priority 1 and scheduled ticks priority 10 to prevent starvation. The
production Docker build and Compose wait
checks passed. A BullMQ backup completed and restored into a separate scratch
database with 1 run, 2,098 events and 21,039 sources; the scratch database was
removed. Forward recording replay verified after migration. Authenticated pages
and exports returned 200, anonymous HTTPS returned 401 and foreign origins 403.
All 17 original roadmap checksums match. Automated visual browser inspection was
unavailable; validation used production HTTP/API, builds and recorded evidence.

## Previous VPS delivery

Current delivery: **authenticated VPS hosting** at
<https://crypto-trader.nechek805.org/live-paper>, deployed to the owner-specified
Ubuntu server without replacing its existing applications. Dedicated Node/pnpm,
an isolated PostgreSQL container, unprivileged systemd API/web services, an
authenticated nginx proxy, Let's Encrypt renewal and daily database backups are
configured. Browser login does not expose or require an application API token.
The deployed app database role is `crypto_app`, without superuser/role/database
administration privileges. Source and root-executed backup scripts are root-owned;
only research data and the Next cache remain writable by the service account.
See [VPS operations](vps-deployment.md) and [ADR 0058](adr/0058-authenticated-vps-paper-deployment.md).

The real-public-data **paper** run `f7024940-df8b-42f4-9989-9083e1a6c76a` started
2026-11-06 16:43:02 UTC and retains its deadline of 2026-11-07 16:43:02 UTC
(19:43 Moscow). All ten SOL/XRP venue feeds passed live checks, with fees on and
10,000 virtual USDT per venue. A controlled deployment restart recovered the same
run and deadline before the next hourly signal opportunity; no open positions
existed during that check. Quote captures before and after the restart are kept,
with no backfilled trades. At handoff the strategy was waiting for a fresh hourly
signal; no completed-day profit is claimed.

Deployment validation: the Linux production build passed; `pnpm check` passed
all 1,128 tests in 63 files, lint, type checks and smoke/contracts checks after
preserving the original unsupported-mode error messages. Doctor passed. HTTPS
returns 200 with authentication and 401 anonymously; spoofed cross-origin requests
are rejected, and all four filtered export formats return successfully. Recorded
forward replay passed, a PostgreSQL backup restored into a separate scratch
database, and Certbot renewal passed its dry run. All existing VPS containers
remained healthy. The API, web service, database and backup/renewal timers are
enabled for independent server operation. Checks used production HTTP/API and
build outputs; automated visual browser inspection was unavailable.

Previous local delivery:

Current addition: **live multi-exchange paper trading**, `/live-paper`, with public
SOL/XRP books on Binance, Bybit, OKX, Bitget and MEXC. Frozen V6 profiles initialize
from completed candles; new hourly signals execute only against later fresh live
books. Each venue has 10,000 virtual USDT, fees on, internal long/short positions,
24-hour deadlines, pause/resume/stop, PostgreSQL recovery, source captures and
hash-linked recorded replay. The sidebar retains all prior historical pages.
Position inspection supports filters, numeric sorting and JSON/CSV/TSV/Markdown
exports. See [operator guide](live-paper-trading.md) and
[ADR 0057](adr/0057-live-multi-exchange-paper-trading.md).

The separate live workspace is explicitly enabled in this checkout's ignored
`.env`; its dedicated local PostgreSQL cluster does not replace fixture storage.
Forward P&L must come from the saved live run; historical V6 gains below are not
forward-performance claims. A new run can legitimately have no eligible trades.

Validation on 2026-11-06: `pnpm check` passed (62 files / 1,127 tests), the
production build passed with `/live-paper`, doctor passed, and all 17 roadmap
checksums matched. The full PostgreSQL suite passed 34 cases; a subsequent
forward replay test brought the forward-specific integration suite to seven
passing cases, including an actual synthetic signal/entry/exit replay. All 23
forward unit/API tests passed again after accounting refinements. A separate live
network capture on all ten venue/token feeds replayed exactly in an isolated test
schema, then that test schema was removed. No synthetic positions were inserted
into the live namespace.

The dashboard and dedicated PostgreSQL cluster are running. HTTP `/live-paper`
returns 200 and navigation is present. Automatic approval review rejected the
shell command to start the production paper run with the reason "blocked by
policy"; no start was executed. `pnpm live-paper status` returned `null` at
19:08 Moscow on 2026-11-06. Start the 24-hour run using the page's button; no
completed-day performance is claimed.

Previous completed boundary:

Latest request: **separate SOL/XRP V6 short strategies**, with V5 trade diagnosis,
old versions preserved and the same history/costs. `/long-short-tests` now defaults
to V1–V6 results and a V6 research tab: complete candidate grids, original short
diagnostics, matched closed-trade changes, selected rules and earlier/later evidence.
Its original V1–V5 interface/service remains accessible. All 204 source cells, old
report IDs, matrix pointers, fee preferences, frozen engines/contracts and datasets
are retained; append 12 V6 cells for 216 cells / 36 profiles. New evidence and six
fee switches live under `data/short-v6` and `/short-v6`, independently of older labs.

SOL V5 shorts had 15 closed trades/five wins, +14.67447 USDT before trading fees and
borrowing, then −16.978633874406392683 net after 28.28199323 fees and 3.371110644406392683
borrowing; 16.02008 slippage was already embedded in fills. Shallow trends and profit
givebacks motivated V6. Selected SOL V6 requires MA200 fall over 24 hours ≥0.75 ATR14,
with a 2.5 ATR short target and unchanged 2.5 ATR stop. Short net becomes
**+84.451290922260273941** (five trades/five wins); combined **+244.169074036780821892**.
XRP V6 requires signal close 0.75–4 ATR below MA200, with a 3.5 ATR short target and
unchanged 2 ATR stop/candle gates. Short net rises from +28.08323995196347031 to
**+84.526438115388127845** (three trades/three wins), combined **+233.971725266872146128**.
Both long-only outcomes remain exactly V5: SOL +158.36855711 and XRP +148.1888626.

All 25 SOL and 19 XRP candidate profiles are retained. Rank only earlier short-only
fees-on net with ≥2 closed trades and ≤2% hourly drawdown; no later/combined ranking.
SOL's later short-only result **deteriorates** from +40.913622571255707773 to
+36.042014313972602743; XRP's later result changes from −15.22754077698630138 to zero
with no short trades. All history was already seen, with substantial prior tuning
and asset selection; this is exploratory evidence, not independent validation.
Fees, slippage, 10% assumed annual borrow, collateral and every risk cap stay fixed.
No live execution or forward eligibility gate changes. See ADR 0056 and
`docs/sol-xrp-v6-short-research.md`.

Validation: `pnpm check` passes **1,104 tests in 60 files**, lint, formatting,
backend/web types, smoke and contracts. Production build, doctor and all 17 original
roadmap checksums pass. Nine focused tests cover no-change compatibility in all
modes/costs, coin-specific grids, parent/window/cost selection guards, later-price
invariance, short-only gates/targets, unchanged long outcomes, pre-window abstention,
trade attribution, mismatched histories, report tampering, delayed trailing gaps,
authentication and fee persistence. All 24 V5/V6 final replays pass; all 204 original
directional report IDs are retained. Live READ-session acceptance passes 76 selected
reports, all 64 fee combinations, two V6 API replays, exports and four matching
ten-link server/client navigation checks. All original matrix pointers and fee
preferences are unchanged. All six V6-comparison fee switches are restored on, on
disk and in the live API, and the dashboard remains running. Browser visual
automation is unavailable; these checks do not claim a visual click-through test.

Latest user request: **short support for all retained tokens**. Added a separate
`/long-short-tests` sidebar page with original long-only, short-only and combined
modes for all ten tokens: V1–V3 everywhere, plus the existing SOL/XRP V4/V5 profiles.
All 34 profiles use the same 4,416 saved hourly candles and 10,000-USDT accounts.
There are 204 comparison cells: 68 preserved original long-only report IDs and 136
new short-enabled reports across both fee settings. Before extension, all 68 actual
long-only compatibility checks pass against the frozen reports. New financial files
leave every old engine, contract, dataset, result and fee preference intact.

Shorts are hypothetical collateralized spot-borrow simulations: 100% collateral,
locked proceeds, explicit base debt, next-open SELL entries/BUY covers, adverse-first
stops/gaps, separate long/short P&L and fixed 10% annual simple borrowing charges.
Historical borrow availability/rates remain unknown, not invented. Risk/allocation/
prior-volume caps remain unchanged; a catastrophic gap records uncovered USDT debt
and halts the account with negative equity while free cash stays nonnegative.
Trading-fee switches persist independently for this comparison and do not disable
borrowing or slippage. No live execution, futures funding claim or short optimization
is introduced. Existing BTC/all-token/SOL-XRP pages link to the new comparison.

Fees-on V5 examples: SOL long-only +158.36855711, short-only −16.978633874406392683,
combined +141.132008077260273965 USDT. XRP long-only +148.1888626, short-only
+28.08323995196347031, combined +176.690384721689497689 USDT. Losses and weaker
combined outcomes remain visible. Full history was previously seen; these are untuned
short extensions, not independent validation. See ADR 0055 and
`docs/long-short-market-tests.md`.

Validation: all 136 new reports/journals replay exactly, all 68 old long-only scenarios
reproduce in the new engine, and original IDs are retained. `pnpm check` passes 1,095
tests in 58 files, lint, formatting, backend/web types, smoke and contracts. Production
build (12 routes), doctor and all 17 original roadmap checksums pass. The first full
check caught generated browser diagnostics under `data/`; ESLint now excludes that
ignored runtime-data root alongside other generated artifacts, and the full rerun
passes. A fresh development cache is used for dashboard restart to avoid mixing old
and new navigation bundles. Live READ-session acceptance passes 74 selected-report
checks, all 32 fee combinations, two exact API replays, research/report exports and
five page/client-bundle navigation checks with the same ten links. The 68 legacy IDs,
all original matrix pointers and all original fee preferences are unchanged. All five
directional fee switches are restored on, on disk and in the live API. The dashboard
remains running at `/long-short-tests`. Browser visual automation is unavailable;
build/API/HTTP checks do not claim an automated visual or click-through test.

Dashboard runtime repair (2026-11-06): a browser hydration error showed an extra
SOL/XRP sidebar link in the server markup while the browser rendered an earlier
navigation definition. Current route bundles agreed, pointing to stale client code
retained across a development restart. Stopped the owned dashboard, retained the old
generated `.next/dev` cache under a timestamped backup, and restarted with a fresh
cache. All eight cold/warm HTTP checks across SOL/XRP, analytics, all-coin and BTC pages
confirm the same nine sidebar links in HTML and served client code, with the correct
active link. Opened a fresh dashboard URL; an existing browser tab may require one hard
refresh. Saved v5 matrix ID and all enabled fee settings are unchanged. Browser visual
hydration was not independently automated; these are server/client-bundle checks.

Latest requested extension: separate **v5 exit profiles** for SOL and XRP on the exact
saved v4 history, with fees on and unchanged capital/risk. `/sol-xrp-lab` now defaults
to V1–V5 results, profiles, all candidate trials, matched v4→v5 closed trades,
chronological checks, hour/fill explorer, source assumptions, exports and replay. Its
**V4 research archive** retains the original UI/service. All other coin pages, old
financial engines/contracts, original report IDs and fee preferences remain intact.
New v5 artifacts and fee preferences have a separate `data/sol-xrp-v5` root.

SOL v5 selects target 4 ATR when signal ATR14/close ≤0.8%, otherwise 5 ATR, keeping
the v4 2.5 ATR stop and v2 entry rules. Net rises from +126.48422578 to
**+158.36855711 USDT**; entry 2831 converts −14.83990199 to +17.04650968 USDT.
XRP v5 selects target 6 ATR when completed signal range/ATR is 1.5–1.8 inclusive,
otherwise 3.5 ATR, retaining v4 entries and 2 ATR stop. Net rises from +128.68579954
to **+148.1888626 USDT**; entry 1000 improves by +19.36868193 USDT. Fees remain
0.1% per side and slippage 0.05% plus tick rounding. Both start with 10,000 virtual
USDT. SOL has 16 closed trades/eight wins; XRP only four/four.

The full 18 SOL + 13 XRP development grid is retained, including inferior trailing
profiles. Selection ranks earlier-period fees-on net profit under the same 2% hourly
drawdown ceiling; all risk caps stay fixed. **Later independently reset checks are
unchanged**, +2.61179711 SOL and +72.13330452 XRP. All history was previously seen;
31 new profiles plus 36 earlier specialist profiles, prior strategy tuning and asset
selection make this exploratory evidence. No claim of global or future maximum profit.
See ADR 0054 and `docs/sol-xrp-v5-2026-11-06.md`.

Validation: `pnpm check` passes **1,073 tests in 56 files**, lint, formatting,
backend/web types, smoke and contracts. Production build, doctor and all 17 original
roadmap checksums pass. All 20 final coin/version/fee-mode reports and journals replay
exactly; the 16 earlier V1–V4 report IDs are preserved. Live local READ-session
acceptance passes all 32 fee combinations, 42 selected report checks, research/report
exports, and HTTP checks for SOL/XRP, all-coin and BTC pages. Original matrix IDs and
fee preferences remain unchanged. All five v5-lab fee switches are restored on, on disk
and in the live API. The dashboard remains running. Browser automation is unavailable;
build/API/HTTP checks do not claim a visual click-through acceptance test.

### Preserved v4 implementation evidence

Current development focus is SOL/XRP only, at the user's request. Preserve all other
coin data, reports and earlier strategy versions as references. The new sidebar page
`/sol-xrp-lab` provides independent coin-specific v4 profiles, full v1–v4 comparisons,
fee controls, trade/hour inspection, retained candidate searches, chronological slices,
source assumptions, exports and deterministic verification. Existing multi-coin pages,
settings, datasets and frozen engine source files remain unchanged.

With fees on, SOL v4 (v2 base, stop 2.5 ATR, target 5 ATR) returns +126.48422578 USDT
versus v2 +50.84150945. XRP v4 (v3 base, min signal range 0.8 ATR, target 3.5 ATR,
stop 2 ATR) returns +128.68579954 versus v3 +103.91783956. Initial capital remains
10,000 USDT and risk caps are unchanged. Selection uses earlier development P&L with
fees on and a fixed drawdown ceiling; later checks are +2.61179711 SOL and +72.13330452
XRP USDT. All history was previously seen, XRP has four full-period closed trades, and
the extra 12 XRP hypotheses after an unsuccessful initial grid are disclosed. All 12
SOL and 24 XRP profiles are retained; later results do not choose the winner. This is
best within the registered grid, not a global or future maximum. All 16 final
coin/version/fee-mode reports reproduce exactly. See ADR 0053 and
`docs/sol-xrp-lab-2026-11-06.md`.
Validation: `pnpm check` passes all 1,066 tests in 54 files, lint, formatting, backend/web
typechecks, smoke and contracts. Production build, doctor and all 17 roadmap checksums
pass. Local READ-session acceptance verifies 36 retained trials, all 16 fee-switch
combinations, both v4 cost-mode replays, source report IDs, exports, the new page and
the original page. The original comparison ID and fee preferences are unchanged.
All four specialist fee switches are restored on. The dashboard is running with the
new route available. Browser automation is unavailable; build/API/HTTP verification
does not claim a visual click-through acceptance check.

Current user correction: fees are selectable in **Market strategy tests**, with one
global checkbox switch and individual V1/V2/V3 switches. Fees default to on (0.10%
per side); individual switches support mixed settings across all coins and positions.
Preferences persist across refresh/restart. Both STANDARD and ZERO scenarios are
calculated in advance, so changing a switch selects complete immutable results without
post-hoc arithmetic. Buy-and-hold is shown per strategy with the matching fee setting.
Slippage remains 0.05% per side plus tick rounding. Prior matrices and frozen BTC
engines remain intact; the standard-fee outcomes reproduce the original comparison.
See ADR 0052 and `docs/market-strategy-tests.md` for controls and API details.
Validation: all 60 actual historical reports reproduce exactly. All eight saved fee
combinations pass local authenticated API acceptance (240 selected cells, matched
buy-and-hold, mixed-mode BTC replays and export); switches took 51–88 ms. On-disk
preferences and the live API are restored to all enabled. Build, lint, formatting,
backend/web types, doctor and all 17 roadmap checksums pass. The full 1,060-test run
passed 1,059 and hit a 10-second timeout in one existing market-data CLI case during
concurrent heavy verification. Its complete 36-test file passed on isolated retry.
API/web remain running. Browser visual/click acceptance is unavailable.

Previous cost setting for **Market strategy tests**: trading fees are excluded (0% per
side) across all coins, v1/v2/v3 and buy-and-hold. Slippage remains 0.05% per side plus
tick rounding. All 30 actual historical runs completed and all 30 exact replays passed;
the earlier paid-fee matrix and original BTC engines/reports remain intact. New plans
and matrix record ZERO fee mode. Sizing, account debits and v2/v3 cost gates use the
effective zero fee, rather than adding recorded fees back to old P&L. BTC nets are now
+30.0547265 / +27.2966779 / +35.3156004 virtual USDT for v1/v2/v3. See ADR 0051 and
`docs/market-strategy-zero-fees-2026-11-04.md` for the complete retained comparison.
Validation: `pnpm check` passes 1,050 tests in 51 files, lint, formatting, backend/web
typechecks, smoke and contracts. Production build, doctor and all 17 roadmap checksums
pass. The restarted live API serves ZERO mode and zero fees for all 30 reports; all
three BTC reports also verify through the authenticated API. Page and export return 200. Owned API/web sessions remain running. Browser visual acceptance is unavailable.

Latest user-requested extension: **Market strategy tests** adds the sidebar route
`/market-strategy-tests` with Results, Strategies, Trade explorer and Sources & assumptions.
Ten actual crypto/USDT histories (BTC, ETH, SOL, TRX, BNB, XRP, DOGE, ADA, LINK, AVAX)
share the frozen BTC six-month hourly window; all 30 v1/v2/v3 runs use independent
10,000 virtual USDT accounts. USDT is a cash control, not a synthetic USDTUSDT market.
All ten captures and all 30 deterministic replays pass, with coin-specific tick/lot
filters, actual base-asset ledgers, raw-source hashes and decimal Parquet verification.
Original BTC decisions, fills, summaries and journals reproduce exactly for all versions.
Current metadata is explicitly a retrospective assumption; native forward gates remain
unchanged. Every market/version, including losses and failures, stays visible. See
ADR 0050, `docs/market-strategy-tests.md` and `docs/market-strategy-results-2026-11-04.md`.
`pnpm check` passes 1,047 tests in 51 files, lint, formatting, backend/web typechecks,
smoke and contracts. Production build, doctor and all 17 roadmap checksums pass.
Local HTTP acceptance covers the new sidebar/page (200, no welcome splash), authenticated
matrix/catalog/exports and exact selected BTC/ETH/TRX/SOL replays. The completed matrix
survives service restart. Browser automation is unavailable; visual/click acceptance is
not claimed. The owned dashboard remains running for user testing.

Latest user-requested research iteration: v3 adds causal signal-candle close-location
and range/ATR gates to frozen v2. The same snapshot yields v1 −70.7025561291, v2
−1.5624756796, and v3 +19.2079054528 virtual USDT. Both earlier engines/report IDs
remain unchanged and reproduce exactly. Three strategies/two revisions are disclosed;
all periods are previously seen. V3 has only seven trades, its later slice only two,
and doubled same-fill recorded costs would make it negative. No forward promotion.
The dashboard adds all three version selectors, v2 diagnosis, skipped trades, period
breakdowns and cost sensitivity. See ADR 0049 and `docs/btc-strategy-v3-2026-11-04.md`.
`pnpm check` passes 1,033 tests in 49 files, lint, formatting, backend/web typechecks,
smoke and contracts. Production build and doctor pass. All 17 roadmap checksums match.
Local READ-session acceptance reruns the three-way job, selects all three versions and
verifies each report exactly. Export and dashboard page return 200, without the welcome
splash. The dashboard remains running with v3 selected. Browser automation is unavailable;
the UI has build/HTTP verification rather than a visual browser acceptance check.

Latest BTC research extension: diagnosed the user's frozen −70.70 USDT run and tested
one versioned MA200 trend/cost-filter revision on the same snapshot. The original engine
and report remain intact and reproduce exactly. Full-period v2 net is −1.5624756796 USDT
versus original −70.7025561291, with 11 versus 50 closed trades and lower exposure/costs.
The later chronological check remains negative, so this is research evidence rather
than a validated profitable strategy. The dashboard provides side-by-side comparison,
attribution, original/revised decision inspection and exports. See ADR 0048 and
`docs/btc-strategy-revision-2026-11-04.md`. `pnpm check` passes 1,024 tests in 48 files,
lint, formatting, backend/web typechecks, smoke and contracts. Production build and doctor
pass. Local API acceptance verifies authenticated original/revised selection, both exact
replays, comparison export and the served page. Browser automation is unavailable in this
turn. All 17 roadmap checksums match. The dashboard remains running for user review.

Current user-requested extension: a guided `/market-test` dashboard page uses real BTCUSDT
hourly candles, six calendar months and 10,000 virtual USDT. Public raw responses and
exact-decimal Parquet are frozen; historical availability stays UNKNOWN. A separate
retrospective MA20/MA50 + ATR14 runner uses next-open fills, explicit costs, risk/allocation
caps and a reconciled SpotLedger. The page provides source inspection, assumptions,
hour-by-hour decisions, virtual fills, comparisons, export and deterministic replay.
See ADR 0047 and `docs/btc-market-test.md` for provenance, results and limitations.
Validation: `pnpm check` passes 1,015 tests in 47 files, lint, formatting, backend/web
typechecks, smoke and contract demo. Production build and doctor pass. Desktop/mobile
browser acceptance covers source inspection, strategy review, job completion, next-hour
fill inspection, JSON export, replay verification, refresh without welcome/token flash
and no horizontal overflow. Final UI contrast/candle-detail/navigation changes pass
focused lint/type/build verification. All 17 supplied roadmap checksums match. The owned local
dashboard remains running for the user at `/market-test`.

Latest UX correction: route changes and hard refreshes keep the dashboard layout while
session/data requests complete, avoiding the brief welcome-panel flash reported by the
user. Failed initial loads provide retry in the content area. See ADR 0046.

Latest follow-up: user requested removal of the token prompt from the running local
demo. The fixture dashboard now opens its reader session automatically, with no sign-in
form; deployment/public datasets cannot enable that path. See ADR 0045. Previous full
suite results below describe the completed roadmap baseline; this follow-up has focused
API/security, TypeScript and browser checks. Existing frozen protocols are retained and
must be replaced by a newly frozen experiment before running changed software.

**All implementation iterations through Module 16 are complete.** Final `pnpm check`
passes **1,002 tests in 44 files**, lint, formatting, backend/frontend typechecks, smoke
and contract demo. Production UI build, doctor, frozen-lockfile offline install and both
dependency audits pass. Acceptance checks cover protocol sessions, queued source clocks,
daily hard-loss stops, live snapshot refresh, generated-build hash stability and detached
prototype boundaries. All seventeen supplied roadmap checksums match; owned dashboard
servers are stopped after desktop/mobile browser inspection.

The committed experiment.yaml records the earlier SYNTHETIC baseline. Its verified
freeze is data/experiment-freeze-verified/manifest.json,
experiment_90f2bec95dee3cd6396742e248fdc4365194c733d72ddd77562d1a4363ade004,
hash sha256:bf60755d608c3ccc96e3a3a5d8843c91204f3a69bfda22b821edfad2675ee73a.
At that freeze, dry-run reported valid=true, codeUnchanged=true and launchEligible=false.
Subsequent code changes require a new freeze. Earlier YAML/manifests remain retained.

The actual synthetic month is frozen at
data/experiments/trial_e60ed9ba22ca2f4924aa93f80863b6db7c5058203d148595ae5bb70a1af8a948/:
3,109 events, sixteen candidates, thirty fills, thirty daily and five weekly QA outputs,
one recorded restart and a reconciled ledger. CLI semantic verification reproduces its
assessment hash. Recommendation: REVISE_AND_RESET. News/fusion each retain a
99.92554029 USDT loss; market-only retains 67.91133906; cash remains unchanged.
docs/experiment-2026-11-03-findings.md links raw inputs, hashes and ranked future hypotheses.
This is not an elapsed public month. Actual licensed acquisition/producer operation,
provider approval, production capacity and wall time remain external forward-study gates.

Module 16 Iteration 1: RFC 0016 compares a bounded Option D multilingual entity subtrack.
Iteration 2: detached synthetic-only prototype passes independent process reproduction,
temporal/ambiguity/confusable/injection and production-import boundary tests. Iteration 3:
DEFER, with two retained false positives and exact future contract/schema/replay/rights
and new-experiment requirements (ADR 0043; docs/module16-decision.md). No live connector,
private keys, real-money mode, commercial launch or frozen-protocol rewrite exists.

Final security follow-up: a full development-dependency scan found two moderate
advisories after the clean production-only scan. fflate 0.8.3 and a narrowly scoped
minimatch@10.2.6 → 11.0.4 override resolve them. Full (338 dependencies) and production
(146 dependencies) scans now report zero findings (ADR 0044). Old freezes remain intact;
the final example has a new experiment ID and a matching current software hash.

Module 15 Iteration 1: strict bounded YAML, native manifest wrapper, four model/provider
bindings, hash/time/license/risk gates, new-ID policy and dry-run CLI pass protocol failure
tests (ADR 0040). Iteration 2: durable session coordinator, immutable inbox/producer
boundary, native independent-news confirmation gate, UTC scheduling, daily reconciliation,
heartbeats, correction/duplicate/restart records, daily summaries and weekly QA implemented.
The 30-day fixture has sixteen candidates in four predeclared windows, thirty fills and
explicit delayed-confirmation HOLD outcomes; native work budgets remain in force (ADR
0041). Iteration 3: immutable assessment and nested evidence bundle compare four arms,
cash/passive endpoints, uncertainty/cost/timing/source failures and separate interruption
analysis. Synthetic/sparse results cannot become robust alpha or real-money authority.
See ADR 0042 and docs/experiment.md. Public elapsed-month collection remains a gated
operational study, requiring reviewed inputs, unchanged code and actual wall time.

Module 14 Iteration 1: authenticated Fastify read APIs and responsive Next.js overview,
runs, provenance and virtual trades pages pass trace-through-source/cutoff/risk/fill/PnL
acceptance. Production build and actual local browser trace verified (ADR 0037).
Iteration 2: actual provenance edges/contradictions, original/corrected snapshots,
verified native descriptive studies, four-arm uncertainty/drawdown/costs, frozen
parameters, complete-day correlations and exports implemented. Unattached predictive
vectors/cross-asset panels remain N/A (ADR 0038). Browser showed two original versus
seven corrected assertions with different immutable hashes; no history overwrite.
Iteration 3: role/origin/session controls, bounded rate limits, immutable control
prefix checks, current accepted source health, content-free errors and replay-verified
backups pass. A 200-request burst, rate-limit boundary, 300 malformed market packets,
100 hostile RSS documents and restore checks pass. Production dependency audit: zero
findings. Desktop trace and mobile (500 CSS px browser minimum) screenshots retained
under data/dashboard/screenshots. ADR 0039 and docs/dashboard.md include playbook,
deployment limitations, backup and rollback. All 17 roadmap SHA-256 checks still match.

Module 12 Iteration 1 is now implemented: canonical virtual orders/fills, four independent
SpotLedger portfolios, idempotent insertion, durable event files, snapshot/prefix restore
and semantic replay. Strict typecheck and ten acceptance/failure tests pass (ADR 0031).
Continuing directly to Module 12 Iteration 2.
Module 12 Iteration 2 acceptance: observed quote/queue-qualified trade execution, modeled
fees/slippage, adverse protective exits, public read-only source port and reconciled
equity/PnL are implemented. Strict typecheck and 17 broker/execution tests pass (ADR 0032).
Continuing to Module 12 Iteration 3 service reliability and observability.
Module 12 Iteration 3 acceptance: controls, heartbeats, reconciliation, content-free
quarantine, persistent CLI, snapshots and 24-hour virtual soak pass. The actual local
store at data/paper/module12-soak has 1,477 events, nine fills, 14 alerts and reconciled
ledger. Each active arm retains a 61.09693233 USDT loss; baseline remains cash. Typecheck,
lint, doctor and 23 focused tests pass. See ADR 0033 and docs/paper-broker.md. Full
regression passes: **950 tests in 34 files**. Continuing to Module 13.
Module 13 Iteration 1 acceptance: exact/reconciled metrics, N/A ratios, nonuniform-duration
exposure, partial-day/missingness and paper/backtest adapters implemented. Five focused
metrics tests and seven execution regressions pass with typecheck (ADR 0034). Continuing
to Iteration 2 uncertainty and sensitivity.
Module 13 Iteration 2 acceptance: dependence-aware paired block intervals, declared-search
correction, embargoed audit splits, insufficient-evidence/tail flags and frozen-candidate
cost/latency replays pass strict typecheck and 11 combined metrics/statistics tests.
See ADR 0035. Continuing to Iteration 3 attribution, evidence bundles and decision memo.
Module 13 Iteration 3 acceptance: versioned four-arm attribution, fixed primary comparison,
source coverage, calibration/timing disclosures, immutable linked evidence bundles and
CSV/JSON/Markdown memo implemented. Fifteen focused tests pass. Actual negative and
misleading-profitable bundles remain searchable; no alpha or real-money authority is
claimed. See docs/evaluation.md and ADR 0036. Continuing to Module 14 after full regression.
Original roadmap files and checksums remain unchanged.

The project now has strict domain/time/decimal contracts, fixture operational API/CLI,
immutable PostgreSQL history, offline imports/Parquet snapshots, finite public read-only
stream capture/replay, point-in-time metadata/universe queries, cross-venue quality and
immutable report artifacts. Descriptive event studies now align frozen news decisions
with strictly available prices and explicit benchmark/cost assumptions. Replay now has
a no-trade control and Strategy API; a separate explicit cash/spot simulator now provides
virtual orders/fills, costs, reservations and a reconciled journal. There is no live
execution or verified alpha claim. A manifest-driven backtest coordinator now reports
synthetic/control performance, cash/buy-and-hold comparisons, causal equity marks and
execution sensitivity with explicit missingness. API/doctor still report fixture
readiness; market, news review and event studies use separate explicit local services.
Single-series technical features now have a versioned formula catalog, explicit warm-up,
as-of input gates, source/coverage audits and candle-only liquidity quality flags.
Cross-asset features now use one shared cutoff, historical metadata/book-qualified
universe selection, explicit backward joins, measured breadth/turnover concentration,
deterministic regimes and individually timed optional derivatives.

## Module 11, Iteration 1 deliverables

Continuation mandate (2026-11-03): the user explicitly requests all remaining modules and
iterations without stopping at boundaries. Acceptance and handoff remain sequential; the
earlier instruction to stop after each iteration is overridden for this implementation run.

Module 11 Iteration 2 acceptance: deterministic risk contracts/engine implemented;
strict typecheck and 17 focused tests pass. See ADR 0029. Continuing to Iteration 3.
Module 11 Iteration 3 acceptance: immutable DecisionRecord, regime/uncertainty sizing,
evidence/manifest links, diagnostic counterfactuals, conflicts/contributions/correlation
implemented. Strict typecheck/lint and 24 combined tests pass. See ADR 0030. Continuing
to Module 12 after the full regression check.

Added four independently identified candidate portfolios with identical initial virtual
capital, currency, opportunity grid, prefix snapshot, fees and execution assumptions.
Cash is the simple baseline. Trusted producer ports receive only immutable own-arm
opportunity/shared assumptions; no sibling candidates, PnL, positions or outcomes are
provided. Each submission is immediately cloned and validated. Existing canonical
candidates and their evidence references are retained without rewriting component state.

Versioned agreement-only (default), disagreement-to-HOLD and weighted-calibrated policies
require historical TRAIN-only selection receipts and a freeze before every decision.
Conflict defaults to HOLD. Weighted support requires a matching historical calibration
artifact and known directional net-return probability; current untrained news rules do
not qualify. Missing inputs abstain. Exact duplicates collapse; conflicting identities,
ambiguous opportunities, future evidence and mismatched assumptions reject.

New `fusion-*.v1` schemas and immutable reports preserve complete input, per-arm candidates,
source/evidence hashes, common assumptions and a chained journal. Semantic verification
rebuilds every result. `pnpm fusion fixture/run/verify` supports offline synthetic review
and exclusive output files. The fixture has conflict HOLD, deduplicated agreement LONG
and explicit-HOLD abstention, with zero orders and no performance/promotion claim.

Files: `packages/contracts/src/fusion.ts`, `packages/strategies/src/fusion*.ts`,
`apps/cli/src/fusion.ts`, `tests/fusion.test.ts`, `docs/fusion-isolation.md` and ADR 0028.
No SQL migration, dependency version change or earlier schema change is required.
Producer closures are trusted in-process code; references do not authenticate external
reports or replace upstream artifact verification. Full account/risk state remains later work.

Verification on 2026-11-03, pinned Node 24.22.2 / pnpm 10.34.9:

- `pnpm check` passes: lint/format, strict typecheck, **903 offline tests in 29 files**,
  fixture smoke and the ten-contract demonstration. The **44 new focused tests** pass.
- Doctor passes with execution disabled and zero orders. Frozen dependency installation
  passes; dependency versions and lockfile are unchanged. All **17 roadmap files** retain
  their recorded hashes and byte lengths. No actual PostgreSQL integration run is needed
  for these additive artifact/strategy interfaces; no persistence implementation changes.
- Actual CLI fixture, semantic verification and recorded-input replay pass. Original and
  replayed JSON files are byte-identical. Existing-path overwrite and unsupported/live flags
  are rejected. The synthetic report contains three windows and four isolated arms.

Local report: `data/fusion/module11-iteration1-synthetic.json`.
File SHA-256: `1246eecdbbc07557cf3c8ff26e9d87904ece6865fd1e54a42f17c7afc6651e33`.
Input hash: `sha256:4d1ac5c70521e348be45ef069c04cd3f66b967b3f24126b29192b6606c22a13b`.
Journal head: `sha256:f9661cc253ea800d895bfcd813a6f258e71c9419ab1cc3d5f8793c394c0ef915`.

Next implement exactly Module 11 Iteration 2: deterministic risk rules and sizing with
valid stop/position policies, kill switch, daily loss, exposure/correlation, stale-data,
cooldown and liquidity checks. Preserve per-arm isolation and immutable candidate handoff.
Do not implement Iteration 3 conflict attribution or Module 12 broker in that iteration.

## Module 10, Iteration 3 deliverables (preserved prior handoff)

Added grounded immutable explanations for observed claims, independent origins,
contradictory/retracted evidence, event age, publication/receipt clocks, prior conditional
comparisons, assumed costs and abstention. Recognized instruction-like source text is
quarantined; quoted text never becomes executable instructions or producer configuration.
Human-readable reports escape active HTML/Markdown. Exact known prompts/models and
per-extraction article costs are archived with a deterministic no-LLM fallback.

The adversarial replay contains ten cases and 180 decisions, including injection,
official-looking rumor, altered publication timestamps and later contradiction/retraction.
Each decision links its exact known prefix. A separate fixed TEST cohort after model
availability evaluates twelve opportunities on six date blocks, with cash and fixed-long
controls on the same declared grid, horizon, cost assumptions and common coverage.
TEST outcomes never refit or change producer decisions. Source updates preserve state;
duplicate/missing opportunities, fitting-lineage/price reuse and changed scope are rejected.

The synthetic report retains four price false positives and six hindsight missed-event
cases. Mean paired news-minus-cash markout is approximately -0.00083333 and news-minus-long
approximately +0.00016667; both conditional intervals cross zero. These are price markouts,
not fills, executable SHORTs, account equity or net ledger PnL. Missing outcomes stay null.
Synthetic evidence remains diagnostic only, with no real incremental-edge or promotion claim.

| Path                                          | Result                                                                                                             |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `packages/contracts/src/news-audit.ts`        | Strict explanation, TEST plan, evaluation, archive and bundle contracts                                            |
| `packages/strategies/src/news-explanation.ts` | Canonical frame wrapper and source-grounded immutable descriptions                                                 |
| `packages/backtest/src/news-audit*.ts`        | Adversarial/later-period replay, paired uncertainty, prompt/cost archive, atomic bundles and semantic verification |
| `packages/backtest/src/news-*-fixture.ts`     | Extended synthetic recipes with preserved original defaults                                                        |
| `apps/cli/src/news-audit.ts`                  | `pnpm news-audit fixture/run/verify/report/reproduce`                                                              |
| `tests/news-audit.test.ts`                    | Explanations, injection, chronology, state, price outcomes and tamper regression                                   |
| `docs/news-audit.md`, ADR 0027                | Interpretation, limitations and Module 11 handoff                                                                  |

Bundles retain 192 explanations, 102 unique prefix snapshots, the complete decision
journal, 108 unique extraction records and a versioned Module 11 handoff. Provider ports
remain NewsSignalProvider/EstimatedNewsSignalProvider. Default action is HOLD, execution
DISABLED and promotion NOT_AUTHORIZED. No SQL migration, third-party dependency versions
or earlier artifact formats change.

The new focused acceptance/failure suite has **38 passing tests**, covering canonical
explanations, source injection, publication clocks, later evidence, source-policy bindings,
cohort fairness, price missingness, retained negative results and semantic tamper rejection.

Verification on 2026-11-02, pinned Node 24.22.2 / pnpm 10.34.9:

- `pnpm check` passes: lint/format, typecheck, **859 offline tests in 28 files**,
  fixture smoke and ten-contract demo. All **38 new tests** pass.
- A new two-replay immutable-reuse test initially exceeded its 60-second budget under
  two-worker load. Its own budget is now 120 seconds with all assertions retained.
  An overnight host pause invalidated another timing run. The accepted full run used
  a temporary process-scoped keep-awake request, released afterward; no persistent
  power settings or existing global test/worker limits were changed.
- Doctor passes with execution disabled and zero orders; frozen offline installation
  passes for all 16 workspace projects. Actual isolated PostgreSQL regression passes
  **28 tests**; the project cluster is stopped afterward and the separate service is
  untouched. All **17 original roadmap files** retain checksums and byte lengths.
- Actual full-fixture CLI run, verify, report and reproduce pass. All **108 indexed
  files plus bundle.json** are byte-identical across original, independently rebuilt
  and reproduced roots. Every explanation/prefix binding and original/estimated
  rationale is checked, including explicit unknown edge for untrained rules.
- Retained news-edge, conservative-news, hypothesis-registry, ML, market-baseline,
  backtest, spot and replay artifacts verify unchanged. Exact identities/results are
  retained in `data/news-audit/handoff-summary.json`.

Final synthetic bundle:
`data/news-audit/news-audit_a47e94ca91e487497d3a342dd3fc02c2fe0a32ade9855c73ce456da53c3d412c/`.
Report hash `sha256:a47e94ca91e487497d3a342dd3fc02c2fe0a32ade9855c73ce456da53c3d412c`;
decision-chain head `sha256:327f2ac2b95d4a20cf4721bb9b8ba0d840badc633697fe11fd9dff5bf9361951`.

Next implement exactly Module 11 Iteration 1 — Independent Strategy Isolation. General
risk sizing, fusion policies, paper broker and live execution are not implemented here.

## Module 10, Iteration 2 deliverables

Added predeclared conditional event-return estimates over Module 06's event-study
evidence. Training and validation are chronological, with complete pre/outcome windows
purged at boundaries. The fitter materializes known input prefixes, rebuilds each event's
as-of context and excludes descriptive archives and unreliable/late price labels.
Conservative news admission remains in force. Future market features never enter inference.

Historical controls subtract unit-beta benchmark drift, match pre-news relative moves
and retain non-event return distributions. First-seen and repeated patterns remain
separate strata. Shared lineage, control/bar evidence and overlapping windows collapse
to sampling blocks; complete phase samples cannot reuse lineage or price evidence.
Joint seeded bootstrap intervals count all declared hypotheses, horizons, metrics and
phases. Insufficient units or tail resolution leave intervals missing and force HOLD.

Direction and horizon are selected on TRAIN only; later VALIDATION gates that fixed
choice without fallback. Both directional gross and controlled-excess bounds must clear
assumed costs plus a nonzero uncertainty buffer. Predictions carry both cohorts' sample
and block counts, validation conditional means/mean intervals, model vintage and distinct
event support. No event-truth probability, stop, target, size, fill or PnL is invented.
Higher inference costs can veto; lower supplied costs cannot undercut the frozen floor.

| Path                                         | Result                                                                                                           |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/news-edge.ts`        | Strict versioned plan, fit rows, statistics, model, prediction and inference contracts                           |
| `packages/research/src/news-edge-data.ts`    | Known-prefix materialization, exact-close outcomes, matched controls and exclusion rows                          |
| `packages/strategies/src/news-edge*.ts`      | Block estimates, chronological selection/cost gates, structural news provider and immutable semantic model files |
| `packages/backtest/src/news-edge-fixture.ts` | Synthetic source-backed training/validation, recurrence, archives and later inference events                     |
| `apps/cli/src/news-edge.ts`                  | `pnpm news-edge fixture/train/verify/report/infer/reproduce`                                                     |
| `tests/news-edge.test.ts`                    | 43 acceptance and failure tests                                                                                  |
| `docs/news-edge.md`, ADR 0026                | Protocol, conditional uncertainty, provenance, temporal limits and handoff                                       |

The synthetic fixture retains eight hypothesis/horizon attempts. Five-minute incident
SHORT and listing LONG diagnostics each have six TRAIN and three VALIDATION blocks.
One-minute alternatives fail cost/uncertainty; recurrent strata have one/zero units and
abstain. Eight descriptive-only rows retain null fit labels. Synthetic and mixed evidence
remain diagnostic only, with execution disabled and no promotion or real edge claim.
No SQL migration, dependency versions or prior artifact formats change.

Verification on 2026-11-01–02, Node 24.22.2 / pnpm 10.34.9:

- `pnpm check` passes: lint/format, typecheck, **821 offline tests in 27 files**,
  fixture smoke and ten-contract demo. The new suite has **43 passing tests**.
- An earlier full run timed out in existing dataset-panel setup and a backtest
  identity check. The affected suites and final news suite passed **112 tests**
  in a serial recheck; the subsequent complete default two-worker run passed all
  821 tests. No assertions, timeout thresholds or worker settings were changed.
- Doctor passes with execution disabled and zero orders. Frozen offline installation
  passes for all 16 workspace projects.
- Actual isolated PostgreSQL regression: **28 tests pass**; the project cluster is
  stopped afterward and the separate Windows service is untouched.
- The final CLI fixture contains **88 rows**, **8 fit attempts**, **2 TRAIN-selected
  five-minute diagnostics** and **8 descriptive-only rows with null fit labels**.
- Actual CLI train, verify, report, infer and reproduce pass. Original, independently
  retrained and reproduced model files are byte-identical. Future requests produce
  SHORT/LONG diagnostics and HOLD on high costs or sparse recurrence evidence; every
  prediction binds model/vintage, sample counts, intervals and source snapshots.
- Retained conservative-news, hypothesis-registry, ML, market-baseline, backtest, spot
  and replay artifacts verify unchanged. All **17 original roadmap files** retain
  their recorded checksums and byte lengths. Exact acceptance identities and results
  are retained in `data/news-edge/handoff-summary.json`.

Final synthetic model:
`data/news-edge/news-edge_41c7640ee7e6aaab7ed52ef734cc7a18ccf30c393d52da48548e72efe61710ee.json`.
Report/model hash `sha256:41c7640ee7e6aaab7ed52ef734cc7a18ccf30c393d52da48548e72efe61710ee`.

Next implement exactly Module 10 Iteration 3: explained adversarial replay and incremental
value over a non-news baseline in later time-separated data. No fusion or live execution.

## Module 10, Iteration 1 deliverables

Added a structural NewsSignalProvider and versioned conservative rules over validated
decision-time event snapshots. Reported severity, declared expectation mismatch, corpus
novelty, direct asset mappings, independent affirmative origins, conflicts, rescission,
publication/first-known delay and fixed event expiry gate each conditional opinion.
Weak rumors, unknown availability and unclear impact abstain. A separate timestamp/source
receipt vetoes stale or ineligible market data without exposing market prices or features
to direction rules. Score/calibration remain MISSING; no stops or orders are invented.

Ten reprints retain one origin and unchanged support/material identity. Future evidence
cannot change earlier candidate IDs. Admission state prevents repeated identical opinions,
and vetoes do not consume future opportunities. All decisions link exact prefix snapshots,
evidence and sources. Immutable bundles retain manifests, snapshots, hash-chained decisions
and reports; verification semantically rebuilds every indexed byte. Fixture truth is
audit-only. Default clocks, source roles, amounts, prices and incidents are synthetic.

| Path                                        | Result                                                                                        |
| ------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `packages/contracts/src/news-signals.ts`    | Strict versioned rules, receipt, state, opinion, candidate replay and artifact contracts      |
| `packages/strategies/src/news-signals.ts`   | News-only provider, as-of prefixes, corroboration and abstention policy                       |
| `packages/strategies/src/news-freshness.ts` | Separate market timestamp/metadata eligibility veto without price features                    |
| `packages/backtest/src/news-signal-*.ts`    | Eight synthetic scenarios, bounded replay, atomic immutable bundles and semantic verification |
| `apps/cli/src/news-signal.ts`               | `pnpm news-signal fixture/run/verify/report/reproduce`                                        |
| `tests/news-signals.test.ts`                | 42 acceptance and failure tests                                                               |
| `docs/news-signals.md`, ADR 0025            | Policy, market independence, evidence limits and next-iteration handoff                       |

This is an event-snapshot replay with execution disabled, separate from Module 08's
raw-input scheduler. No historical edge, factual probability or profitability is claimed.
No SQL migration or earlier artifact formats change. Existing workspace news/connectors
dependencies are linked; third-party versions are unchanged. Next implement exactly
Module 10 Iteration 2, preserving temporal eligibility and minimum-sample/cost gates.

Verification on 2026-11-01, Node 24.22.2 / pnpm 10.34.9:

- `pnpm check` passes: lint/format, typecheck, **778 offline tests in 26 files**,
  fixture smoke and ten-contract demo. The new suite has **42 passing tests**.
- `pnpm run doctor` passes with execution disabled and zero orders. Frozen offline
  installation passes for all 16 workspace projects.
- Actual isolated PostgreSQL regression: **28 tests pass**. The project cluster is
  stopped afterward; the separate Windows service is untouched.
- All **17 original roadmap files** retain their recorded checksums and byte lengths.
- Final CLI fixture contains **144 decisions**, **72 prefix snapshots**, **2 LONG,
  3 SHORT and 139 HOLD**, with every candidate linked to its exact known evidence.
- Actual CLI run, verify, report and reproduce pass on the full fixture. All **76
  indexed files plus bundle.json** are byte-identical across original, independently
  rebuilt and reproduced roots. Every decision/snapshot prefix is checked again.
  Retained ML, market-baseline, backtest, spot and replay artifacts verify unchanged.
  Acceptance details are retained in `data/news-signals/handoff-summary.json`.

Final synthetic bundle:
`data/news-signals/news-signals_986e6978bbb122145975a4a27ae928cdefe4d8062472d0832a31f5d8b7be311d/`.
Report hash `sha256:986e6978bbb122145975a4a27ae928cdefe4d8062472d0832a31f5d8b7be311d`;
decision-chain head `sha256:d8b72991ea903b132320e00aa827b7daaf0561d93fdb28d448014e47374b3854`.

## Module 09, Iteration 3 deliverables

Added predeclared producer/scenario experiments, durable complete-attempt journals,
cost/volatility/parameter/feature stress, risk-adjusted net rankings, joint time-block
uncertainty and immutable Module 11 handoff/archive receipts. Every planned cell is
logged before execution; runtime failures remain in the family. Source/quantity/clock
fairness, publication, historical metadata, feature and execution gates are retained.
Original ML candidates remain immutable; a separately identified long-only projection
preserves their expiry and links the actual post-receipt execution request.

The experiment freezes new model/panel identities for three-bar labels and genuine
feature ablation. It preserves the unexecuted two-bar control rather than extending its
validity to fabricate fills. Scores include worst sampled drawdown and empirical cell
loss tails. Marginal block intervals are explicitly conditional; insufficient blocks,
unknown marks, flat series and inadequate Monte Carlo resolution prevent inference.
Holm adjustment conservatively counts prior, failed and imported calibration attempts.
Synthetic evidence never promotes a model, and the predeclared cap is two candidates.

| Path                                             | Result                                                                                                    |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/market-robustness.ts`    | Versioned strict plan, attempt, journal, evidence, risk, ranking and bundle contracts                     |
| `packages/backtest/src/robustness-runner.ts`     | Complete attempt logging, causal rule/ML executions, independent cached controls and lineage              |
| `packages/backtest/src/robustness-statistics.ts` | Risk-adjusted net ranking, cell tails, joint circular blocks, Holm padding and selection gates            |
| `packages/backtest/src/robustness-fixture.ts`    | Sparse, fixed BTC/ETH/SOL × regime/cost/volatility stress design                                          |
| `packages/backtest/src/robustness-artifact.ts`   | Atomic bundles, synced journals, interruption retention, semantic rebuilding and archive/handoff receipts |
| `packages/strategies/src/market-baselines.ts`    | Structural MarketSignalProvider interface with compatible constructor value                               |
| `packages/research/src/technical-features.ts`    | Full-identity small-row cache, bounded to 256 rows / 8 MiB without changing causal/budget semantics       |
| `apps/cli/src/robustness.ts`                     | `pnpm robustness fixture/run/verify/report/reproduce` and versioned parent continuation                   |
| `tests/market-robustness.test.ts`                | 35 acceptance/failure tests for clocks, accounting, execution, statistics, selection and integrity        |
| `docs/market-robustness.md`, ADR 0024            | Protocol, formulas, uncertainty interpretation, observed-history retention and handoff                    |

Actual checks on 2026-11-01, pinned Node 24.22.2 / pnpm 10.34.9:

- `pnpm check` passes: **736 offline tests in 25 files**, lint/format, typecheck,
  fixture smoke and ten-contract demo. The new suite has **35 passing tests**.
  Tests include finite equity reconciliation, Holm arithmetic, joint-block sample
  accounting, missing cells, unknown risk, inactive trials, candidate caps, metadata/
  clock/source tampering, unchanged original signals, expiry and interruption failures.
- `pnpm run doctor` passes: fixture-only readiness, execution disabled and zero
  operational orders. Frozen offline install passes for all 16 workspace projects;
  no third-party version, dependency or SQL migration changes are introduced.
- Actual isolated PostgreSQL regression: **28 tests pass**. The project cluster is
  stopped afterward and the separate Windows service is untouched. All **17 original
  roadmap files** retain recorded SHA-256 and byte lengths.
- Actual development experiment completed **96 cells**, with zero runtime failures
  and declared family **161**. Its complete v1 evidence remains immutable. The final
  continuation verifies this parent and retains its observed 161 floor, then adds
  **96 current cells + 16 imported calibration trials = family 273**. Observed trials
  are not discarded when protocol/storage infrastructure is refined.
- Final CLI experiment: **8 producer versions × 12 scenarios = 96 completed cells**,
  independent cash/buy-and-hold simulations per scenario, **290 journal records** and
  indexed handoff/archive receipts. All cases, evidence bytes, report/Markdown, journal
  and family counts pass full semantic rebuilding. The design includes all nine base
  symbol/regime cells plus explicit high-cost, volatility and combined stresses.
- Final bundle contains **114 indexed files plus bundle.json**. All four frozen model
  bundles refit-verify against their two source Parquet panels. Actual CLI run, verify,
  report and reproduce on the explicitly labelled exact-cell acceptance fixture yield
  byte-identical report, journal, control, strategy and archive/handoff files; the full
  96-cell report is retained separately and semantically byte-rebuilt in its entirety.
  Earlier published ML, market-baseline, backtest, spot and replay artifacts still
  verify unchanged. Acceptance validation is not used to choose or rank a new model.
- MA 3/5 versus 2/4 changes **24/144** signal events and maximum net return by
  **0.00661813**. Retrained removal of return_2 changes **55/144** signal events and
  maximum net return by **0.00788694**. The small L2 perturbation changes no executed
  decisions/net returns in this fixture; that stability is retained alongside failures.
- Three-bar full ML has mean net return **0.0030800441666666667**, worst sampled DD
  **0.007577941156977527**, worst-cell/CVaR05 **−0.0027325**, and penalized score
  **−0.007230396990310861**. Its ablation score is **−0.008315716156977527**;
  MA 2/4 score is **−0.030537960833333336**. Every active strategy scores negatively.
  The two-bar control has zero fills/return and cannot qualify as an executed edge.
- The sparse window has too few time blocks: conditional marginal intervals remain
  labelled, raw/Holm inference stays null and no confidence is fabricated. **Zero
  candidates are promoted; all eight versions are archived** with explicit reasons,
  producer/feature fingerprints and model/config snapshots. This is a valid abstention
  under the predeclared selection rule, not a profitability conclusion.

Local ignored evidence:

- Final bundle:
  `data/market-robustness/market-robustness_966201f3e8613f0c90e31dc85de848a693c6282a534ae406f7f9d23b1a6008f6/`.
  It includes report/plan/Markdown, the full journal and per-case/control evidence,
  plus `evidence/robust-handoff.json` and `evidence/robust-archive.json`.
- Parent development bundle:
  `data/market-robustness-development/market-robustness_810dade1c4ec1f454c76f36f1637b62ec528c4ecd17ac070fef5cc129f67cc46/`.
  Bundle v1 keeps archive content in its report; v2 additionally requires separate
  indexed receipts. Semantic compatibility is retained without rewriting the parent.
- `data/market-robustness/models/` contains four frozen training bundles, and
  `data/market-robustness/panels/` contains the original [2] and new [2,3]-horizon
  source Parquet snapshots. `handoff-summary.json`, `fixture-console.txt` and
  `verify-handoff.txt` retain actual checks and the verification recipe.
- Plan hash: `sha256:010b7b68e5c88c37950ecd511980ab7a22a71e381c3a0e6d948b90515520dafc`.
- Journal head: `sha256:043652ca1d220bb5f089c2ffa00eb0979858604bd7a2d7eb2e59d63319ef275d`.
- Software version:
  `working-tree:sha256:1d27bcaab64f514e6984a238d70d025750cb65f05c761d5471b9fffe3b1d5f81`.

Limits: sparse synthetic counterfactuals, not independent historical samples or a full
factorial test. The score is not annualized Sharpe; the cell tail is empirical, and
bootstrap/Holm diagnostics do not establish population calibration or unconditional
FWER on nonstationary markets. Hashes cannot authenticate unrecorded external research
attempts or asserted clocks. Dataset/source eligibility and original expiry remain
mandatory. There is no borrowed short, definitive alpha claim, model promotion, news/
fusion provider, general risk engine or live trading. Stop here; next read the master
and exactly **Module 10, Iteration 1 — Conservative Rules and Abstention**.

## Module 09, Iteration 2 deliverables

Added fixed-horizon DOWN/HOLD/UP labels with an inclusive return abstention band and
bounded, deterministic full-batch multinomial logistic regression in TypeScript.
Training enters through the existing semantically verified frozen Parquet panel;
source, row, formula, split and software lineage are retained. TRAIN-only population
scaling and fitting exclude missing values; clipping is frozen. Validation alone
selects temperature from four predeclared values. TEST never fits preprocessing,
weights, thresholds or calibration. Global purge/embargo and label-availability cutoffs
are independently rechecked, and target fields are absent from inference queries.

Reports include TRAIN class-prior, ALWAYS_HOLD and fixed symmetric MA 2/4 direction
baselines on the same held-out rows, class reliability curves, log loss, Brier sum,
action accuracy/confusion and coverage. They retain worse TEST calibration diagnostics.
Historical assessments are explicitly RETROSPECTIVE_OUT_OF_SAMPLE. Actual candidate
inference requires the model's declared availableAt plus causal fresh features and
historical raw metadata/precision. Unavailable models and missing/stale inputs abstain.
The adapter emits immutable replay candidates and never accesses news, labels or accounts.

| Path                                                                    | Result                                                                                  |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `packages/contracts/src/market-ml.ts`                                   | Versioned strict config/model/feature/probability/report/bundle contracts               |
| `packages/strategies/src/market-ml-data.ts`, `market-ml-math.ts`        | Inclusive labels, split/leakage guards, seeded full-batch numerical fitting             |
| `packages/strategies/src/market-ml-training.ts`, `market-ml-report.ts`  | TRAIN-only scaling, validation calibration, naive/rule baselines and reliability curves |
| `packages/strategies/src/market-ml-inference.ts`                        | Publication/freshness/formula gates and market-only candidate adapter                   |
| `packages/strategies/src/market-ml-fixture.ts`, `market-ml-artifact.ts` | Fixed synthetic cohort and immutable semantic model/report bundles                      |
| `apps/cli/src/market-ml.ts`                                             | `pnpm ml fixture/train/verify/report/reproduce/infer`                                   |
| `tests/market-ml.test.ts`                                               | 41 acceptance/failure tests for labels, gradients, leakage, inference and artifacts     |
| `docs/market-ml.md`, ADR 0023                                           | Mathematical, temporal, probability and artifact policies; next-iteration boundary      |

Actual checks on 2026-11-01, pinned Node 24.22.2 / pnpm 10.34.9:

- `pnpm check` passes: **701 offline tests in 24 files**, lint/format, typecheck,
  fixture smoke and ten-contract demo. The new suite has **41 passing tests**.
  The first full run encountered two artifact-test timeouts; shared immutable fixture
  setup and separate reproduction/reuse checks remove redundant fitting and resolve
  them. The two-worker limit and project-wide deadlines remain unchanged.
- `pnpm run doctor` passes with fixture-only readiness, execution disabled and zero
  operational orders. Frozen offline installation passes for all 16 workspace projects;
  no third-party version, SQL migration or dependency change is introduced.
- Actual isolated PostgreSQL regression: **28 tests pass**. The project cluster is
  stopped afterward; the separate Windows service is untouched. All **17 original
  roadmap files** retain their recorded SHA-256 and byte lengths.
- Fixed BTC/ETH/SOL synthetic panel: **99 TRAIN, 63 VALIDATION, 66 TEST rows** after
  purge/embargo. Same seed, snapshot and configuration reproduce full report/model
  and prediction bytes. Finite-difference derivatives agree with one gradient step;
  fitted coefficients remain finite and the regularized TRAIN objective decreases.
- The TEST outlier experiment rebuilds the frozen panel with changed TEST prices;
  scaler, fitted weights/biases and validation temperature remain identical while
  TEST forecasts change. Boundary-touching labels, late label publication, split
  spoofing, target-as-feature dependencies, future watermarks and bad Parquet fail.
- Validation chooses **temperature 0.5**, which **worsens TEST log loss** from
  **0.7098515868133067** to **0.7464301162124755**; this negative result is retained.
  Calibrated synthetic action accuracy is **0.6818181818181818**, coverage
  **0.803030303030303**, Brier sum **0.41225680358667277**. Fixed MA accuracy is
  **0.5454545454545454**; class-prior log loss is **1.0518691495564876**. These are
  correlated synthetic classification diagnostics, not independent samples or PnL.
- Actual CLI fixture, train from config/Parquet, verify, report and reproduce pass.
  Independent original/build/reproduction roots have **identical bytes for six files**:
  report.json, report.md, model.json, config.json, predictions.json and bundle.json.
  Tests reject forged Markdown even with a recomputed file checksum and preserve
  immutable reuse. Fixture/invalid-option commands never enable real execution.
- Actual numerical-inference CLI rejects the saved pre-publication request and agrees
  with post-publication inference. A synthetic forward-only replay emits HOLD before
  availability and verified immutable candidates afterward. Existing published market
  baseline, Module 08 backtest, spot and replay artifacts still verify unchanged.

Local ignored evidence:

- `data/market-ml/handoff-summary.json`, `fixture-console.txt` and `verify-handoff.txt`
  record the checks, software/lineage, metrics, inference and prior-artifact compatibility.
- Bundle: `data/market-ml/market-ml_aea93b9441fd4c82cf2f80515ef57011220a19e25d497908150e377bdd1665a1/`.
  Equal copies are under `data/market-ml-built/` and `data/market-ml-reproduced/`.
- Source panel:
  `data/market-ml/panels/dataset-panel_5a1ee9ed05c4a6ce37a67e76a7f6769276413e9e99803795c1a158dcf5add1d2/`.
- Parquet hash: `sha256:92691cc0dddf6a94c00db98ab1309e5452169cf307ff3fd31cafedd13b67c145`.
- Model: `market-logistic_b53f5f4cdceb336bd92c8c90603939262d30323bf5e045b98bfc20422301bf60`;
  model hash `sha256:0368ac7dc2d962035484e5513c7d66d6ed6f7749bebb21887d9ad35d9118b34f`.
- Prediction hash: `sha256:718edfc44ff37570e665c17caa228462357351a6de86544086ed4d261cdad3ad`.
- Forward signal evidence:
  `data/market-ml-forward/replay_9e04e509085dc46df42e0ecc47dd053ba8e0f0faec81a3774d3486000dc999ed.json`.
- Software version:
  `working-tree:sha256:ce8f80e16c7edb3dcf7a817a7050ccd781e402e064f20fcc0dcb5f100f3444db`.

Limits: asserted research cutoffs do not establish historical model publication;
availableAt equals declared generation and earlier decisions are rejected. Probabilities
refer to fixed-horizon gross-return bands, not profitability or trade success. Numerical
reproduction is scoped to pinned Node binary64. Work is capped at 2,000 included rows,
eight technical columns and eight million row×column×epoch units, with one shared
formula/history configuration. No real training, calibrated guarantee, cross-feature ML,
Python/ONNX training container, ranking, statistical selection or live trading is added.
Existing costed deterministic baselines remain mandatory. Stop here; next read the master
and exactly **Module 09, Iteration 3 — Robustness and Regime Testing**.

## Module 09, Iteration 1 deliverables

Activated @crypto/strategies with neutral cash, buy-and-hold, configurable SMA/EMA
crossover, prior-window breakout, z-score mean reversion and a symmetric synthetic
MA signal diagnostic. Market providers ignore news, consume only causal closed-bar
features and retain selected input/metadata IDs, timestamps and immutable fingerprints.
Explicit eligibility, warm-up, cooldown, holding duration and missing-data exits keep
unavailable evidence from becoming an entry. Invalid MA history resets its relation
rather than consuming a crossover that could never have been actionable.

The separate fixed target sizing interface uses actual owned inventory, with no score,
price, volatility or PnL sizing inputs. Post-receipt prefix simulation at decision plus
one nanosecond prevents assumed fills or same-window execution. Pending/partial orders
block stacking; opposing orders cancel once. Rejected or expired attempts do not retry
on each HOLD. Derived execution-candidate IDs preserve original signal identity and
link sizing/prefix provenance. The existing unborrowed spot executor retains its vetoes.
Symmetric short targets remain **signal-only fixtures with execution DISABLED**;
no borrowed-short accounting or financial short performance is introduced.

| Path                                                                  | Result                                                                                               |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/market-strategies.ts`                         | Versioned strict provider/state/decision/sizing/manifest/report/bundle schemas                       |
| `packages/strategies/src/`                                            | Market-only providers, historical source/precision eligibility and fixed target sizing               |
| `packages/backtest/src/market-backtest.ts`, `market-sizing-bridge.ts` | Causal target reconciliation and independent cash/buy-and-hold accounts                              |
| `packages/backtest/src/market-fixture.ts`, `market-artifact.ts`       | Predeclared synthetic regimes and immutable semantic report bundles                                  |
| `apps/cli/src/market-baselines.ts`                                    | `pnpm backtest market-fixture/market-matrix/market-run/market-verify/market-report/market-reproduce` |
| `tests/market-baselines.test.ts`                                      | 40 acceptance/failure tests for signals, PIT gates, sizing, costs and artifacts                      |
| `docs/market-baselines.md`, ADR 0022                                  | Interfaces, formulas, timing, synthetic restrictions and next-iteration handoff                      |

Actual verification on 2026-11-01, pinned Node 24.22.2 / pnpm 10.34.9:

- `pnpm check` passes: **660 offline tests in 23 files**, lint/format, typecheck,
  fixture smoke and ten-contract demo. The new focused suite has **40 passing tests**.
- `pnpm run doctor` passes: fixture-only readiness, execution disabled and zero
  operational orders. `pnpm install --offline --frozen-lockfile` passes for all
  16 workspace projects. Only workspace links change; third-party versions and SQL
  migrations remain unchanged.
- Actual isolated PostgreSQL regression: **28 tests pass**. The project cluster is
  stopped afterward; the separate Windows service is untouched. All **17 original
  roadmap files** retain recorded SHA-256 and byte lengths.
- Actual `market-matrix` produces **45 costed reports / 135 independent accounts**:
  BTC/ETH/SOL × three fixed regimes × five provider kinds. It also produces **three
  symmetric signal-only reversal reports**. All **48 bundles** pass semantic rebuild,
  source/config/hash verification and Markdown regeneration. No trial ranking or
  parameter/model selection is performed.
- Each SMA trend produces exactly one long entry after warm-up. Each MA whipsaw has
  three complete round trips and six fills. BTC gross PnL is **−18.63**, fees **0.60003**,
  net **−19.23003**; ETH net is **−18.63003**, SOL net **−18.27003**. Each cash comparator
  returns exactly zero. Higher fees preserve gross/fill paths and worsen net PnL.
  Symmetric reversal diagnostics retain both virtual long and short target states.
- Actual CLI run from a manifest, verify, report and reproduce all pass. Independent
  original/build/reproduction directories contain **identical bytes for all four
  bundle files**. Tests also cover news isolation, unavailable metadata, invalid raw
  precision, low volume/staleness, future price perturbations, missing exits, corrections,
  cooldown, partial fills, rejected entries, pending cancellation, unsupported options
  and report tampering. Previous replay, spot and Module 08 backtest artifacts still
  verify using their original stored software labels and content hashes.

Ignored local handoff evidence:

- `data/market-baselines/handoff-summary.json` records all 48 cases, costs, checks,
  software version and prior-artifact compatibility. `matrix-console.txt` and
  `verify-handoff.txt` retain the CLI transcript and verification recipe.
- Representative BTC whipsaw bundle (an acceptance example, not a model selection):
  `data/market-baselines/market-baseline_10b6519805638372be3af21db52db7e2e4f73cdf90baf50db540d29b919bd67f/`.
  Identical copies exist under `data/market-baselines-built/` and
  `data/market-baselines-reproduced/`.
- Manifest hash: `sha256:f614cc9d6536e379d5fb551963cf48ca7584691239820e44ffd1e7bb912bf6d2`.
- Provider hash: `sha256:557a8c73b92bc9fe9f4131367cd189b40ee3e8eb44929dc0573dffc416223d63`.
- Feature fingerprint: `sha256:2cd0b313c1182e20b968682900fdbf6a5a19e370a98a1dfaeed9f976e87e6f4d`.
- Software version:
  `working-tree:sha256:0370395c7e9f1cc7b0404b458fec9c04dc46e662f9e99c633d7b5988fc635965`.

Limits: bounded 128-bar, single-series spot research; depth/queues/intrabar paths are
unknown. These fictional prices are not historical profitability or generalization
evidence. There is no ML training, labels, probability calibration, statistical ranking,
real short execution, general risk engine or live trading. API/doctor remain fixture-only.
Stop here; next read the master and exactly **Module 09, Iteration 2 — Training Data
and Simple ML**, preserving mandatory deterministic baselines and temporal leakage gates.

## Module 08, Iteration 3 deliverables

Added frozen versioned execution/backtest manifests, replay-to-candidate/order bridging,
independent cash and quantity-matched buy-and-hold comparisons, gross/net performance,
FIFO trade accounting, known-at equity/exposure curves, sampled drawdown and two-way
turnover. Predeclared fee/spread/slippage/latency/missing-candle scenarios retain full
source/assumption identity, skips and actual fills. Higher-fee identical executions
assert unchanged gross and non-improving net PnL. Unsupported fields and future reads
fail before immutable JSON/Markdown report publication.

| Path                                                                                      | Result                                                                                                                 |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/backtest.ts`                                                      | Versioned assumptions/manifest, scenario, curve/trade/metrics, outcome/report and bundle contracts                     |
| `packages/backtest/src/backtest.ts`, `backtest-controls.ts`                               | Causal coordinator, bounded authorizations, registered neutral/hold/losing/leaking controls and sensitivity checks     |
| `packages/backtest/src/backtest-metrics.ts`                                               | FIFO fees, exact PnL/returns/turnover, causal fresh marks, explicit unknowns and coverage                              |
| `packages/backtest/src/backtest-artifact.ts`, `backtest-report.ts`, `backtest-fixture.ts` | Atomic JSON/Markdown bundles, semantic verification, scientific limits and synthetic adverse fixture                   |
| `apps/cli/src/backtest.ts`                                                                | `pnpm backtest fixture/run --manifest/reproduce/verify/report`                                                         |
| `tests/backtest.test.ts`                                                                  | Negative performance, fee invariance, point-in-time marks, unavailable inputs, leakage and artifact/CLI failure checks |
| `docs/backtest-controls.md`, ADR 0021                                                     | Timing/accounting/benchmark assumptions, public interfaces and Module 09 handoff                                       |

Actual checks on 2026-11-01:

- `pnpm check`: **620 offline tests pass in 22 files**, including **37 new backtest
  acceptance/failure tests**, plus lint/format, typecheck, fixture smoke and contract demo.
  After final custom-strategy portfolio binding, the 37-test backtest suite, typecheck
  and targeted lint pass again. Existing two-worker concurrency/test deadlines are retained.
- `pnpm run doctor` passes with pinned Node 24.22.2, fixture readiness, execution disabled
  and zero operational orders. pnpm remains 10.34.9. Frozen offline install passes;
  no new dependency, lockfile version or SQL migration is introduced.
- Actual isolated PostgreSQL 18.4 regression: **28 tests pass**; project cluster stopped
  afterward and the installed Windows service was untouched. All **17 original roadmap
  files** retain recorded SHA-256 and byte lengths.
- Actual CLI fixture, `run --manifest`, reproduce, verify and report pass. Independent
  build/reproduce roots contain **identical bytes for JSON, Markdown, manifest and bundle
  metadata**. Prior Iteration 1 replay and Iteration 2 spot artifacts still verify.
- Synthetic fixture runs **6 scenarios × 3 independent roles** (strategy/cash/buy-and-hold).
  Deliberate loser: gross PnL **−40**, fees **0.2**, net PnL **−40.2**, net return **−0.0402**;
  cash return **0**; quantity-matched buy-and-hold net return **−0.03012**. Results are
  retained accounting/research controls, not evidence of alpha.
- Higher-fee identical fills retain gross **−40**, double fees to **0.4** and reduce net
  to **−40.4**. Same-path gross/net invariance is asserted across all three roles. Spread/
  slippage/latency/gaps retain changed execution rather than falsely attributing effects
  to fees. One omitted candle creates an explicitly unknown held-equity point; sampled
  drawdown/exposure maxima remain null while later known terminal cash is preserved.
- Actual CLI leaking and unavailable-depth manifests fail with no report directory.
  Tests cover end-exclusive price/news availability, nanosecond freshness, late marks,
  delisted/renamed holdings, FIFO partial fees, unsupported fields, repeatability,
  work bounds, falsified Markdown even with recomputed checksums, and immutable reuse.

Local ignored handoff artifacts:

- `data/backtests/backtest_937551bf1717578855fe45c913b75f9077ebc66095d5c3e57c2c68a012b59ecd/`
  contains `report.json` (1,845,778 bytes), `report.md` (13,305 bytes), `manifest.json`
  (60,576 bytes) and `bundle.json` (573 bytes). Adjacent `handoff-summary.json`,
  `future-leak-manifest.json` and `unavailable-field-manifest.json` record actual review
  evidence and negative reproduction inputs. `data/backtests-built/` and
  `data/backtests-reproduced/` contain byte-identical bundles.
- Manifest hash `sha256:fdb5ecfef8eb65bd78af9d692546710ce2e2b6e54f8b846fc90ddc3e5aa037d9`;
  input hash `sha256:e30f4ecafc228357bddf36e8beb4f9b6a093983c7be485c98f65745cb4959217`.
- Software version:
  `working-tree:sha256:567b1d045c01e0bce336de95d491d76b5b4904b96fff7d65cda357ebbb857d6e`.

Iteration 3 completes Module 08. Strategy, ReplayContext, ExecutionSimulator and
BacktestReport interfaces are published for 09–13. This coordinator supports an explicit
single spot series and fixed sizing, not the later four-engine strategy comparison.
No general risk engine, ML, significance/annualization, portfolio optimization,
derivatives or live execution is claimed. Assumption timestamps are operator assertions;
conservative OHLCV fills and sampled risk do not establish historical executable quotes.
Next implement exactly Module 09, Iteration 1 after reading its prompt and the master.

## Module 08, Iteration 2 deliverables

Added cash/spot virtual MARKET/LIMIT orders with explicit candidate/risk authorization,
price bounds, reserved cash/assets, exact fees, spread/slippage, shared volume caps,
partial fills, cancellation/activation latency, expiry and historical precision gates.
Adverse OHLCV fills require pre-open activity and source availability; late/revised bars
never add liquidity. Inventory-backed protective exits choose the adverse stop when a
candle hits both levels. An append-only per-asset/per-portfolio balanced journal retains
every reservation, trade, fee, release and reconciliation snapshot.

| Path                                                                          | Result                                                                                             |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/spot-simulation.ts`                                   | Versioned intents, commands, policies, balances, postings, journal, fill trace and artifact        |
| `packages/backtest/src/spot-simulator.ts`, `spot-evidence.ts`, `spot-math.ts` | Finite simulation, timed metadata/price gates, protective lots, reservations and exact costs       |
| `packages/backtest/src/spot-ledger.ts`                                        | Balanced append-only transactions, nonnegative wallet checks and independent journal replay        |
| `packages/backtest/src/spot-fixture.ts`, `spot-artifact.ts`                   | Synthetic manual-risk scenario, immutable publication, semantic verification and accounting report |
| `apps/cli/src/spot-simulation.ts`                                             | `pnpm replay spot-fixture/spot-run/spot-reproduce/spot-verify/spot-report`                         |
| `tests/spot-simulation.test.ts`                                               | Round-trip, partial/dust fees, ambiguity, latency, provenance, ledger and failure/property checks  |
| `vitest.config.ts`                                                            | Two-worker bound for native-reader/CLI contention; existing test deadlines retained                |
| `docs/spot-execution.md`, ADR 0020                                            | Full price/timing/accounting policies, limitations and next-iteration handoff                      |

Actual checks on 2026-11-01:

- `pnpm check`: **583 offline tests pass in 21 files**, including **49 new spot
  acceptance/failure tests**, plus lint/format, typecheck, fixture smoke and contract demo.
  Initial highly parallel runs timed out existing CLI/hook checks; bounding the runner
  to two workers resolves contention without weakening assertions or test deadlines.
- `pnpm run doctor` passes with pinned Node 24.22.2, fixture operational readiness,
  live execution disabled and zero operational orders. pnpm remains 10.34.9;
  `pnpm install --offline --frozen-lockfile` passes. No new third-party version or SQL
  migration; backtest now declares the existing pinned Decimal 10.6.0 dependency.
- Actual isolated PostgreSQL 18.4 suite: **28 tests pass**. Project cluster stopped
  afterward; the installed Windows service was untouched. All **17 original roadmap
  files** retain recorded hashes and byte lengths.
- Actual CLI spot fixture/verify/report, verified artifact reproduction and exported-input
  `spot-run` pass. Reproduce/build outputs are **byte-identical** to the original artifact.
  The previous Iteration 1 replay artifact also still passes actual semantic CLI verification.
- Synthetic round trip: **2 virtual orders, 2 fills, 10 balanced journal transactions**.
  Buy 1 at 100 with 0.10 fee; sell 1 at 110 with 0.11 fee. Independent total fees **0.21**;
  ending cash **1009.79**, BTC **0**, reserved balances **0**. This is an accounting
  fixture with manual synthetic risk permits, not a measured strategy result.
- Separate actual CLI protective scenario: one acquired lot, both stop 95 and target
  105 touched by candle low/high 90/110. Stop wins at modeled price **90**, fee **0.09**;
  ending cash **989.81**, BTC/reservations **0**. Explicit ambiguity flag retained and
  every step reconciles. Duplicate/late fills, cancellation latency, fee dust, fixed
  risk stop/target requirements, metadata changes and property cases are covered.

Local ignored handoff artifacts:

- `data/spot-simulations/spot-simulation_f89d2636e9e5b1d4f023957df80e653c68f21d1eaa3ee408f42b412394d4a6e2.json`
  (80,880 bytes), with adjacent `spot-input.json`, `spot-request.json`, `journal.json`,
  `fills.json`, `trace.json`, `synthetic-report.md`, `handoff-summary.json` and protective
  input/report files. `data/spot-simulations-reproduced/` and `data/spot-simulations-built/`
  retain byte-identical copies.
- Input hash `sha256:387d1853354b5b8704dad030775c3c26fb7e529ee7da99e2ee040b377ed93df1`;
  config hash `sha256:14a3e7d0ddcff2070b1bc5e5dd106ec3e6102292cc5fb599454b267452e47c0f`;
  journal hash `sha256:f1fe07d80e3b04b6c78f9bc3841a9a492f5a789b60c0d06bc7baa641c0130933`.
- Protective artifact:
  `data/spot-simulations-protection/spot-simulation_72617d2e9fb4b912745f1c4bf562998debd3dd50360dcfc8d8ff2a255a9c62d2.json`.
- Software version:
  `working-tree:sha256:a53c63b8019941548bc25034f37d6e9190d987a8ba8ac5437d8a000de06c70d2`.

Iteration 2 stops at virtual fill/accounting evidence. Unknown depth/queues and intrabar
paths remain disclosed assumptions. External producers/risk algorithms are not fabricated;
fixture permits are synthetic. No live execution, leverage, short borrowing, derivatives,
funding/margin/liquidation, performance/equity reports or benchmark comparisons exist.
Next implement exactly Module 08, Iteration 3 after reading the master and active module.

## Module 08, Iteration 1 deliverables

Added a deterministic availability-ordered replay kernel with stable timestamp ties,
explicit warm-up, immutable delivered-prefix bar/news/technical-feature queries,
callback-scoped clock/random capabilities and a validated Strategy/intent interface.
Late corrections never rewrite prior callbacks. Future/invalid accesses remain fatal
even if caught inside the strategy. The no-trade control records HOLD market-event
candidates with kernel-bound clocks, dataCutoff, evidence and reproducibility.

| Path                                                                           | Result                                                                                               |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/replay.ts`                                             | Versioned input/request, strategy/state/intent, query, log/snapshot/manifest and artifact contracts  |
| `packages/backtest/src/scheduler.ts`, `context.ts`, `kernel.ts`, `strategy.ts` | Monotonic seeded replay, prefix gates, historical queries, explicit state and no-trade control       |
| `packages/backtest/src/artifact.ts`, `fixture.ts`                              | Semantic repeatability checks, atomic immutable publication, reports and labelled synthetic evidence |
| `apps/cli/src/replay.ts`                                                       | `pnpm replay fixture/run/reproduce/verify/report` with strict bounded local inputs                   |
| `tests/replay.test.ts`                                                         | Timing/leakage/revision, deterministic state/randomness, budget, artifact and CLI failure checks     |
| `docs/replay-kernel.md`, ADR 0019                                              | Full timing/strategy/artifact contract and next-iteration handoff                                    |

Actual checks on 2026-11-01:

- `pnpm check`: **534 offline tests pass in 20 files**, including **36 new replay
  acceptance/failure tests**, plus lint/format, typecheck, fixture smoke and contract demo.
- `pnpm run doctor` passes with pinned Node 24.22.2, execution disabled and zero orders;
  pnpm remains 10.34.9. `pnpm install --offline --frozen-lockfile` passes.
- Actual isolated PostgreSQL 18.4 regression: **28 tests pass**. The project cluster
  was stopped afterward; the installed Windows service was untouched. No SQL migration
  or third-party dependency version changed; workspace wiring activates `@crypto/backtest`.
- Actual CLI fixture/verify/report, verified artifact reproduction and full exported-input
  `run` pass. Separate output roots contain **byte-identical artifacts**, including all
  candidates, final state, event order, logs, manifests and snapshots.
- Synthetic run has **6 ordered events (1 warm-up, 5 decision callbacks), 3 HOLD
  candidates, 4 snapshots and 2 explicit exclusions**. Timestamp ties deliver market
  events before news; a callback cannot see the undelivered news at the same timestamp.
- Tests reject future timestamps/IDs, including caught access errors; nanosecond window
  boundaries, delayed news, old/new historical price queries, immutable state/context,
  seeded draws, provenance/rationale gates and known bad corrections are verified.
  Publication also rejects non-repeatable strategy state before writing any artifact.
- All **17 original roadmap files** retain recorded SHA-256 and byte lengths.

Local ignored handoff artifacts:

- `data/replays/replay_249ecbfb7bf4b069f95292a0690c83478ba950689ad6e9cc283f6e2af01153d4.json`
  (18,794 bytes), with adjacent `manifest.json`, `candidates.json`, `snapshots.json`,
  `synthetic-report.md`, `replay-input.json` and `replay-request.json`. Separate
  `data/replays-reproduced/` and `data/replays-built/` contain identical copies.
- Input hash `sha256:54397ce13b336dd7fc8d3b1d9c9ff53ee256b45ca7bf844756db6c4f2b99c853`;
  config hash `sha256:8ae21696a81035c2212d58781e623323f8e027e2f7d796e1fced3021faecf803`;
  event-order hash `sha256:75850365448eeb7116ebb9dea60f15799c753a2ae36f0d112cba5f1cbefae02d`.
- Candidate hash `sha256:78772709c58e171c2a5e0246c6d13ea5b1e410082a7855ee9d391fb9ea0f96fb`;
  final-state hash `sha256:1eecdbb3d3016b2f58690a83d1682e35026cb7db8f01fef74cbbca2e094e9d14`;
  log hash `sha256:1f9b2b7e1eba9168d2e41633b432c4d454afa77cd8ed7473e1fadc1d52f77188`.
- Software version:
  `working-tree:sha256:16851604a580d167ca267e33cbfd5f85d01871a58c4e5dfd79fd15fc6cd7f474`.

Iteration 1 stops at a no-trade research replay. Snapshots are audit checkpoints,
not a resume implementation; custom callbacks are trusted local code and must use
provided clock/random/state. Raw documents do not establish semantic truth or affected
symbols. No execution, cost model, account, ledger, fills or PnL exists. Next implement
exactly Module 08, Iteration 2 after reading the master and active module.

## Module 07, Iteration 3 deliverables

Added reproducible chronological train/validation/test panels from verified feature
artifacts, historical symbol/group evidence, separate fixed-window forward labels,
global boundary-touch purge and post-boundary embargo. Missingness, conflicting
definitions/duplicates, deliberately leaking proposals and cohort/survivorship coverage
are retained in an immutable audit. Proposals never become predictor columns.
Every included feature watermark is bounded by featureAsOf; label timing is separate.

| Path                                                                                                | Result                                                                                                 |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `packages/contracts/src/dataset-panel.ts`                                                           | Strict versioned group/input/request/feature/label/row/audit/manifest contracts                        |
| `packages/research/src/dataset-panel.ts`, `panel-sources.ts`, `panel-evidence.ts`, `panel-audit.ts` | Verified source assembly, historical evidence, timed labels, global splits and leakage/selection audit |
| `packages/research/src/panel-storage.ts`, `panel-client.ts`                                         | Stable Parquet, atomic immutable exports, byte/semantic verification and explicit supervised reader    |
| `packages/research/src/panel-fixture.ts`, `panel-report.ts`                                         | Synthetic cohort/leaking proposal, feature catalog, coverage and training-sample handoff               |
| `apps/cli/src/dataset-panel.ts`                                                                     | Dataset fixture/build/replay/verify/report/view commands under `pnpm features`                         |
| `tests/dataset-panel.test.ts`                                                                       | Acceptance and failure tests for temporal contamination, provenance and export poisoning               |
| `docs/dataset-panels.md`, ADR 0018                                                                  | Clock/split/export contracts, limits and next-module handoff                                           |

Actual checks on 2026-11-01:

- `pnpm check`: **498 offline tests pass in 19 files**, including **32 new panel
  acceptance/failure tests**, plus lint/format, typecheck, fixture smoke and contract demo.
- `pnpm run doctor` passes with pinned Node 24.22.2, execution disabled and zero orders;
  pnpm remains 10.34.9. `pnpm install --offline --frozen-lockfile` passes.
- Actual isolated PostgreSQL 18.4 regression: **28 tests pass**; project cluster stopped
  afterward, installed Windows service untouched. No SQL migrations changed.
- Actual CLI dataset fixture/build/replay/verify/report and both feature/supervised views
  pass. Full exported input/request build and verified-source replay reproduce the
  **identical manifest and Parquet hash** in separate output roots.
- Synthetic cohort: **45 candidates, 7 included (2 TRAIN / 2 VALIDATION / 3 TEST),
  20 purged, 5 embargoed, 11 quarantined, 2 outside splits**. Five feature columns,
  two separately requested label horizons. All predictor watermarks are at/before as-of.
- Intentional future-label proposal triggers LABEL_DEPENDENCY, UNREGISTERED_SOURCE,
  FUTURE_INPUT and WATERMARK_UNDERSTATED; never enters predictor columns. A test that
  poisons a flat Parquet column and recomputes file/manifest hashes still fails semantic
  verification. Late entry/target corrections, historical listing/groups, cross-symbol
  contamination and nanosecond embargo boundaries are covered.
- The root test workspace references the already-pinned DuckDB 1.4.4-r.1 package for
  the poisoned-export fixture; no new runtime package/version. All **17 original roadmap
  files** retain their recorded SHA-256 and byte lengths.

Local ignored handoff artifacts:

- `data/dataset-panels/dataset-panel_607a119422bdfe1c3b50135bd0256a4917864813e9363955f95af50efcd87477/`
  contains `manifest.json`, `artifact.json` (1,300,656 bytes) and `panel.parquet`
  (39,670 bytes). Adjacent `catalog.json`, `synthetic-report.md`, `train-features.json`,
  `test-supervised.json`, `replay-input.json` and `replay-request.json` provide the review
  catalog, source coverage, sample manifest, explicit client views and reproduction inputs.
- Artifact hash `sha256:d3c7a0ef862492483122eefedb0b660c4a24a408058dcdbe35ada1db30cc2677`;
  input hash `sha256:10f0c85f1f4573133860dd6126496b6db3968459979451ec56b6f2d238a866db`;
  config hash `sha256:a818d9c6c5d5c6ad014afbd5cef1eacb278ffd91d8d953286fb0fe3d35f956c2`.
- Parquet hash `sha256:10df9314d7c47073966d1982cf3d7ff7fe2c5a6645609a4ed6205472ce958853`;
  included-row hash `sha256:b0b8fe493aeb02a5377b97e09121369f2f01604acd249fe1d448815bfdaffb9f`.
- Software version:
  `working-tree:sha256:635e98aea12ed17612715b4b6f566b7aa58ea85ecece7ba0deb45ff1699af39e`.
  Separate `data/dataset-panels-replay/` and `data/dataset-panels-build/` reproduce it.

Iteration 3 completes Module 07's handoff to 09/11. The cohort remains an explicit
synthetic subset, not a complete historical market. Complete-case labels can retain
selection bias; raw returns exclude costs/fills. Input knowability is not measured
feature publication time. No ML, Python worker, strategy, broker or execution is added.
Next implement exactly Module 08, Iteration 1, after reading its prompt and the master.

## Module 07, Iteration 2 deliverables

Added BTC-relative returns, rolling/lagged Pearson correlations with pair timestamps,
point-in-time breadth and exchange-turnover concentration, independent trend/direction/
high-volatility flags, and optional funding/open-interest observations. Historical
listing/mapping/precision gates apply to each source bar; tolerance permits only backward
joins and consecutive actual closes. Missing references or liquidity produce null/partial
results rather than current-survivor replacements. Separate immutable artifacts preserve
the original technical-feature schemas and exact previous artifact identity.

| Path                                              | Result                                                                                                                                                                         |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/contracts/src/cross-features.ts`        | Strict versioned source/binding, request, derivative clocks, joins/pairs, regimes, universe audits and artifact contracts                                                      |
| `packages/research/src/cross-features.ts`         | Shared-cutoff joins, historical metadata gates, BTC differences, lagged correlations, deterministic regimes, breadth/concentration and derivative selection                    |
| `packages/research/src/cross-feature-fixture.ts`  | Synthetic late BTC candle, delayed listing metadata, trend/sideways jump, book metrics and individually timed perpetual fields                                                 |
| `packages/research/src/cross-feature-artifact.ts` | Seven-definition catalog, atomic no-replace artifacts, semantic replay verification and Markdown reports                                                                       |
| `apps/cli/src/cross-features.ts`                  | `pnpm features cross-fixture/cross-build/cross-run/cross-catalog/cross-verify/cross-report`                                                                                    |
| `tests/cross-features.test.ts`                    | 32 new offline acceptance/failure checks, including backward tolerance, listing history, both lag directions, partial breadth, optional-field clocks and old artifact identity |
| `docs/cross-asset-features.md`, ADR 0017          | Complete join/missingness/universe/derivative policies and next-iteration handoff                                                                                              |

Actual checks on 2026-11-01:

- `pnpm check`: **466 offline tests pass in 18 files**, plus lint/format, typecheck,
  fixture smoke and contract demonstration. `pnpm run doctor` passes with pinned
  Node 24.22.2, execution disabled and zero orders; pnpm remains 10.34.9.
- `pnpm install --offline --frozen-lockfile` passes. No new dependencies or SQL schemas.
  Actual isolated PostgreSQL 18.4 integration suite: **28 tests pass**; project fixture
  stopped afterward and the installed Windows service was untouched.
- Actual CLI fixture/catalog/verify/report, artifact `cross-run` and full exported-input
  `cross-build` pass. Both replay routes reproduce the **same artifact hash** without
  replacement. The synthetic artifact contains **five rows** and **seven catalog entries**.
- At 00:05, ETH gross return is 0.08 while the BTC candle is still unavailable, so BTC
  return and ETH-relative return remain null. At 00:05:30 BTC is actually known, its
  return is zero and ETH-relative return is 0.08. The earlier row never borrows the
  later-known observation. A one-nanosecond availability check also passes.
- NEW's stored prices do not supply features or universe membership before listing
  metadata is known. At 00:07:30 it is known but lacks the entire required post-listing
  path; breadth is **2/3 measured**. At 00:08:30 sufficient history exists and breadth
  is **3/3 measured**. Selection changes by historical quote turnover, not static assets.
- Monotonic ETH is TRENDING/UP; SOL's jump/reversal is RANGING with high-volatility true.
  Funding/open interest remain individually gated; unknown fields are null and spot is
  NOT_APPLICABLE. Source/ranking/pair/derivative IDs and input watermarks are retained.
- Original iteration-one feature artifact hash remains
  `sha256:02ebd90d452927d9230a6e4b55b73aa6d3ee8307841d03d67989f6cf9663a6a9`.
  All **17 original roadmap files** retain recorded hashes and byte lengths.

Local ignored handoff artifacts:

- `data/cross-features/cross-features_e5ff8a012b6cd46276271f6a7d9e52aa9b4e546ba6f4b428926d97ff97348640.json`
  (347,164 bytes), with `data/cross-features/catalog.json`, derived
  `data/cross-features/synthetic-report.md` and exported `replay-input.json` /
  `replay-request.json` in the same directory.
- Input hash `sha256:2119465d31f2176af3eff63aafc7948302e8936c85cef3420650ee11049ad265`;
  request hash `sha256:c588d5db1d2eecefbc1c7f52c42c896b32a4e7345312395d38f69cd072f783a0`.
- Software version:
  `working-tree:sha256:dd2ed7b64618822cc505a1ac8e837da64d91e4732c3d8b4e6df4b266e4e81003`.

Iteration 2 stops here. Correlation/lead-lag and threshold regimes are descriptive,
not causal forecasts. Concentration is selected exchange turnover, not market-cap or
portfolio risk. Missing book metrics never become candle-volume liquidity, and current
listings never substitute for unknown historical metadata. Input knowability bounds do
not establish actual feature publication time. Dataset splits, purge/embargo, leakage
audits, training sample manifests and stable panel exports remain Iteration 3.

## Module 07, Iteration 1 deliverables

Added deterministic SMA/EMA, configurable horizon returns, population log-return
volatility, Wilder ATR, prior-reference relative volume/z-score and breakout bands,
opening-price gaps, missing candle coverage and liquidity quality flags. The feature
timestamp selects only completed bars actually available then, including the latest
eligible revision known by that cutoff. Gaps reset recursive seeds; warm-up, absent
current data, zero denominators and zero variance stay explicitly missing. Each value
and row retains input IDs and maximum input close/availability watermarks. No unfinished
candle, forward-fill, strategy, regime or training panel is introduced.

| Path                                           | Result                                                                                                                                                                        |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/technical-features.ts` | Strict versioned config/query/batch, source input, value/row audits, catalog and immutable artifact contracts                                                                 |
| `packages/research/src/technical-features.ts`  | Decimal-safe as-of revision selection, indicator formulas, gap/reset policies, quality flags and exact input provenance                                                       |
| `packages/research/src/feature-catalog.ts`     | Versioned formulas, inputs, warm-up counts, history policy, variable availability lag and null/NaN policy                                                                     |
| `packages/research/src/feature-artifact.ts`    | Synced atomic no-replace outputs, semantic replay verification and Markdown reporting                                                                                         |
| `packages/research/src/feature-fixture.ts`     | Synthetic trend/reversal, delayed candle, zero volume and late historical correction                                                                                          |
| `apps/cli/src/features.ts`                     | `pnpm features` fixture/catalog, verified market snapshot or artifact input, request replay, verify/report commands                                                           |
| `tests/technical-features.test.ts`             | 30 new offline checks covering hand calculations, log identities, unavailable/unfinished data, gaps, revisions, watermarks, zero cases, future-price invariance and tampering |
| `docs/technical-features.md`, ADR 0016         | Full formula/timing conventions, source limitations, public CLI/contracts and next-iteration handoff                                                                          |

Actual checks on 2026-11-01:

- `pnpm check`: **434 offline tests pass in 17 files**, plus lint/format, typecheck,
  fixture smoke and contract demonstration. `pnpm run doctor` passes with pinned
  Node 24.22.2, execution disabled and zero orders; pnpm remains 10.34.9.
- `pnpm install --offline --frozen-lockfile` passes; no new dependencies or SQL schemas.
  Actual isolated PostgreSQL 18.4 integration suite: **28 tests pass**, project fixture
  stopped afterward, installed Windows service untouched.
- `features fixture`, `catalog`, `verify`, `report` and artifact/request `run` replay
  pass. The exported request recreates the **same artifact hash** without replacement.
  Fixture has **eight rows**, **twelve catalog definitions** and **55 ready values**.
- Synthetic period-three fourth-close values: SMA 12, EMA 12, ATR 3, relative volume 2,
  z-score sqrt(6), prior breakout upper/lower 13/9. The 00:04 close arrives at 00:04:30:
  current-price features are missing at 00:04 and ready at 00:04:30. Every joined input
  has close/availability at or before its feature timestamp. Later corrections do not
  alter earlier feature values/input IDs.
- Existing verified local public-archive Parquet CLI input succeeds with **zero ready
  values**, retaining unavailable/descriptive history instead of inventing real-time
  availability. Its source manifests, license and capture provenance are preserved.
- Original news/study/control/hypothesis checks continue to pass. All **17 original
  roadmap files** retain recorded hashes and byte lengths.

Local ignored handoff artifacts:

- `data/technical-features/technical-features_02ebd90d452927d9230a6e4b55b73aa6d3ee8307841d03d67989f6cf9663a6a9.json`
  (57,675 bytes), with `data/technical-features/catalog.json`, derived
  `data/technical-features/synthetic-report.md` and exported `replay-request.json`.
- Input hash `sha256:c40cc9ad7ca2334a7d382aaa20e31ed80e73668f492bc0a8ce121c1f7d0bd106`;
  request hash `sha256:dfe8771897ff3cf9ff5c93b85a11edc30257fe7fd6ec147413dbe36bf1d5854e`.
- Software version:
  `working-tree:sha256:0a0456500eab98d7d4456b1a64325a61ce4543a98638ae810c9920455060f600`.
- Local archive compatibility report:
  `data/technical-features/local-archive/technical-features_6a9303693ac9da3c2f972ac4570efab4a39a221c2b56d715690d067ef25403cf.json`.

Iteration 1 stops here. Availability watermarks bound input knowledge, not actual
historical feature computation/publication time. Liquidity remains a base-volume proxy:
order-book depth, spread and executable size are unavailable. Source-coverage/excluded
version diagnostics are audit metadata, not additional training columns. History start
is explicit and affects recursive seeds. Cross-asset joins, universe selection and
regimes belong to Iteration 2; train/validation/test panels, purge/embargo, leakage audit
and stable panel/Parquet manifests belong to Iteration 3.

## Module 06, Iteration 3 deliverables and module handoff

Added immutable hypothesis-card revisions with complete thesis/taxonomy/direction/horizon,
source, assumptions, first-seen eligibility, periods, biases, tests and author state.
Evaluation enforces disclosed selection/validation reuse and late freezes, derives sample
counts/conditional uncertainty, retains contradictory examples and computes final statuses.
Unknown-availability archives are a separate descriptive-only type. A verified News Strategy
handoff carries only card versions and news context known at each event decision, with
default HOLD and no outcome, confidence-interval or final-finding features.

| Path                                                                       | Result                                                                                                                                              |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/hypotheses.ts`                                     | Strict versioned cards/revisions, evidence, sample/uncertainty, registry and temporally constrained handoff schemas                                 |
| `packages/research/src/hypothesis-cards.ts`                                | Per-ID revision chains, expected-head writes, author/reason/recording times and integrity checks                                                    |
| `packages/research/src/hypothesis-registry.ts`, `hypothesis-statistics.ts` | Frozen news context, exact-close outcomes, reuse checks, lineage/window units, seeded multiplicity-aware percentile intervals and computed findings |
| `packages/research/src/hypothesis-artifact.ts`, `hypothesis-report.ts`     | Synced atomic no-replace registry files, semantic replay verification and notebook-style Markdown reports                                           |
| `packages/research/src/hypothesis-handoff.ts`                              | Strategy research/backtest input selectors, archive quarantine, historical card-version matching and semantic handoff verification                  |
| `packages/research/src/hypothesis-fixture.ts`                              | Fifteen synthetic ingested/extracted events across exchange outages, rate announcements and listings, plus three unknown-availability archives      |
| `apps/cli/src/hypotheses.ts`                                               | Fixture, build/replay, verify, report, clock-assigned revision and inputs commands                                                                  |
| `tests/hypotheses.test.ts`                                                 | 25 new offline acceptance/failure checks for reuse, uncertainty, negative findings, quarantine, late data, revisions, tampering and feature leakage |
| `docs/hypothesis-registry.md`, ADR 0015                                    | Complete module handoff, inference limits, input/CLI contracts and next-iteration boundary                                                          |

Actual checks on 2026-11-01:

- `pnpm check`: **404 offline tests pass in 16 files**, plus lint/format, typecheck,
  fixture smoke and contract demonstration. `pnpm run doctor` passes with pinned
  Node 24.22.2, execution disabled and zero orders; pnpm remains 10.34.9.
- `pnpm install --offline --frozen-lockfile` passes. No new dependencies or SQL schemas.
  Actual isolated PostgreSQL 18.4 integration suite: **28 tests pass**; project fixture
  stopped afterward and the installed Windows service was untouched.
- `hypothesis-fixture`, `hypothesis-verify`, `hypothesis-report` and exported
  `hypothesis-build` replay pass. Replaying full input/request returns the **same hash**
  without replacing the existing file. Old study/control artifact checks still pass.
- Each synthetic group has two complete selection records (insufficient units for an
  interval), three complete validation units and one quarantined archive. With 1,000
  resamples, root seed 42 and six displayed card phases, nominal per-interval level is
  0.991666666666666666666666666666666667. Conditional intervals are exchange outages
  [-0.04, -0.01], rate announcements [0, 0], and listings [-0.03, 0.02].
- Final statuses are **SYNTHETIC_ONLY**, **NEGATIVE_FINDING**, and **INCONCLUSIVE**.
  The expected positive rate-announcement move is absent. Flat fixture intervals do
  not imply zero population uncertainty; the report states the conditional/small-sample
  limitations, selection biases and contradictory examples explicitly.
- Actual CLI revision creates revision 2, preserves its predecessor hash and records
  current server time. Its disclosed retrospective freeze is **EXPLORATORY_REUSE**.
- Actual CLI handoff at 2026-01-25: **nine known event/card rows**, **three quarantined
  archives**, default **HOLD**, no return/outcome fields. `validateHypothesisHandoff`
  passes for the generated JSON. Selection events predating card registration are absent.
- All **17 original roadmap files** retain recorded hashes and byte lengths.

Local ignored handoff artifacts:

- `data/hypothesis-registry/hypothesis-registry_a09916d6fff224964bdf556285df0623ff12c0710cebc0633e0798a84f6c04c4.json`
  (351,035 bytes), with derived `data/hypothesis-registry/synthetic-report.md` and
  exported `replay-input.json` / `replay-request.json` in the same directory.
- Registry input hash:
  `sha256:f1cc0dd0892b5196e8663b14d8c3cd5a1d398f2a62e49a6a4bf4c6db892e3973`;
  request hash `sha256:65478b41615d9b02f9af6ebc4708ee869c196f777b8f52f3e3b6b18f8c70076c`.
- Software version:
  `working-tree:sha256:992c0411653cba99ef5bf01a59cfa67830fcc39b049cc112e48869459084c8ed`.
- `data/hypothesis-registry/news-strategy-inputs.json`, canonical handoff hash
  `sha256:a0b441788016ef6c3e777d99d1c4a00d2ffb078b417f2ae95d40b09c3c07e429`.
- CLI revision artifact:
  `data/hypothesis-registry/revisions/hypothesis-registry_54118e5df341490ae86bd8fc5f7d2e18345f748678d9c460e6450fb61832b138.json`.

**Module 06 stops here.** Conditional resampling, nominal multiplicity correction and
separate recorded periods do not prove independence, causal identification, authentic
historical pre-registration or real-market performance. Causal designs require supplied
justification and still remain unendorsed/blocked from strategy handoff. Unknown first
availability is never promoted to tradable data. Next is Module 07, Iteration 1; News
Strategy implementation, backtest execution and any trading rules remain future work.

## Module 06, Iteration 2 deliverables

Added a separate versioned controls analysis over immutable event-study evidence:
pre-decision BTC OLS beta/market-model adjustment, opening-weight basket-relative
returns, signed pre/post-event lag correlations, reproducible random baselines with
optional pre-volatility/UTC-time matching, close-based recovery with right-censoring,
frozen taxonomy drill-down and lineage-aware movement concentration. Event and control
paths share the original strict price gate. These are descriptive associations, not
causal findings, significance tests, tradable hypotheses or execution instructions.

| Path                                                                           | Result                                                                                                                         |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `packages/contracts/src/event-controls.ts`                                     | Strict price-path, controls request/result, fit/lag/recovery and immutable artifact contracts                                  |
| `packages/research/src/event-study.ts`                                         | Shared exact-close price gate; original version-one result/filename identity preserved                                         |
| `packages/research/src/event-controls.ts`, `event-control-math.ts`             | Complete joint cohorts, BTC model/basket residuals, directed lag pairs, seeded candidates, censored recovery and concentration |
| `packages/research/src/event-controls-artifact.ts`, `event-controls-report.ts` | Synced atomic no-replace artifacts, semantic replay verification and descriptive Markdown output                               |
| `packages/research/src/event-controls-fixture.ts`                              | Fully synthetic exact-beta-two fixture with recovered and right-censored assets                                                |
| `apps/cli/src/event-controls.ts`, `apps/api/src/event-study.ts`                | Fixture/verified-evidence controls, verify/report commands and explicitly started loopback controls API                        |
| `tests/event-controls.test.ts`                                                 | 31 new offline acceptance/failure checks, including original artifact identity and event-order-independent sampling            |
| `docs/event-controls.md`, ADR 0014                                             | Formulas, sampling and observation scope, temporal boundaries, censoring and next-iteration handoff                            |

Actual checks on 2026-11-01:

- `pnpm check`: **379 offline tests pass in 15 files**, including lint/format,
  typecheck, fixture smoke and contract demonstration. `pnpm run doctor` passes with
  Node 24.22.2, execution disabled and zero orders; pnpm remains 10.34.9.
- `pnpm install --offline --frozen-lockfile` passes. No dependencies or database schemas
  changed. Actual isolated PostgreSQL 18.4 suite: **28 tests pass**; project fixture
  stopped afterward, installed Windows service untouched.
- `controls-fixture`, `controls-verify`, `controls-report` and `controls` replay pass;
  replaying the exported request returns the **same artifact hash** without replacement.
  Four controls are sampled from eleven eligible timestamps; three other candidates
  are excluded for news/response overlap. Root seed 42 yields event seed 3180118457.
- Exact synthetic ETH beta is 2, alpha 0, fit count 6 ending one minute before decision.
  Five-minute gross is 0.1, beta adjusted 0.1, market-model residual
  0.10138989898989898989898989898989899, and basket-relative return 0.15.
  ETH recovers at +240 seconds; SOL is **RIGHT_CENSORED** at +300 seconds.
- Negative comparison finding: BTC gross is zero and **4/4** controls have moves at least
  as large. ETH/SOL have 0/4 exceedances; these tiny empirical samples are not p-values
  or evidence of causality. Missing/no-match baselines remain null in failure cases.
- Actual `controls-serve` child process bound to loopback: POST returns HTTP 200,
  `execution: DISABLED`, beta 2 and no-store headers; child stopped after verification.
- Original version-one study artifact hash remains
  `sha256:898b59cf6305f568afec200e2ad032e928d2806b105df00299af2eee7e7113d9`.
  The CLI also accepts that verified original artifact for a fresh controls analysis.
- All **17 original roadmap files** retain recorded hashes and byte lengths.

Local ignored handoff artifacts:

- `data/event-controls/event-controls_0a2c2d97e41e108550296e43c2d3fad8b36c7ae5937a3c57aa5355c73f53421e.json`
  (1,177,984 bytes), with derived `data/event-controls/synthetic-report.md` and exported
  `data/event-controls/replay-request.json`.
- Input hash `sha256:93775c07c94488023ec893fa0558063274cce1831211ba34ec162ce7c066a5a4`;
  request hash `sha256:73d317d77769e36d352a76728edd3bb9e6f4afe89d16772982a293a502a965c1`.
- Software version:
  `working-tree:sha256:566995b9d2efaefa4ace686efb70588ff8f1fd580fe412f12c7e6dc24db05331`.
- Original-study-input compatibility report:
  `data/event-controls/legacy-input/event-controls_22942f0500df283fb24f5b419d5d8834440dc0933bc0d2e69873ac1203e76093.json`.

Iteration 2 stops here. Candidate controls mean no observed news in the frozen corpus,
not proof that the world was event-free. Complete-case selection, small samples,
overlapping windows and retrospective taxonomy/asset selection limit interpretation.
Post-event lag correlations are not decision-time inputs. Optional recovery has proper
right-censoring, without a survival estimator or averaging away unrecovered cases.
Hypothesis registry/cards, period separation and statistical uncertainty belong to
Iteration 3; no event label creates a trading rule.

## Module 06, Iteration 1 deliverables

Added a reproducible event-study engine, CLI and separately started loopback API for
BTC/ETH/SOL and explicit configurable instruments. Ten pre/post-event windows retain
signed gross, assumed-cost net, absolute magnitude, simple benchmark subtraction,
OHLC excursions, log-return realized volatility and close-only drawdown. News features
are frozen at each event decision; each price must be available by its own simulated
close-time decision. Missing entries, endpoints, internal gaps, future outcomes and
unsupported intervals remain explicit with null metrics and evidence/coverage IDs.

| Path                                                         | Result                                                                                               |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/event-study.ts`                      | Strict versioned selections, input, metrics, results and replay artifact contracts                   |
| `packages/research/src/event-study.ts`                       | Decimal-safe exact-close engine, historical news replay and fail-closed price windows                |
| `packages/research/src/event-study-artifact.ts`              | Self-contained content-addressed exports, synced atomic publication and semantic replay verification |
| `packages/research/src/event-study-fixture.ts`               | Clearly synthetic three-asset price path, early unverified news and two flat-price negative findings |
| `apps/cli/src/event-study.ts`, `apps/api/src/event-study.ts` | Fixture/local snapshot run, verify, Markdown report and explicit frozen-input loopback API           |
| `tests/event-study.test.ts`                                  | 24 new offline acceptance/failure checks, including complete hourly history through seven days       |
| `docs/event-study.md`, ADR 0013                              | Clock, source, costs, metric definitions, missing-data policy, limits and iteration handoff          |

Actual checks on 2026-11-01:

- `pnpm check`: **348 offline tests pass**, lint/format, typecheck, fixture smoke and
  contract demonstration pass. `pnpm run doctor` reports Node 24.22.2, fixture readiness,
  execution disabled and zero orders. pnpm is pinned to 10.34.9.
- `pnpm install --offline --frozen-lockfile`: passes with installed pinned dependencies.
- Actual isolated PostgreSQL 18.4 integration suite: **28 tests pass**; project fixture
  stopped afterward. No database schema/projection changes were needed for file reports.
- `pnpm study fixture`, `verify` and `report`: pass. The fixture yields **15 complete
  asset/windows**; ETH +5m gross/absolute/adjusted is 0.2, assumed ten-bps net 0.199,
  adverse -0.15, favorable 0.25, close drawdown 2/11 and volatility approximately
  0.277684365334535. BTC/SOL gross remains zero; net is -0.001 under the explicit cost.
- Existing verified local public-archive Parquet + frozen synthetic news CLI run:
  succeeds with **zero complete windows**, preserving missing data instead of inventing
  prices/availability. Market manifests preserve source/license/checksum provenance.
- Actual `study serve` child process bound to loopback: HTTP POST returns 200,
  `execution: DISABLED` and `cache-control: no-store`; child stopped after the check.
- All **17 original roadmap files** retain recorded hashes and byte lengths.

Local ignored artifacts for this handoff:

- `data/event-studies/event-study_898b59cf6305f568afec200e2ad032e928d2806b105df00299af2eee7e7113d9.json`
  (2,775,920 bytes), with rendered `data/event-studies/synthetic-report.md`.
- Synthetic input hash:
  `sha256:15e91e957068c305e38f9faa1516fdcd234dece65525c7f761fe96e6800dee82`;
  request hash `sha256:3fe487e568682b99222f57cb08f74d1505e19b25ade1064fc662feab75cecb79`.
- Software version:
  `working-tree:sha256:13e0f95033181bc1fcc09f7a4e2bdc4cefcf8ea2132933126544c8f728bfa4fa`.
- Local archive compatibility report:
  `data/event-studies/local-replay/event-study_7736464bacc5afd7a5a37e72640a067552710be1f10e901afcb64256f9c679b1.json`.

Iteration 1 stops here. Entry requires an exact already-known close; later captured
archives cannot be promoted to historical availability. Explicit event/asset selection
must disclose selection bias. Optional recovery timing is deferred to Iteration 2 with
right-censoring; beta/factor/basket controls, lag tests, random baselines and concentration
also belong there. Hypothesis cards/registry and statistical validation are Iteration 3.
No event label generates a trading rule or execution.

## Module 05, Iteration 3 deliverables

Added immutable as-of event snapshots with independent rumor/corroboration/official/
correction milestones, explained qualitative confidence and broad origin-count uncertainty
bands, declared direct/second-order asset context, scoped novelty and pre-receipt expectation
comparison. A separate audited curator ledger records prospective split/merge lineage and
preserves original IDs. Offline DOT provenance and temporally gated downstream interfaces
complete the Module 05 handoff. No market impact/return calculation, calibrated probability,
event-study result, trading signal or execution was implemented.

| Path                                                                             | Result                                                                                                                           |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/news-events.ts`                                          | Strict versioned event context, identity/curation, confidence, snapshot and downstream input contracts                           |
| `packages/news/src/events.ts`, `event-journal.ts`                                | Source-head-bound curator decisions, server recording times, exact memberships, fsync/hash chain and replay validation           |
| `packages/news/src/event-projection.ts`                                          | Separate milestones, confidence/bands, exposure rules, novelty/expectations and fail-closed unassigned lineage                   |
| `packages/news/src/event-snapshot.ts`, `persist-events.ts`                       | Immutable content-addressed exports, semantic verification, DOT provenance, input selectors and idempotent PostgreSQL projection |
| `packages/news/src/event-fixtures.ts`, `tests/fixtures/news/temporal-cases.json` | Seven fictional reports, delayed receipt, corrections, predeclared context and split/remerge/later-evidence scenario             |
| `apps/cli/src/news-events.ts`                                                    | Explicit event view/snapshot/verify/provenance/input/decision/persistence commands                                               |
| `tests/news-events.test.ts`, `tests/db.integration.test.ts`                      | 24 new offline checks and one actual PostgreSQL snapshot/lineage test                                                            |
| `docs/news-events.md`, ADR 0012                                                  | Temporal semantics, limits, downstream contracts and complete module handoff                                                     |

Actual checks on 2026-11-01:

- `pnpm check`: pass, lint/format/typecheck, **324 offline tests**, smoke and contract demo.
- `pnpm test:integration`: **28 actual PostgreSQL 18.4 tests passed**. The isolated project
  cluster stopped afterward; the installed Windows service was untouched.
- `pnpm run doctor`: pass with pinned Node 24.22.2; frozen offline pnpm 10.34.9 installation
  passed. All **17 original roadmap checksums** verified unchanged.
- No dependencies, SQL migrations or old graph/article/claim schemas changed. Original news
  fixture registry/state hashes remain those recorded below. Existing source journals remain intact.
- Actual CLI snapshot at `2026-01-01T10:35:00Z` verified:
  `sha256:04c80b38d71bcb277446ece3d38513f5465e1c851da36b37621764ce3fda5213`.
  Input hash: `sha256:b23011bebb3c21eea165a2204df349c498e2b7538be154a2f46a94def43c3481`.
  It contains 7 source-graph records, 3 prior context records and one attributable official
  event. Input selection at 09:00 returns zero; non-abstaining input at 10:35 returns one.
  No signal or price response is inferred from this eligibility result.
- Synthetic milestones remain separate: rumor at **09:10:03**, independent corroboration
  at **10:00:03**, official statement at **10:10:03** UTC; the 10:30 withdrawal remains
  a distinct correction. The initial article's 08:30 publication never permits use at 09:00.
- Full scenario: 7 synthetic source reports, 9 graph records and 5 curator records. Split
  at 10:45 and remerge at 10:46 preserve original and child IDs. Later 11:00 evidence stays
  unassigned and withholds the affected branch from replay until explicit review.
- Exported and verified **nine staged snapshots** under `data/news-event-fixture-export/`,
  covering 09:00, 09:45, 10:05, 10:15, 10:25, 10:35, 10:45, 10:46 and 11:01 UTC.
  Index: `fixture-index_2cf300374870916afffcef86850dd80dfa7878ad5150d282c132f84045d6f915.json`;
  hash `sha256:2cf300374870916afffcef86850dd80dfa7878ad5150d282c132f84045d6f915`.
  These are synthetic causal/replay fixtures, not observed historical outcomes.
- Actual DOT export written to `data/news-event-provenance.dot`; it retains original/child
  event IDs, source/claim dependencies and lineage. No remote renderer was used.
- Separate `crypto_fixture_news_events` projection persisted five curator records plus
  the merged snapshot (6 additions); exact repeat added zero. The valid **12-entry** audit
  head remained `sha256:fb750f017f90d3b56db7cef3b47c38bd9b37f45b91f1fe9b77b3c75fe49dd388`.
  The project cluster stopped and prior namespaces were preserved.
- A separate synthetic CLI context decision retained operator `synthetic:acceptance-reviewer`,
  reason and actual service time `2026-11-01T07:31:04.462000000Z`. Its new mapping is known
  from that time, not the January event. Head:
  `sha256:a89092ab89da32cd9bb0fe8462125c32d89b033d6702fa3e56682b5095439836`.

Acceptance proves later confirmations cannot enter earlier replay, publication cannot
backdate receipt, and split/merge history preserves IDs/memberships and old snapshots.
Additional checks cover exact head pinning for timestamp ties, policy/target corruption,
future context exclusion, descriptive-only quarantine, unit-incomparable expectations,
escaped provenance, stale concurrent curator requests and immutable/idempotent storage.

Confidence and origin-count bands are not probabilities. Asset/expectation rules are local
declarations with recorded provenance, not measured market effects. JSON snapshots are
bounded audit artifacts; large exports can exceed PostgreSQL's existing raw-envelope limit.
Module 06/10 interfaces supply temporally filtered inputs and abstention reasons without
implementing a strategy. See `docs/news-events.md` and ADR 0012. Next is Module 06,
Iteration 1 — Reproducible Event Study.

## Preserved Module 05, Iteration 2 deliverables

Added conservative incident grouping, explicit/metadata/inferred source dependencies,
`evidenceIndependenceScore`, graph assessments, contradiction groups, a human review queue
and append-only observation/withdrawal timelines. A graph assessment is attributable and
fallible; canonical extracted EventClaim v1 records remain unverified. No probabilities,
signals, execution, temporal event-snapshot export or impact model was introduced.

| Path                                                                          | Result                                                                                                                                          |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/news-graph.ts`                                        | Strict versioned config, journal, decisions, graph nodes/edges, score, statuses, review, query and persistence contracts                        |
| `packages/news/src/graph-projection.ts`                                       | Anchored identity, separate provisional incidents, source-dependency components, lexical copy inference, contradictions and evidence timeline   |
| `packages/news/src/graph.ts`, `graph-journal.ts`                              | Serialized append-only service, immutable source/article checks, target-bound manual decisions, fsync/hash-chain and restart validation         |
| `packages/news/src/graph-fixtures.ts`, `tests/fixtures/news/graph-cases.json` | Thirteen synthetic article/source assertions including rewrites, original reports, official quotation, denial and distinct/ambiguous identities |
| `packages/news/src/persist-graph.ts`, `apps/cli/src/news-graph.ts`            | Explicit graph/import/review/decision CLI and idempotent PostgreSQL audit projection                                                            |
| `tests/news-graph.test.ts`, `tests/db.integration.test.ts`                    | 26 new offline tests and one real PostgreSQL graph/retraction test                                                                              |
| `docs/news-independence.md`, ADR 0011                                         | Score/status rules, heuristics, review workflow, temporal limits and handoff                                                                    |

Actual checks on 2026-10-31:

- `pnpm check`: pass, lint/format/typecheck, **300 offline tests**, smoke and contract demo.
- `pnpm test:integration`: **27 actual PostgreSQL 18.4 tests passed**. Isolated project
  cluster stopped afterward; the installed Windows PostgreSQL service was untouched.
- `pnpm run doctor`: pass with Node 24.22.2. Frozen offline pnpm 10.34.9 installation passed.
- All **17 original roadmap checksums** verified unchanged. Original news registry/state
  hashes remain those recorded below. No dependency, SQL migration or old persisted schema change.
- Actual graph fixture CLI: **13 nodes, 6 dependency edges, 6 clusters, 13 review entries,
  14 timeline records** (13 observations plus one labelled synthetic withdrawal).
  Final statuses: 1 disputed, 1 retracted, 1 officially stated and 3 unverified.
- Query at `2026-01-01T09:06:03Z` retains one corroborated event from separate reporters
  and one unverified wire-origin event. The later denial and withdrawal do not enter that view.
  Default fixture journal head:
  `sha256:819f2603ad173686d1d9da8199669fe7d52a035444124c538c10f49661b7f24c`.
- Saved Iteration 1 CLI batch imported without HTTP/model calls: **19 observations,
  17 nodes, 17 unverified provisional clusters and 45 review entries**. Missing explicit
  incident identity/origin evidence did not invent corroboration.
- Actual `graph-decide` synthetic CLI acknowledgement retained operator
  `synthetic:acceptance-reviewer`, a nonempty reason and service time
  `2026-10-31T14:10:27.645000000Z`; it changed queue acknowledgement only.
  Review-smoke journal head:
  `sha256:4247739caa587c6f27ea22f962ed3222b20d01e301b5629faa6464d7dd5d6d69`.
- Separate `crypto_fixture_news_graph` projection stored **15 records**, then exact repeat
  added **zero**. The valid **30-entry** audit head remained
  `sha256:db9f2358c970f3f44843bf3f19570b8de830eb2267858aab48904f9b51a503df`.
  The project cluster stopped; prior namespaces and source journals were preserved.

Acceptance checks prove three rewrites of a wire origin count as one component; separate
original-reporting components corroborate; active opposing assertions dispute; withdrawal
preserves original evidence and earlier decision views. Additional checks cover official
quotes with future/unresolved targets, inferred/circular dependencies, currency/incident
separation, provisional matches, stale concurrent decisions, metadata equivocation,
capacity failures, target tampering, journal corruption and idempotent recovery.

Automatic grouping requires an explicit precise incident label plus matching typed details;
missing identity stays provisional. Reporting cues and registry groups are assertions, not
independent proof. The score is an origin fraction, never factual confidence. Review can
acknowledge, withdraw/restore exact claims or add dependencies, with server recording time;
it cannot set truth, grant rights, force merges or assert independence. Timestamp ties retain
ledger order and exact observed results should retain their head. See `docs/news-independence.md`
and ADR 0011. Next is Module 05, Iteration 3; confidence/impact metadata and immutable event
snapshots remain unimplemented.

## Preserved Module 05, Iteration 1 deliverables

Added a configurable event ontology, bounded deterministic English/Russian extraction,
exact evidence offsets, typed quantities/units, event-time granularity, entities, mentioned
assets, negation and unknown fields. A replaceable structured-adapter boundary validates
untrusted responses against the supported grammar and accepts synthetic inputs only.
Every canonical assertion remains `UNVERIFIED`, with missing factual confidence.

| Path                                                                                    | Result                                                                                                                                              |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/news-extraction.ts`                                             | Strict versioned ontology/input/candidate/response/result/batch/persistence schemas                                                                 |
| `packages/news/src/ontology.ts`, `extraction-grammar.ts`                                | Ten default event types, literal configurable phrases, English/Russian rules and exact UTF-16 support                                               |
| `packages/news/src/extractor.ts`                                                        | Bounded adapter invocation, response reconciliation, source/license/time gates, canonical unverified compatibility and completion-time availability |
| `packages/news/src/extraction-fixtures.ts`, `tests/fixtures/news/extraction-cases.json` | Nineteen separate synthetic documents including denials, currencies, ambiguity, Unicode and injection text                                          |
| `packages/news/src/persist-extraction.ts`, `apps/cli/src/news-extract.ts`               | Explicit fixture/verified-snapshot extraction and append-only PostgreSQL result projection                                                          |
| `tests/news-extraction.test.ts`, `tests/db.integration.test.ts`                         | 44 new offline checks and one actual PostgreSQL extraction test                                                                                     |
| `docs/news-extraction.md`, ADR 0010                                                     | Grammar limits, model/prompt/cost ledger, trust boundaries and next-iteration handoff                                                               |

Actual checks on 2026-10-31:

- `pnpm check`: pass, lint/format/typecheck, **274 offline tests**, smoke and contract demo.
- `pnpm test:integration`: **26 actual PostgreSQL 18.4 tests passed**. Isolated project
  cluster stopped; the installed Windows PostgreSQL service was untouched.
- `pnpm run doctor`: pass with pinned Node 24.22.2. Frozen offline pnpm 10.34.9 installation
  passed. All **17 original roadmap checksums** verified unchanged.
- Original synthetic news registry/state hashes remain exactly those recorded below.
  No dependency, SQL migration, old article/claim schema or roadmap file was changed.
- Actual fixture CLI: **19 documents, 17 assertions**, 14 `EXTRACTED` documents and
  5 `REVIEW_NEEDED`; assertion polarity 14 affirmative, 2 negated, 1 uncertain.
  All assertions are unverified. Different currencies retain separate units and IDs.
- Model `literal-news-grammar.v1`, prompt `news-extraction-prompt.v1`, external API cost
  **USD 0 per document**. Injected test adapter cost remains unknown/null. No actual LLM
  was invoked or evaluated, and no external model/content transmission was enabled.
- Existing verified CISA snapshot restored and processed offline: **30 documents,
  zero supported assertions, 30 `NO_CANDIDATES` review results**. This exposes the narrow
  literal grammar honestly; no factual confidence or model accuracy is claimed.
- Actual fixture `--persist` in separate `crypto_fixture_news_extraction`: **19 new results**;
  repeat of those exact results added **zero**. The valid **38-entry** audit head remained
  `sha256:21590fa3d1a88515f486632a4cf12538a6a1a1a910d0fb36f788c55a5ef23b95`.
  The project cluster was stopped; previous namespaces and journals were preserved.
- Saved CLI batch `data/news-extraction-persisted.json` was revalidated after persistence:
  hash `sha256:6e0c4fc65c089778a803920c30a79c0fc48d488581a25a000e264a62bc99f4f1`.
  Configuration hash `sha256:3ce7a95e85db8c539117493212b360272dc0d4a15edfe22cdebee92d1af7dd36`;
  ontology `sha256:bac0a21a49fdeb56365f0e3b2fb2bde989f23f54beaa740b6e01336cdb309658`;
  prompt `sha256:30686d9ed49f3a81634ff7eef9235cd17465c695c1a1a054acac36ec0380ee09`.

Acceptance checks prove negated assertions never become confirmed facts; equal quantities
with different currencies remain separate; empty/invalid structured responses return review
without accepted claims. Further checks cover forged entities/offsets/units/status, omitted
fields, ambiguous values, timeout cancellation/session stop, attempt budgets, source rights
and extraction completion as the first claim knowledge time. Estimated/unknown historical
evidence remains descriptive in canonical claims. No strategies, clustering, corroboration,
independence scoring or event studies were implemented.

The parser is deliberately limited and non-exhaustive. Review diagnostics are in extraction
result payloads; no automatic analyst correction or general-purpose model integration is
claimed. See `docs/news-extraction.md` and ADR 0010. Next is Module 05, Iteration 2.

## Preserved Module 04, Iteration 3 deliverables

Added a local analyst review API/CLI for rejected feeds/items, legal restrictions and
suspicious dates; an append-only corrections ledger; point-in-time temporal tags and replay
gates; source/language and defensible first-observation coverage; and immutable, verifiable
`news snapshot` exports. No semantic claims, trading engine or frontend was introduced.

| Path                                                                                       | Result                                                                                                            |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/news-review.ts`                                                    | Strict versioned review, correction, temporal class, coverage, replay and snapshot contracts                      |
| `packages/news/src/review.ts`, `correction-journal.ts`                                     | Prospective overlays, operator/reason/service time, evidence binding, optimistic head and fsynced ledger          |
| `packages/news/src/snapshot.ts`, `persist-review.ts`                                       | Rebuild-verifiable metadata export, source/version/input/config hashes and idempotent PostgreSQL audit projection |
| `apps/api/src/news-review.ts`, `apps/cli/src/news-review.ts`                               | Separate loopback API, token-protected writes and explicit review/correction/coverage/export commands             |
| `packages/connectors/src/news-review-fixtures.ts`, `tests/fixtures/news/review-cases.json` | Five additional synthetic verified/archived/unknown/uncertain/rejected date cases                                 |
| `tests/news-review.test.ts`, `tests/db.integration.test.ts`                                | 18 new offline tests and one new PostgreSQL correction-history test                                               |
| `docs/news-review.md`, ADR 0009                                                            | Temporal policy, source-license handoff, replay boundaries, operator workflow and JSON export decision            |

Actual final checks on 2026-10-31:

- `pnpm check`: pass, lint/format/typecheck, **230 offline tests**, smoke and contract demo.
- `pnpm test:integration`: **25 actual PostgreSQL 18.4 tests passed**. The isolated project
  cluster stopped afterward; the installed Windows PostgreSQL service was untouched.
- `pnpm run doctor`: pass with Node 24.22.2. Frozen offline pnpm 10.34.9 installation passed.
- All **17 original roadmap SHA-256 checks** verified unchanged. Original news registry and
  fixture-state hashes from Iteration 1 remain unchanged. No new dependency or SQL migration.
- Review fixture coverage: **9 current articles / 10 versions / 12 captures**, 7 verified,
  1 estimated, 1 descriptive; **77.78%** defensible first observations, 7 default replay
  selections, English/Russian 8/1, 2 rejected feeds and 1 rejected item.
- Final fixture replay snapshot verified with 7 selected articles:
  `sha256:83b05b4185d401646b6343f572f6fb8556e353a7e4a091c9ba8d244ebac65cb6`.
  Metadata input hash: `sha256:1a9f523b42bc472aca65a6c210341e471eccee2375f3d4e8891c70ca17667d9f`.
- Existing CISA journal restored without HTTP: **90 review entries** (30 rejected items,
  30 storage-policy reviews, 30 uncertain publication timestamps), 30 verified actual
  first receipts and **100.00%** measured first-observation coverage. This does not measure
  publication-date certainty, complete feed coverage or truth. Prior GDELT failure remains.
- Final public replay snapshot verified with 30 selected articles:
  `sha256:9fece64f2a79e5754a0d110f0e390b4d5c319f5349a7e85a91ef7036f5cf66ff`.
  Input hash: `sha256:ef6a17c1fdc3f7be8c45ec9caef07c3d81e3a72e5d62a74bb6ce37e7e3d14bd0`.
  Artifacts are under ignored `data/news-snapshots/`, raw bodies stripped.
- Actual synthetic `review-correct` smoke recorded operator `synthetic:acceptance-operator`,
  reason, target hash and service time `2026-10-31T13:12:48.977000000Z`. A proposed January
  availability estimate becomes knowable only from this October correction, and never verified.
  Ledger head: `sha256:653f9d52ba6fc1b073bea1c1b3a8dc9833c746a46ab78559844aba32bfed396c`.
- Separate `crypto_fixture_news_review` PostgreSQL projection: 7 registry records,
  12 captures, 10 versions and 10 receipts; one correction added, exact repeat zero.
  The valid **70-entry** audit head stayed
  `sha256:004b6129535ed64ddcbb1f06f7d876e6b68d58d7a0d05206b4badca2acf066b2`.
  Prior fixture/live/market namespaces were preserved. No review server was left running.

Acceptance checks prove a fabricated publication date cannot satisfy historical replay;
future corrections do not change old decision views or old snapshots; manual overrides
retain mandatory operator, reason and server time. Descriptive-only records always stay
out of replay; estimates require explicit opt-in. Legal acknowledgement cannot change
storage policy or invent parsed articles. Existing persisted schemas and source reviews
remain intact. JSON snapshots are bounded audit exports rather than analytical Parquet;
the loopback service and file ledger are single-host. See ADR 0009 and `docs/news-review.md`.

Module 04 handoff is complete. The original source-license ledger and new temporal fixtures
support the next module. Event ontology/extraction, semantic independence scoring and
event studies remain unimplemented; the next slice is Module 05, Iteration 1.

## Preserved Module 04, Iteration 2 deliverables

Added fixed reviewed CISA official RSS and optional GDELT DOC RSS adapters behind explicit
flags, metadata-only license gates, a finite durable polling CLI, restart-safe quotas,
exponential retries/dead letters, latency measurements and conservative repost grouping.
Separate occurrences, immutable versions and original receipt times remain attributable;
duplicate groups assert zero confirmed facts. No semantic event claims or review UI.

| Path                                                                      | Result                                                                                                        |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/news-poll.ts`                                     | Strict versioned policy, journal action, delivery, duplicate view and report schemas                          |
| `packages/connectors/src/live-news.ts`, `live-news-config.ts`             | Exact permitted public profiles, real receipt capture, expiry and field restrictions                          |
| `packages/connectors/src/news-http.ts`, `news-parser.ts`, `news-dates.ts` | Typed retry responses, ignored prohibited text and live v2 uncertain date handling                            |
| `packages/news/src/poll-journal.ts`, `poller.ts`                          | Exclusive lock, hash chain/fsync, reservation before HTTP, bounded replay, quotas and dead letters            |
| `packages/news/src/dedup.ts`, `store.ts`                                  | Tracking canonicalization, possible dependency views, versioned hash-only replay and stable first observation |
| `apps/cli/src/news-poll.ts`                                               | `news poll --enable-live [--enable-aggregation]`, `news poll-status`, optional PostgreSQL projection          |
| `tests/news-poll.test.ts`, `tests/db.integration.test.ts`                 | 23 new offline checks and one new real database check                                                         |
| `docs/news-live.md`, ADR 0008                                             | Source ledger, commands, local scheduler decision, recovery limits and handoff                                |

Actual checks on 2026-10-31:

- `pnpm check`: pass, including lint/format/typecheck, **212 offline tests**, smoke and demo.
- `pnpm test:integration`: **24 actual PostgreSQL 18.4 tests passed**; isolated project
  cluster stopped afterward, existing Windows service untouched.
- `pnpm run doctor`: pass with pinned Node 24.22.2; frozen offline installation with
  pnpm 10.34.9 passed. Synthetic news registry/state hashes below are unchanged.
- All **17 original roadmap checksums** verified unchanged.

Live read-only smoke evidence, retained under ignored `data/news-live/`:

- Initial CISA capture at approximately 07:46 UTC retained its byte hash and 30 timestamp
  rejections from strict parser v1. Its journal records were preserved, not rewritten.
- After the recorded 15-minute cooldown, live parser v2 accepted **30 articles** at
  `2026-10-31T08:01:31.633000000Z`, processed at `08:01:31.696000000Z`.
  Network latency was **528 ms**, parser latency **63 ms**. Two-digit publication years
  (for example `Fri, 30 Oct 26 12:00:00 +0000`) remain null/uncertain; actual receipt
  establishes first observation. There were no item rejections in this second capture.
- Optional GDELT request failed with `NETWORK`; the journal retained the spent attempt
  and retry due at `2026-10-31T08:13:14.323000000Z`. No aggregation success is claimed.
- Status after restart: 6 journal records, 2 hash-only captures, 30 deliveries/versions,
  30 cumulative old rejections and 30 uncertain timestamps. No raw feed body retained.
- Journal head: `sha256:0bcfe38bbbcd46f841d9d8c269f54ae31d39376d694d82460702c81773be17ab`.
  State: `sha256:15405e3791a8bdfc4bd2e27eb8dfcf278c3c12058803e9c230338145f7e0a398`.
  Profile: `sha256:23c8ee3ab614bdc1002d972223aabe452a9826ba889efa806ecdf207cbb0baaf`.
- Real `poll-status --persist` in separate `crypto_fixture_news_live`: 4 registry records,
  2 captures, 30 versions and 30 receipts. Repeat added zero; the **102-entry** audit chain
  remained valid with head
  `sha256:116a1c1e255b1be8ab31586271532e595d6a628620e37ae17678b97c1038ae4e`.
  The project cluster was stopped. Prior fixture/market namespaces were left intact.

The local scheduler intentionally uses a finite CLI and durable file journal instead of
the master default BullMQ/Redis background worker; ADR 0008 explains the single-host scope.
Old parser/store v1 and SQL migrations remain unchanged; live uncertain metadata uses v2.
No prohibited full text is retained. Unknown provider dates remain null and flagged;
actual receipt/processing times govern point-in-time access. The source review expires on
2026-11-30 UTC. See `docs/news-live.md` for operational limitations and source references.

## Preserved Module 04, Iteration 1 deliverables

The news registry now declares owners, regions, publication/reliability/independence policy,
cadence/quotas, URL/field allowlists, retention rights, limits and known source versions.
Only locally authored synthetic sources are enabled; optional RSS/GDELT adapters remain
disabled. There is no live news poller, semantic claim extraction or trading behavior.

| Path                                                              | Result                                                                                                         |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/news-ingest.ts`                           | Strict versioned provider/source/registry/capture/parser/document-version/store schemas                        |
| `packages/connectors/src/news-parser.ts`, `news-dates.ts`         | Bounded strict RSS/Atom/JSON Feed parsing, explicit timezone conversion, inert content                         |
| `packages/connectors/src/news-policy.ts`, `news-http.ts`          | URL allowlists, public-only DNS pinning, TLS/redirect/type/size/deadline guards                                |
| `packages/connectors/src/fixture-news.ts`, `tests/fixtures/news/` | Provider interface, synthetic source ledger and seven capture fixtures                                         |
| `packages/news/src/registry.ts`, `store.ts`                       | Known-source resolution, append-only revisions, first-observed/availability separation and point-in-time reads |
| `packages/news/src/persistence.ts`                                | Transactional provider/source/capture/metadata registration and existing PostgreSQL news history               |
| `apps/cli/src/news.ts`                                            | `pnpm news registry`, `pnpm news fixtures [--persist]`                                                         |
| `tests/news.test.ts`, `tests/db.integration.test.ts`              | 54 new offline tests and three new real database tests                                                         |
| `docs/news-registry.md`, ADR 0007                                 | Source policy, temporal/storage semantics, API limits and handoff                                              |

Actual final checks on 2026-10-31:

- `pnpm check`: pass, lint/format/typecheck, **189 offline tests**, smoke and contract demo.
- `pnpm run doctor`: pass; `pnpm install --frozen-lockfile --offline`: pass.
- `pnpm test:integration`: **23 actual PostgreSQL 18.4 tests passed**. Project cluster stopped;
  the existing Windows service was untouched.
- CLI fixture run: 3 providers, 4 sources, 7 captures, 5 article occurrences, 6 versions,
  2 rejected malformed feeds and 1 hash-only capture. No external news feed was fetched.
- Registry hash: `sha256:49af08079add7bf352122040c9dbc195c4ff52e4642dafaf27242c65fd5844e8`.
- Fixture state hash: `sha256:132f2643937d0bcad93d13aea0457f4d42a0c0c8f4a479653aae6b47aafcaee3`.
- Actual `--persist` twice in `crypto_fixture_news`: first 7 registry records, 7 captures,
  6 versions, 6 metadata receipts; repeat zero additions and unchanged **46-entry** audit chain.
  Head: `sha256:c04a35353f690d967410ff89c1bccb327e25c1720e2baba5ca711edd63a4face`.
- All 17 original roadmap SHA-256 checks verified. Remote CI/Docker were not run locally.

Existing `news-document.v1`, raw event/research schemas and migration checksums are unchanged;
new data uses versioned payloads in existing append-only stores. Activated `@crypto/news` and
pinned sax 1.6.1/ipaddr.js 2.5.0 plus dev types 1.2.7 in the lockfile. The metadata-only source
retains neither body nor snippet. Source copies share an independence group without being
treated as independently verified facts. Old headline views remain available before the update.

The live source approval, quotas and deduplication boundary recorded here was implemented
in Iteration 2 above. Review queues, corrections/export and semantic claims are later iterations. See
`docs/news-registry.md` for commands, limitations and preserved fixture evidence.

## Preserved Module 03, Iteration 3 deliverables and checks

| Path                                                            | Result                                                                                                           |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/market-data.ts`                         | Strict versioned metadata, observation, dataset, query/result, artifact and MarketData interface                 |
| `packages/research/src/market-data.ts`                          | Immutable SnapshotMarketData: history, resolution, eligible/descriptive rows, universe, quality and strict joins |
| `packages/research/src/market-bar-observation.ts`               | Explicit bar projection preserving lineage, candle-only quality and unknown turnover/liquidity                   |
| `packages/research/src/market-quality-artifact.ts`              | Content-addressed input/config/code/report evidence with atomic publication and full recomputation               |
| `packages/connectors/src/market-quality-fixture.ts`             | Two fictional venues, BTC/ETH/SOL, delisted/new instruments, renames, precision and unavailable derivatives      |
| `apps/api/src/market-data.ts`, `apps/cli/src/market-quality.ts` | Read-only loopback queries, fixture quality report, verification and service commands                            |
| `tests/market-data.test.ts`                                     | 36 new offline acceptance/failure tests                                                                          |
| `docs/market-quality.md`, ADR 0006                              | Semantics, limits, API usage, source policy and downstream handoff                                               |

Actual final checks on 2026-10-31:

- `pnpm check`: pass, lint/format/typecheck, 135 offline tests, smoke and contract demo.
- `pnpm run doctor`: pass, fixture readiness.
- `pnpm test:integration`: pass, 20 actual PostgreSQL 18.4 tests; isolated cluster stopped.
- All six HTTP query routes validated by injection; a real loopback request returned the
  versioned BTC/ETH universe. The listener was closed and no query service remains running.
- Fixture import/replay/quality handoff passed. All 17 original roadmap SHA-256 hashes verified.

The four-minute synthetic quality report selects BTC and ETH under full coverage and
minimum-liquidity rules. Delisted OLD remains in history; NEW cannot appear before eligible
knowledge and lacks full lookback; SOL has a missing interval/liquidity. At 250 ms tolerance,
BTC matches 4/4, ETH 0/4, SOL 3/3 with one divergent match. Beta SOL has two spikes; beta ETH
has four drift violations. Perpetual funding/open interest/mark price remain unavailable.

Verified artifact:
`data/market-quality/market-quality_f1f114874313c5103121c53e6e8aa47c867d4cc2b7439aaabcfdfd3173e608fd.json`.
Artifact hash: `sha256:f1f114874313c5103121c53e6e8aa47c867d4cc2b7439aaabcfdfd3173e608fd`.
Dataset hash: `sha256:0f4a841b5bfced4b64806d10b4bf81e241b221c91863b47b84de6a87832aa684`.
The artifact retains all source policy, metadata revisions, observations, requests and results.
Recomputation succeeded. Its normalized collection hash is input-order independent.

The handoff import still yields 9 bars and 7 quarantined rows, stable Parquet bytes, at
`data/market/market-snapshot_21029ae0fefc9b290a262d9ca7648e8f804d51208c03d4561915801e1c992825/`.
Synthetic capture/replay verifies 12 observations (three usable) at
`data/market-streams/market-stream-recording_211c9727af70e54ed5cc2c1040ad098ad08c98dd508a0de7ab88f3d781cba855/`,
with chain head `sha256:17a344f8a57499ce5fd1db7bf16e0fb375d950558b373dd1132de784b2ec6df1`.

Module 03 introduces no credential use or financial claims. This iteration made no new
provider requests: multi-venue results are synthetic. Existing actual Binance evidence below
is preserved. New persistence is a versioned standalone artifact; prior bar/run/stream v1
and SQL migration checksums are unchanged. No dependency or lockfile changed. Live metadata/
cross-venue collection, automatic aggregation and SQL catalog indexing remain integrations.

## Preserved Iteration 2 deliverables

| Path                                          | Result                                                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `packages/contracts/src/market-stream.ts`     | Versioned config/input/step/view/record/manifest schemas                                    |
| `packages/connectors/src/public-stream.ts`    | Provider-neutral MarketStream, public Binance REST/WebSocket adapter, bounded runner/budget |
| `packages/connectors/src/stream-state.ts`     | Sequence/book/clock/freshness reducer and decision-time expiry gate                         |
| `packages/connectors/src/synthetic-stream.ts` | Synthetic gap/reordering/recovery/stale/disconnect script                                   |
| `packages/research/src/stream-recording.ts`   | Atomic content-addressed JSONL capture, hash chains, exact offline replay                   |
| `apps/cli/src/market-stream.ts`               | market stream and market replay commands                                                    |
| `tests/market-stream.test.ts`                 | 29 offline acceptance/failure tests, including CLI and injected transport                   |
| `docs/market-streams.md`, ADR 0005            | Usage, provider references, limits, results and compatibility                               |

New persistence uses standalone versioned recording schemas. Existing research-run.v1,
SQL migrations, offline snapshots and archive formats are compatible. No dependency/lockfile
change was needed. SQL indexing and stream API integration are deferred.

## Iteration 2 verification (2026-10-30)

Pinned Node 24.22.2 / pnpm 10.34.9:

| Check                            | Result                                                                       |
| -------------------------------- | ---------------------------------------------------------------------------- |
| pnpm check                       | Pass: lint, formatting, typecheck, 99 offline tests, smoke and contract demo |
| pnpm run doctor                  | Pass: fixture operational readiness                                          |
| pnpm test:integration            | Pass: 20 actual PostgreSQL 18.4 regression tests                             |
| Synthetic capture/replay and CLI | Pass: original order/steps/views/hashes, immutable reuse                     |
| Actual public BTC capture        | 110 observations, 80 usable depth views, zero faults; clean STOPPED          |
| Roadmap SHA-256 verification     | Pass: all 17 original files                                                  |

Tests cover gaps/reordering/duplicates, late responses across disconnect/reconnect, clock
skew/RTT/expiry/regression, provider delay/future time, stale decisions, depth exhaustion,
invalid books, buffering/reconnect/request bounds, cooldowns, heartbeat silence, clock
remeasurement, provider denials/redirects/oversize, exact large sequences, recording mutation,
incomplete captures and rejected credential/arbitrary-endpoint flags.

Real and synthetic inputs were tested separately. The first actual eight-second BTC capture
received 67 depth updates but rejected a 1.111-second clock RTT, yielding zero usable quotes.
A second capture after bounded clock remeasurement produced 110 observations, 80 usable
views and no faults. Retained recording:
`data/market-streams/market-stream-recording_f772974d9fa7adc4b599e34ed59fc41ee59172ce0ada5a675b51323e6c35c108/`.
Software hashes describe the capture version; later changes do not rewrite historical evidence.
ETH/SOL real streams, long-running operation and remote CI were not tested locally.

Final replay verified all 110 public observations and chain head
`sha256:d9edf39fe5d73f09e81dac08936b604ae905a9639856697a8012b469af7aca7a`.
The final synthetic CLI capture has 12 observations, three usable, and metadata hash
`sha256:412630f4e2a7912188c0636de4be9b084046f1856b1e70adbfab8c08f8948339`.

PostgreSQL regression used the isolated project cluster and stopped it afterward. The separate
Windows PostgreSQL service was untouched. Docker/remote CI remain unverified locally. Market
tests and replay are offline and credential-free.

## Preserved iteration 1 evidence

See docs/market-import.md and ADR 0004. Synthetic fixtures have 9 accepted bars, 7 quarantined
rows, with Parquet byte hash
`sha256:410aa71af1dd7047eb9977a3ffffeb61155de3fedd27f95611ef319c44706c38`.

Two official BTCUSDT one-minute archives for 2024-12-31 and 2025-01-01 yielded 2,880
candles, no gaps/quarantine, all DESCRIPTIVE_ONLY because historical availability is unknown.
Checksums and explicit ms/us boundary verified; repeated actual DB import was idempotent.

- Inputs: data/market-inputs/binance-boundary.json (ignored local evidence).
- Snapshot: data/market/market-snapshot_8be18125b8723d59a61dbd0c85f76b0cf2f9912b7a217ea3867af529162dcb73/.
- Metadata hash: sha256:79e3bc0ba01760111af9ae9e8485588301270e3c5fa038428c35ad7230ab09e7.
- Parquet hash: sha256:8ed5fed90f2b0732e601971cb79e434d928c137991b569e85b464751a0d0ab3a.
- Dataset hash: sha256:7e48837c860a783a562c48d330400790cc61ace0765d8a2c40a7aac96c9bc1ce.
- Run: market-import-run_3cf9d640263374af24d035548e82b6b1d6d81d355d0d67b7b1601491fe2ede14.
- Preserved 5,762-entry audit chain on repeat registration.

## Archived Module 03 limits and handoff (superseded)

Captures support one mapped spot pair, at most 60 seconds and one public provider. Depth
is bounded. Rights are undetermined; source/terms links do not grant a license. No quote
implies a guaranteed fill or profitability. Integrity hashes do not authenticate providers.
Stream API/daemon/SQL indexing, event studies, fees/risk/fill simulation and live news are later work.

The earlier Module 03 handoff requested Module 04 Iteration 2. That work and all later
implementation iterations are now complete. The capture limits above describe that
historical finite recorder. Current implementation status and remaining real-world
validation are recorded at the top of this document.
