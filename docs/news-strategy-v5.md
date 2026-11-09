# News strategy V5: costed event-category validation

The dashboard defaults to **V1–V5 · same history · fees on** at
`/news-strategy-tests`. The V4 study and original six-month studies remain selectable.
All ten tokens are evaluated independently; USDT is cash.

## Frozen comparison

V5 references V4 run `57fb2088-801c-40d7-97fb-8877c79fc08c`, report
`sha256:3fa77b06e434fda0ad1d94c3360acd592d7988a848488b6fca7badcb164f2530`.
The 2023-11-07 09:00 UTC to 2026-11-07 09:00 UTC window, 24/6/6 split,
2,504-record corpus, ten market manifests and all V1–V4 model/account objects
are preserved exactly. V5 reads only parent content-addressed chunks: no current
snapshot capture, source collection, latest-price pointer or replacement download.
Missing/corrupt chunks fail closed. Database completion checks parent identity,
corpus, seed, events, coverage, manifests and every prior row/model.

Each token/version/split starts at 10,000 virtual USDT. Fees remain 0.1% per
fill, adverse slippage 0.05%, allocation 20%, stop 2.5%, target 5%, and assumed
short borrowing 0.0003% per hour. Publication plus five minutes rounds forward
to the first hourly open. Stops/gaps use unchanged adverse fill arithmetic.
Slippage is already included in prices and is not charged a second time.

## Why the V2 winners earned money

V2 learns mean excess return versus same-hour non-event controls, per token and
news category. Its selected winner configurations have no standard-error margin.
The final six-month contribution breakdown, already net of fees and financing:

| Token | Inflation longs | Jobs shorts | Fed shorts | Total V2 |
| ----- | --------------: | ----------: | ---------: | -------: |
| ADA   |          +60.16 |     +235.96 |     -18.53 |  +277.59 |
| AVAX  |         +121.45 |        0.00 |    +131.95 |  +253.41 |
| ETH   |          +95.45 |      +66.12 |       0.00 |  +161.56 |

ADA/AVAX select 72-hour holding limits; ETH selects 24 hours. Stops/targets
often exit earlier. AVAX's jobs category fails its training cost threshold;
ETH's adopted-news category loses validation money and does not occur in the
final trades. ADA also has an additional inflation-category entry after an
earlier position exits. Token-specific volatility and response paths produce
different stop/target outcomes from the same release.

Double-cost V2 results stay positive: ADA +188.37, AVAX +207.77, ETH +87.71.
One additional hour of entry delay instead gives ADA -310.50, AVAX -48.49,
ETH -82.13 USDT. This strong timing sensitivity limits the result. These are
descriptive contribution accounts, not proof that the news caused the move.
V2 trades all jobs releases in one learned direction regardless of the actual
surprise. TRX's jobs shorts lose -203.88 in the final split despite profitable
aggregate validation. Profitable tokens alone therefore do not establish alpha.

V4 combines signed original-release deviations, minimum 12/20 examples, a
1.96 standard-error margin, twice costs and five validation trades. No candidate
passes. ETH/ADA examples that pass training produce four validation trades.
Cash means abstention, not a successful prediction.

## Declared V5 experiment

V5 is a distinct unconditional release-category hypothesis. Official macro
releases are grouped into inflation, employment and monetary policy, regardless
of missing consensus or an unchanged lagged release value. It does not invent
consensus data. One issuer/category/day counts once; original archives take
precedence over duplicate RSS. Other event types retain V4 permission, date,
stage, uncertainty and deduplication gates. Unknown dates, rumors, planned
changes, discovery-only GDELT records and prohibited content remain excluded.

Exactly three horizon candidates: 4, 24, 72 hours. Each category needs eight
nonoverlapping training samples and mean controlled edge greater than twice
estimated round-trip costs. The uncertainty multiplier is explicitly zero:
this exploratory mean-edge rule does not inherit V4's confidence claim.
Training alone chooses LONG/SHORT. Validation then requires each category to
have at least three trades across two UTC months and positive net P&L at normal
and double costs. Rejected categories become HOLD. The combined candidate must
have five validation trades and positive score:

`validation P&L - 2500 * validation drawdown - 0.5 * largest validation win`.

Horizon selection never reads final labels; tests alter all final prices and
remove final events without changing the selected candidate. Three horizons
and every adaptive category check are reported. Category selection is additional
multiple testing, not three independent scientific trials. No final-period
threshold search or per-winner hardcoded exceptions are used.

