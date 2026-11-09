# Free-source news strategy V4

At `/news-strategy-tests`, **V1–V4 · 36-month study** shows the longer comparison;
**Original V1–V3 · six months** preserves all earlier frozen reports.

Requested window: 2023-11-07 09:00 UTC through 2026-11-07 09:00 UTC. Training ends
2025-11-07, validation ends 2026-05-07, and the final six months are evaluated once
per fixed engine/input version. All four versions use common long-study inputs.
Their new P&L must not be compared with the original two-month final split as if
the periods were identical. Final prices were inspected previously; this is not
an unseen holdout.

## Public sources and coverage

Nine sources are added without private keys. Existing 37 entries and operator
settings remain intact; defaults are insert-only. Manage them at `/news-engine`.

| Source                          | Role                                             | Limits                                                                                                                                          |
| ------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Bybit announcement API          | Paginated factual title/URL/publishTime metadata | Up to 100 pages of 100; only current-universe token headlines retained in research. Author/event dates do not replace missing publication time. |
| Solana and Coinbase Status      | Individual incident updates                      | Limited retention; edits/resolutions cannot be backdated into the first report.                                                                 |
| XRPL public full-history server | Validated amendment transactions                 | Up to 300 prior-state links; voting and activation remain distinct; unavailable history is partial.                                             |
| GDELT DOC                       | Public discovery metadata                        | Bounded current results; no article bodies or fitted signals. No complete multi-year text archive claim.                                        |
| BLS CPI/jobs                    | Original government releases                     | Header times, ET/DST conversion, numeric excerpts; cancelled/unavailable releases stay missing.                                                 |
| Fed statements                  | Original public policy decisions                 | Header time and numeric target range; no consensus forecasts.                                                                                   |
| SEC crypto archive              | Public press releases                            | Up to 12 index pages/150 release pages; date-only records stay undated and cannot trade.                                                        |

Each source reports requests, scanned/retained/dated counts, earliest/latest
publication and COMPLETE/LIMITED/UNAVAILABLE status. COMPLETE means the bounded
advertised traversal finished, not that every real-world event was captured.
Historical records retain today's real collection times and cannot qualify for
point-in-time trading research. Missing sources are never replaced by fixtures.

Compressed public captures retain byte hashes and receipt times. UTF-8 BOMs are
preserved; old BOM-stripped captures are recoverable only if the original hash
proves the exact restored bytes. Frozen corpora record a collector hash and cannot
be silently replaced. Synthetic fixtures are labelled and cannot create a public
report. No paywalled bodies or private credentials enter the research cache.

## V4 model and execution

Material status and affected tokens form features. Routine promotions, AMAs,
rumors, resolutions, planned upgrades, duplicate reports and unknown publication
times stay HOLD. An official listing announcement is an announcement event, not
proof that trading began. Activation requires a validated network transaction,
not a release notification. Exact exchange pair symbols such as BTCUSDT and
SOLUSDT map to their base tokens without modifying the original evidence quotes;
unknown prefixes and ambiguous synthetic symbols are not guessed.

CPI/payroll/Fed features compare an actual value with the median of three strictly
earlier original releases. This is **lagged-release deviation**, not economist
consensus, a calibrated forecast or proof of market surprise. Original excerpts
and prior event IDs are retained; missing actuals/history stay HOLD.

For each token/type, V4 estimates controlled returns multiplied by the feature
sign. Opposite signs share a training relationship and can learn a reaction that
reverses semantic polarity. Ten token responses never count as ten announcements.
Training labels and controls finish 72 hours before the training boundary.

Six candidates use 4/24/72-hour horizons and 12/20 training observations. Absolute
estimated edge minus 1.96 standard errors must exceed twice execution costs.
Non-overlap/deduplication do not prove statistical independence. Selection needs
five validation trades and a positive `net P&L - 2500 × drawdown` score; otherwise
the token stays in cash. No trade is forced to meet the +100 USDT research target.

