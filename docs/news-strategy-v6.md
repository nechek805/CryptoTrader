# News V6: independent changes to the V2 baseline

The default `/news-strategy-tests` tab compares V1 through V6 with fees on.
V4, V5 and original six-month studies remain selectable. All ten crypto tokens
are evaluated separately; USDT remains the cash control.

## Frozen inputs and baseline

Parent V5 run: `a91716ee-8374-4ef3-a10c-e69357143b05`.
Parent report:
`sha256:bb09ca42bbd12dd7f95f16e5d7cb8e10ed6b062730f252464486afcadbd64cb2`.
Its V4 parent is `57fb2088-801c-40d7-97fb-8877c79fc08c`.

Use the exact 2,504-record V4 corpus and 60 content-addressed hourly market
chunks. The price window is 2023-11-07 09:00 UTC to 2026-11-07 09:00 UTC, split
24 months training, six months validation, six months final evaluation. There
are no source collections, replacement downloads or current-price pointers.
Missing or corrupt inputs fail closed.

V2 events are reconstructed with the unchanged frozen `legacyHistoryEvents`
function, not from the combined legacy/V3 display-event list or the V5 event
taxonomy. Fed `MONETARY_POLICY`, `MONETARY_POLICY:EASING` and
`MONETARY_POLICY:TIGHTENING` remain separate. Every arm receives the same V2
event objects, permissions, publication proxies and non-event control universe.

Before any comparison is accepted, the complete V2 model is reproduced and
checked against the stored parent: selected configuration, training rules,
36 candidate records, all three account evaluations, cost/delay stresses and
model hash. A mismatch aborts the study. Every V1–V5 row/model and inherited
input field is preserved exactly; a checked projection removes only new V6
fields and its added model to recover the original parent.

## One change at a time

These four cases are frozen before the full real-data replay:

| Case                     | Only changed rule                                                                          | Preserved                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| V2 baseline              | None                                                                                       | Complete original V2 algorithm and model                                         |
| Uncertainty only         | Set the standard-error multiplier to 1.28                                                  | V2 selected horizon, minimum samples, cost buffer, events and controls           |
| Category validation only | Retain a V2 category after at least three positive aggregate normal-cost validation trades | V2 configuration and training estimates; no double-cost veto or changed taxonomy |
| Selection penalty only   | Subtract half the largest validation win when ranking the same 36 candidates               | Entire V2 candidate grid, fitting, events, controls, costs and fills             |

The category test requires positive category total P&L, not three individually
winning trades. Each category is replayed alone using the full event list and
one active rule; these isolated category accounts can overlap and must not be
added into the combined account. Rejected category rules become HOLD. Training
means, sample counts, standard errors and configuration remain unchanged.

The selection-penalty test can choose different hyperparameters because its
only changed algorithmic rule is candidate ranking. All 36 candidate validation
P&Ls remain identical to V2 and both sets of scores are reported. It does not
introduce a different grid or fit additional price-based signals.

Each case starts independently from V2. V6 never applies an uncertainty gate
and category gate together. The unchanged case remains a valid outcome.

## Selection and chronological diagnostics

V6 chooses one standalone case using validation only:

`validation net P&L - 2500 * validation drawdown - 0.5 * largest validation win`.

At least three validation trades and positive score are required. Equal scores
prefer unchanged V2, then the declared case order. Otherwise V6 holds cash.
Final-period P&L, final costs/delay stresses and the final target flag do not
select a case. Tests change all final prices and remove final news without
changing selection. A profitable rejected case stays visible in the dashboard.

Each case also has three chronological two-month validation diagnostics.
Training estimates stay frozen, but the configuration and optional category
gate were selected using the whole six-month validation period. These slices
are therefore in-sample stability views, not decisions known at each slice's
start or refitted walk-forward tests. Each starts at 10,000 virtual USDT and
closes positions at its own boundary. They are not independent evidence and
their P&Ls need not sum to the continuous six-month validation account.

Four case-selection scores are reported alongside the original 36 candidate
trials and every category validation check. Those are adaptive multiple
comparisons, not four independent scientific experiments. No final-period
threshold search, per-token exception or selection of the final winner is used.

## Execution and interpretation

Financial assumptions stay exactly at the parent's settings: 10,000 virtual
USDT per token/version/split, 20% allocation, 0.1% fee per fill, 0.05% adverse
slippage, assumed short borrowing 0.0003% per hour, 2.5% stops and 5% targets.
Publication plus five minutes rounds forward to an hourly open. Existing
conservative gap/stop/target and quantity-grid arithmetic is unchanged. Slippage
is embedded in prices, not charged twice. No real exchange order is created.

