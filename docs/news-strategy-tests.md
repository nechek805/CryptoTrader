# Six-month historical news strategy research

The newer [V4 long-history study](news-strategy-v4.md) adds free public adapters
and a common 36-month comparison. Original six-month reports remain frozen and
accessible in the dashboard's original-study tab.

## V3 comparison

The V3 comparison preserves the original V1/V2 report, model objects, trades and
market/news snapshot hashes. It appends a separately versioned V3 model for every
token and retains USDT as cash. Use **Run / open V3 comparison**; the run selector
also opens the original frozen V1/V2 report. JSON/CSV/Markdown exports include
all versions. This changes research only; it does not deploy a live news trader.

V3 extracts event kind, completion/status, severity, issuer attribution, affected
tokens and exact permitted evidence quotes. Routine AMAs, invitations, proposals,
testnets, postponements, cancellations, negations, rumors and resolved incidents
stay HOLD. Completed material events can enter estimation; extraction itself
does not choose LONG or SHORT. Permission/unknown-date gates remain explicit.

Macro inputs require a matching metric/unit actual and a consensus observation
published and collected before that exact release. The optional input schema
supports CPI month-on-month, payroll change and the Fed upper target; the current
extractor handles CPI/payroll actuals. **No historical consensus provider is
configured**, and Fed numeric extraction is not implemented, so unavailable
surprises stay HOLD. V3 does not substitute previous releases, revised data or
an AI's present-day recollection for a historical forecast.

The frozen search has six candidates: 4/24/72-hour horizons, 12/20 independent
training samples, a 1.96-standard-error margin and twice estimated trading costs.
Training labels/controls finish at least 72 hours before the training boundary.
Selection needs five validation trades and a positive costed risk-adjusted score.
Deduplication and non-overlap filters do not establish statistical independence.
Three expanding monthly walk-forward folds, doubled costs and one-hour extra
latency are retained alongside the original 3/1/2-month comparison. Risk limits,
20% exposure, hourly fills, fees, slippage and short financing remain identical
to the baseline, so execution changes do not confound this comparison.

Up to 24 separate one-minute reaction windows are downloaded from Binance's
public market endpoint, selected by token/time/taxonomy without future returns.
They record raw 5/15/60-minute reactions and minute-vs-hour entry timestamps;
they are **not V3 net profit**. Missing or invalid windows stay unavailable.
Raw captures, hash-checked cache and selected event identities are retained.

V3 uses separate immutable `research_v3_runs`, `research_v3_events` and
`research_v3_reports` tables and `/api/news/research/v3/` routes. BullMQ uses the
existing concurrency-one research queue with an explicit V3 job kind. Completion
verifies the parent report hash, original models, costs, prices and corpus.
Operator/Origin authorization, idempotent starts, bounded retries and persistence
survive worker restarts.

Initial same-history V3 replay: all ten token models stayed in cash, with zero
trades and zero P&L. All 24 minute diagnostics loaded real data. The stronger gates
reject the archive's routine/planned events and macro releases without consensus.
This avoids the observed baseline losses but does not meet the +100 USDT target
or demonstrate predictive profit. Historically timely news coverage is still zero;
all reports remain descriptive and unqualified for live use.

Production comparison completed on 2026-11-08, run
`b008ecd5-d62a-4bd5-8c8a-7955cb796d0f`, using the original 2026-05-07 09:00 UTC
through 2026-11-07 09:00 UTC history. Final-split net P&L in USDT:

| Token                               |      V1 |     V2 |   V3 |
| ----------------------------------- | ------: | -----: | ---: |
| ETH                                 | -121.88 |   0.00 | 0.00 |
| BNB                                 |    0.00 | -14.98 | 0.00 |
| AVAX                                |    0.00 | -32.03 | 0.00 |
| BTC, SOL, TRX, XRP, DOGE, ADA, LINK |    0.00 |   0.00 | 0.00 |

USDT is the separate unchanged cash control. Zero V3 trades means no commissions
were charged, although the fee policy remains enabled. Before trading, the system
needs more dated material events and verified pre-release economic expectations;
this implementation does not manufacture missing historical information.

Open `/news-strategy-tests` in the authenticated dashboard. The study includes
BTC, ETH, SOL, TRX, BNB, XRP, DOGE, ADA, LINK and AVAX, plus USDT as a cash control.
Each token and evaluation split starts with a separate **10,000 virtual USDT**.
Accounts are not combined into a fictitious single portfolio.

## What this study can establish

Current feeds contain old articles, but our collector first observed them on
2026-11-06/07. Historical feed content and its original availability cannot be
reconstructed from publication dates alone. Undated articles, including the XRPL
index and Helius entries without publication dates, are excluded. Publisher update
times are not silently substituted for publication times. Permission settings
are checked on both the current source configuration and stored article version.

The report is always `DESCRIPTIVE_ONLY_NOT_A_TRADABLE_BACKTEST`; model qualification
is constrained to false. It studies hypothetical publication-time alignment and
does not promote archived records into the existing point-in-time `trainNewsEdge`
API. A positive number cannot remove this evidence gate. The earlier market tests
and development smoke run already inspected these price periods, so the report
records that the final period was previously viewed. Final prices are still
excluded from this learner's fitting and candidate-selection code.