The report retains candidates, three expanding walk-forward diagnostics,
doubled-cost and +1-hour-delay tests. Each token/version/split starts separately
with 10,000 virtual USDT. Allocation: 20%; stop: 2.5%; target: 5%; fill fees: 0.1%;
adverse slippage: 0.05%. Hypothetical collateralized shorts retain the baseline
hourly borrowing assumption, not verified borrow availability or perpetual funding.
Hourly fills remain comparable; earlier minute diagnostics do not become fills.

## Persistence and operation

New immutable tables: `research_v4_runs`, `research_v4_events`,
`research_v4_corpora`, `research_v4_reports`. Requests freeze seed, permissions,
engine, reference V3 run and protocol. Archive corpus is frozen before fitting.
Completion verifies parent hashes and seed/corpus identity. The API under
`/api/news/research/v4/` inherits operator/Origin protection; exports support
JSON/CSV/Markdown. Research uses the existing concurrency-one BullMQ queue with
explicit V4 routing, bounded retries and verified persistent market chunks.

Source collection uses existing BullMQ schedules, quotas and backoff. Deploy news
API, collector, analyzer, research worker and web together: older schemas cannot
read the new adapter types. Any rollback needs a compatible image and preserved
database/cache backups; never remove history or financial volumes to undo a UI.
No live news trader is enabled and no extra AI calls are required.

Validation: `pnpm check`, `pnpm doctor`, focused V4 PostgreSQL/Redis tests. Cases
cover timestamp/permission failures, original-release ordering, both LONG/SHORT
directions with fees, train/test purging, cache integrity, synthetic exclusion,
immutable corpora and real BullMQ routing. Production evidence is recorded below.

## Completed production comparison

Run `57fb2088-801c-40d7-97fb-8877c79fc08c` completed on 2026-11-08. The final
evaluation is 2026-05-07 09:00 UTC through 2026-11-07 09:00 UTC, fees on.

| Token | V1 net USDT | V2 net USDT | V3 net USDT | V4 net USDT |
| ----- | ----------: | ----------: | ----------: | ----------: |
| BTC   |      -31.13 |       43.66 |        0.00 |        0.00 |
| ETH   |     -136.77 |      161.56 |        0.00 |        0.00 |
| SOL   |      -55.41 |       85.48 |        0.00 |        0.00 |
| TRX   |        3.02 |     -284.88 |        0.00 |        0.00 |
| BNB   |      -40.71 |      -16.10 |        0.00 |        0.00 |
| XRP   |      -55.18 |      -28.05 |        0.00 |        0.00 |
| DOGE  |      -55.37 |        6.86 |        0.00 |        0.00 |
| ADA   |      -56.09 |      277.59 |        0.00 |        0.00 |
| LINK  |      -55.32 |       97.77 |        0.00 |        0.00 |
| AVAX  |      -55.20 |      253.41 |        0.00 |        0.00 |

USDT remains cash. V4 makes zero final trades, so pays no actual commissions;
the fee policy stays enabled. ETH/ADA have four validation trades, below the
declared five-trade gate; other candidates lack sample/edge support. No threshold
was lowered to force trades or meet the profit target. More news does not itself
establish a profitable prediction.

The report has 2,504 records and 79 eligible events, with 26,304 hourly candles per
token. Eight new collectors are healthy; GDELT is currently failing, with zero
retained discovery records. Source-specific limitations and exact dates remain
in the dashboard. Report hash:
`sha256:3fa77b06e434fda0ad1d94c3360acd592d7988a848488b6fca7badcb164f2530`.
The frozen report/corpus survived worker restart and backup restoration. All
original source settings, reports and financial engine bytes remain preserved.

The initial V4 run `b98e08fa-30c1-41be-86de-67a8cc3fa13c` remains selectable as
an immutable audit record. The pair-symbol mapping correction retained 13 more
records without changing thresholds, execution assumptions or final P&L. Final
code passed 1,179 regression tests and 20 PostgreSQL/Redis integration tests.