Historical publication/receipt vintages remain unverified, final prices have
already been inspected and the token universe was selected using current
tokens. All results remain descriptive with `qualifiedForForwardTest: false`.
V6 can underperform V2. Stricter filtering is not automatically an improvement.

## Completed production comparison

Run `7764c794-c23f-4e64-9c17-09fd4f0b8c3d`, completed 2026-11-08.
Report:
`sha256:37e3e39695ca1075d094aea659a927ae50d084dfdc00f322ef7d59bf617c345b`.
Engine:
`sha256:39bca38dfdb19cbffe25202a06eed427dc072f920bdad2d296219f7e1eb52f2d`.
All ten V2 baselines reproduce exactly. All V6 model objects match the local
replay. There are 179 original V2 events; no V5 regrouping is used.

Final six-month net USDT, each token/version starting independently at 10,000:

| Token     |      V2 |      V5 | Selected V6 | V6 selection             |
| --------- | ------: | ------: | ----------: | ------------------------ |
| BTC       |  +43.66 |    0.00 |        0.00 | Cash                     |
| ETH       | +161.56 |    0.00 |     +161.56 | Category validation only |
| SOL       |  +85.48 | -180.09 |      +85.48 | Unchanged V2             |
| TRX       | -284.88 |    0.00 |      -81.46 | Category validation only |
| BNB       |  -16.10 |  +38.72 |     +173.78 | Category validation only |
| XRP       |  -28.05 |  -25.99 |      -28.05 | Unchanged V2             |
| DOGE      |   +6.86 |   +6.86 |       +6.86 | Unchanged V2             |
| ADA       | +277.59 | +117.13 |     +277.59 | Unchanged V2             |
| LINK      |  +97.77 |  -36.10 |      +97.77 | Unchanged V2             |
| AVAX      | +253.41 | +118.01 |     +253.41 | Unchanged V2             |
| USDT cash |    0.00 |    0.00 |        0.00 | Cash control             |

Category validation removes BNB's jobs shorts while retaining its inflation
longs and Fed shorts. It also removes TRX's jobs shorts, but the remaining
inflation longs still lose money. ETH rejects a category that lost validation
money but did not trade in the final period, leaving its final P&L unchanged.
None of these decisions was selected using the final contributions.

Uncertainty-only changes often abstain and reduce SOL's final result to -34.08;
its validation score loses to unchanged V2, so V6 does not select that case.
BNB's uncertainty-only case earns +38.72 but has a lower validation score than
its category-validation case. Ranking by the concentration penalty retains the
same final result as V2 on nine tokens and abstains on BTC. BTC's original V2
validation score becomes -6.96 after the winner penalty; its later +43.66 final
profit remains visible and cannot select a case with hindsight. The unchanged
case wins ties on ADA, AVAX, SOL, XRP, DOGE and LINK. TRX and XRP remain negative;
V6 is not a promise of profit for every token.

The full check passed 1,195 tests in 70 files on pinned Node 24.22.2; doctor,
production builds and 26 real database/queue integration tests passed. Production
checks verified exact old reports, common inputs, all account/fee sums, local/server
model equality, source settings, idempotency and the served UI bundle. JSON/CSV/MD
exports include all cases and splits; the CSV has 3,584 simulated positions.
A new backup restored six reports, two corpora and 46 source configurations.

## Dashboard, storage and operations

The six-version matrix preserves the old results. An additional all-token
matrix shows every single-factor final result and the validation-selected case.
Per-token evidence shows validation/final deltas, normal fees, double costs,
extra-hour delay, chronological diagnostics and category decisions. Each case's
positions can be inspected with the existing token/split/direction/outcome/source
filters. JSON, CSV and Markdown exports include every case; CSV/Markdown case
labels use `LEARNED_V6/<case ID>` to distinguish independent accounts.

New immutable `research_v6_runs`, `research_v6_reports` and `research_v6_events`
tables preserve earlier storage. BullMQ jobs carry `kind: v6`; completed retries
reuse evidence. API requests allow only an optional completed V5 parent ID;
they cannot override dates, fees or experimental thresholds. Existing admin,
Origin, read access and daily-budget controls remain active. Parent conflicts
are rejected instead of silently returning a different frozen study.

Only news API, historical research worker and web are deployed. Collectors,
analyzers, source settings, financial engines and live paper services are
preserved. The news Docker build disables disposable webpack disk caching via
a build-only flag to avoid filling the small server disk; normal web behavior
is unchanged.