This distinction is necessary: a strategy that knows today's revised headline
at its old publication date can appear profitable without being executable.

## Frozen protocol

- Fixed six calendar months, hourly public Binance BTC/USDT and other token/USDT
  candles through `data-api.binance.vision`. Every token uses exactly the same range.
- Three months for fitting, one month for candidate selection, two months for
  final evaluation. Training labels and their control observations must finish
  before the training cutoff. Each split starts in cash and closes at its end.
- V1 uses fixed conservative headline rules and a 24-hour horizon. Security and
  service incidents imply SHORT, protocol/adoption announcements imply LONG,
  uncertain/negated/resolved news implies HOLD. Macro releases with no defensible
  semantic direction remain HOLD.
- V2 learns separate directions per token and event group from training samples.
  Effects compare event returns with same-hour controls at offsets of 7, 14 and
  21 days in either direction. Controls must lie entirely inside the same split
  and cannot overlap known events. At most one overlapping observation per group
  is included. Shared issuer/category updates in six-hour blocks are deduplicated.
- The fixed search has **36 candidates per token**: horizons 4/24/72 hours,
  minimum examples 3/5/8, estimated cost buffers 1/2, uncertainty multipliers
  0/1.28. Validation selection requires three trades and a positive score:
  `net P&L - 0.25 × initial balance × maximum drawdown`. Otherwise V2 stays in cash.
  All candidate validation outcomes are retained, including losses.
- The target is **+100 USDT in the final split**, never a promise or a reason to
  change labels/costs, increase risk, or repeatedly select against final returns.
  Fewer than five final trades and failed double-cost/+1h-delay tests add explicit
  rejection reasons. Small-sample intervals and multiple trials are not robust
  evidence of a profitable strategy.

Price is used for reaction labels, controls, risk and simulated fills. Market
momentum features do not secretly choose news opinions. The frozen deterministic
taxonomy does not call an LLM or use current AI summaries, which could introduce
model world knowledge unavailable at the historical date. No extra AI charges or
provider credentials are needed for this study.

## Hypothetical positions and costs

Only one position per token/account is open at a time, capped at 20% of current
equity with no leverage. Quantity follows the captured exchange step/minimums.
The stop is 2.5% and target 5% from entry. Entry is the first hourly open after the
publication-time proxy plus five minutes. Exits use adverse-first OHLC logic:
if stop and target both occur, the stop wins. Gaps through a stop use the adverse
opening price. No historical limit-order queue fill is promised.

Fees are 0.1% at each fill and adverse slippage is 0.05%. Hypothetical collateralized
shorts charge 0.000003 of entry notional per started hour. Short sale proceeds do
not increase equity; only net P&L does. Actual borrowing availability, spreads,
liquidity and financing are unknown. Costs, conservative intrabar drawdown,
position P&L, account reconciliation and all split boundaries are validated.
Cash and costed passive buy-and-hold comparators are retained; passive exposure
is greater than the active strategy's 20% cap.

## Operation and persistence

A dedicated `news-research` container consumes `crypto-news-research-v1` with
concurrency one, two attempts and a bounded stall/retry policy. PostgreSQL freezes
the source snapshot and protocol before enqueueing. A 15-second reconciler
recovers queued/in-progress requests if enqueueing or a process was interrupted.
The same engine/window request is idempotent; final reports and progress receipts
are immutable. Completed reports remain accessible after restarts and new code.
Three new windows/engine versions per UTC day and at most 1,000 relevant events
per report bound resource usage. Exhausted retries remain visible as FAILED.

The research worker has the existing restricted news database/Redis credentials
and public-market access, but no model key or paper-ledger credentials. The live
market worker, its strategy bytes and original deadline remain independent.

New tables in the existing news namespace are `research_runs`, `research_events`
and `research_reports`. No existing article or market record is rewritten. The
market cache under `/var/lib/crypto-trader/news-research` stores hash-verified raw
captures and Parquet through the existing market-history repository. Bind-mount
it when recreating containers. Existing news-database dumps include research
tables; copy the cache alongside the database backup when migrating/restoring
complete reproducible research inputs. This is not an off-server backup.

The API under `/api/news/research/` inherits operator authentication, Origin
checks and rate limits. Readers can inspect; only operators start research.
The dashboard shows source coverage, trained rules, candidate outcomes, per-token
effects, LONG/SHORT trade details, fees, stops/targets and qualification reasons.
It filters positions by token/model/split/direction/outcome/publisher and sorts by
date or P&L. JSON/CSV/Markdown exports are explicitly whole-report exports.

The first development run used 2026-05-07 09:00 UTC to 2026-11-07 09:00 UTC. Of
1,157 collected records, 104 permitted dated records were in range and 25 relevant
deduplicated events remained. Historically timely versions: zero. The first V1
ETH final result was -121.88 USDT; selected V2 BNB and AVAX results were -14.98 and
-32.03 USDT respectively. Other V2 token models chose cash. The +100 target was
not achieved. These are retained preliminary descriptive results, not validation
of a tradable news strategy.
