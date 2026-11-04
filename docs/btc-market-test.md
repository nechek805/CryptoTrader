# BTC market-only historical test

Start the dashboard with the pinned local runtime (`pnpm dashboard`), then open
<http://127.0.0.1:3100/market-test> or select **BTC market test** in the sidebar.
This local research page opens without a token prompt. It uses public market data and
virtual capital; no exchange account is connected.

1. **Load history.** Inspect the existing snapshot or download a fresh six-calendar-month
   window ending at the latest completed UTC hour. The screen shows the exact range,
   coverage, close-price chart, source request URLs, actual receipt times and hashes.
2. **Review & run.** Read the fixed strategy, risk and cost assumptions. Select
   **Run market-only test**. This starts one bounded local research job. Replaying the
   same frozen inputs does not constitute a new independent trial.
3. **Inspect decisions.** Review the full-period comparisons, then use **Next hour**,
   **Next signal or fill**, or the candle slider. Each hour shows completed-candle
   features, LONG/HOLD/EXIT, planned quantity, open-position stop/target, cash, BTC and
   fills. LONG/EXIT orders fill at the following open, not at the signal close. A fill
   can have a smaller quantity after the opening-price risk and cash checks. Protective
   exits can happen within the entry hour under adverse-first assumptions.
4. Select **Verify deterministic replay** to reconstruct the report and compare hashes.
   Export the frozen JSON report for independent review. Full raw responses, Parquet and
   the balanced journal remain under `data/btc-market-test/`, which is git-ignored.

## Frozen assumptions

- MA20/MA50 crossover, including bullish eligibility at the first full MA50 window;
  simple ATR14, stop 2 ATR and target 3 ATR. No news, ML fitting or parameter search.
- 10,000 virtual USDT; risk budget 0.25% per entry including estimated round-trip costs;
  allocation at most 10%; at most 1% of the previous completed candle's BTC volume.
- Spot LONG/cash only; bearish exits and HOLD are supported. Short opening and leverage
  are disabled. A 2% daily marked loss blocks new entries until the next UTC day.
- Next hourly open with 0.10% fee and 0.05% adverse slippage per side. Price tick 0.01
  USDT, quantity step 0.00001 BTC and minimum notional 5 USDT are static research
  assumptions, not claims about verified historical exchange filters.
- Stop first if stop and target both touch; gaps use the worse opening price. Target
  exits are hypothetical market exits, not guaranteed limit fills. No last-candle order
  is filled without a following candle. Intrabar exits are assigned candle-end minus
  one millisecond for journal ordering; these are assumed times, not observed trades.
- Cash stays at 10,000. Buy-and-hold enters with available cash at hour 51, after the
  same 50-candle warm-up, and includes entry costs. Both strategy and buy-and-hold mark
  open BTC at closes without hypothetical exit costs. Exposure differs substantially.

## First real validation snapshot

Downloaded on 2026-11-03: **4,416 consecutive hourly candles**, from
**2026-05-03 18:00 UTC** through **2026-11-03 18:00 UTC**, end exclusive.

Dataset fingerprint:
`sha256:1d08092e9fdb3b26d39a8c6abb2ea9914b91b6d23f63d8a21d1ec80972d0b517`.

Verified report:
`sha256:4fd23448d0a3cc67dcedcdf8e7dd003930fb35e1282c46cb251dd8292f8fafb3`.

The fixed strategy ended at **9,929.2994294374 USDT**, net **−70.7005705626 USDT**
(−0.707005705626%), with 50 closed trades, 23 wins and no open BTC. Fees were
99.5757957626 USDT; adverse slippage embedded in prices was 49.7946347 USDT. Hourly
maximum drawdown was about 0.8396%. Costed buy-and-hold ended at 9,500.276454474 USDT.
These are descriptive results for this range and implementation, not independent
out-of-sample evidence or a recommendation to trade BTC.

## CLI and API

```powershell
pnpm btc-test download
pnpm btc-test run
pnpm btc-test verify
pnpm btc-test status
```

The CLI uses the same on-disk workspace as the dashboard. Run it while the dashboard
is stopped; the API keeps its active dataset/report in memory. Restart the dashboard
after external CLI changes. One API process owns each local research workspace.

Authenticated local endpoints: GET `/btc-test`, `/btc-test/data`, `/btc-test/report`,
`/btc-test/export`; POST `/btc-test/download` with `{}`, `/btc-test/run` with
`{"datasetId":"sha256:..."}`, and `/btc-test/verify` with `{}`. Browser calls go through
the dashboard's `/api` proxy. Mutation requests require a permitted Origin for cookie
sessions. Clients cannot supply URLs, paths, private credentials or arbitrary job plans.
The complete report is bounded to 6,000 hourly decisions; the fill table is paginated.

Completed datasets and reports are immutable and recovered on restart. In-progress
jobs are in-memory and must be retried after restart. Corrupted published artifacts
fail verification; they are never overwritten with replacement prices or balances.
Earlier engine artifacts remain retained but are not served as current replay results.

## Interpretation and verification

The official [market-data-only host](https://developers.binance.com/en/docs/products/spot/faqs/market_data_only)
requires no API key. Public access does not imply unrestricted redistribution; source
rights and provider terms still apply to any later sharing or commercial use.

Historical availability is **UNKNOWN**. This retrospective runner assumes each bar was
knowable at its close; it does not weaken native point-in-time gates. Actual publication
delays, spread/depth, partial fills and historical filter changes cannot be reconstructed
from hourly candles. Stops can gap; hourly drawdown misses intrabar losses. The next
research stage requires a newly frozen forward experiment with actually observed inputs.

Meaningful checks cover time ranges, candle validation, raw/provenance tampering,
no-lookahead behavior, next-open fills, risk/cash caps, ambiguous exits, gaps, tiny-volume
rejection, terminal orders, exact-decimal Parquet integrity, deterministic journal replay,
provider failures, auth/Origin boundaries and rejection of arbitrary URLs/paths.