A preflight implementation defect read mixed legacy/V3 display events as
training categories and excluded unchanged numeric releases. It was corrected
to construct canonical issuer events from the frozen structured facts. The
initial local diagnostic is retained separately; no thresholds changed after
viewing it. Tests cover duplicate RSS/category views and unchanged releases.

V5 reports all split accounts, group decisions, rejected candidates, cost/delay
stresses, trades with source links, and V2 category/direction/month attribution.
Largest-trade removal is a contribution diagnostic and does not recompute equity
compounding. JSON/CSV/Markdown exports preserve every strategy version.

Historical article receipt/version vintages remain unverified, the universe is
selected using current tokens and the final prices have already been inspected.
All reports remain descriptive and `qualifiedForForwardTest: false`. V5 can
lose money or stay in cash and is not assumed to improve V2 profit.

## Completed production comparison

Run `a91716ee-8374-4ef3-a10c-e69357143b05`, completed 2026-11-08.
Report hash:
`sha256:bb09ca42bbd12dd7f95f16e5d7cb8e10ed6b062730f252464486afcadbd64cb2`.
Engine:
`sha256:131542d051190629e51ddae023c602a750809835c7763b9af5c97678659ba606`.
The server replay matches all local V5 model objects exactly.

Final six-month net USDT, each account starting independently with 10,000:

| Token     |      V2 |      V5 | V5 trades | V5 double costs | V5 extra hour delay |
| --------- | ------: | ------: | --------: | --------------: | ------------------: |
| BTC       |  +43.66 |    0.00 |         0 |            0.00 |                0.00 |
| ETH       | +161.56 |    0.00 |         0 |            0.00 |                0.00 |
| SOL       |  +85.48 | -180.09 |        13 |         -247.13 |             -567.17 |
| TRX       | -284.88 |    0.00 |         0 |            0.00 |                0.00 |
| BNB       |  -16.10 |  +38.72 |         6 |           +3.58 |              -53.09 |
| XRP       |  -28.05 |  -25.99 |        13 |          -91.11 |               -6.19 |
| DOGE      |   +6.86 |   +6.86 |         6 |          -25.26 |              -51.08 |
| ADA       | +277.59 | +117.13 |         6 |          +86.46 |             -330.74 |
| LINK      |  +97.77 |  -36.10 |        13 |         -102.48 |              -15.71 |
| AVAX      | +253.41 | +118.01 |         6 |          +87.63 |             -180.37 |
| USDT cash |    0.00 |    0.00 |         0 |            0.00 |                0.00 |

V3/V4 still have zero trades; the dashboard includes their preserved accounts
alongside V1. V5 trades seven tokens and does not improve V2 overall. ADA/AVAX
retain inflation longs but omit other V2 categories. In particular, ADA jobs
shorts fail double-cost validation despite later final-period profits. ETH's
macro training edges fail the twice-cost criterion or lose validation money.
This is an abstention decision, not a missing execution or a claim about ETH's
future direction. Canonical categories and the admitted event set also change
which non-event control windows are available relative to V2. No thresholds
were adjusted after the corrected final replay.

The 115 V5 events comprise 35 inflation releases, 31 jobs releases, 25 Fed
releases, 21 protocol activations and three listing announcements. Sparse direct
token events still lack sufficient evidence. All active V5 tokens lose money
under the extra-hour stress, including the baseline winners: timing remains a
material limitation. No strategy is live-qualified.

Full check passed 1,186 tests in 69 files, plus 23 real database/queue integration
tests, doctor and production builds. Production verification covered exact old
models/reports, fee/account reconciliation, common inputs, source settings,
exports, idempotency and the served frontend bundle. A fresh backup restored
five reports, two corpora and 46 source configurations into a scratch database.

## Persistence and operations

Separate `research_v5_runs`, `research_v5_reports`, `research_v5_events` tables
reuse the immutable V4 corpus by reference. Snapshot, plan and parent identity
are immutable. BullMQ jobs carry `kind: v5`; completed retries return the stored
report. The API requires existing admin/Origin authorization to start runs;
reads/exports retain existing access controls. Request bodies allow only an
optional completed V4 parent ID, never fee or date overrides.

Deployment updates news API, historical research worker and web only. No market
paper ledger, source settings, collectors or financial execution engine changes.
