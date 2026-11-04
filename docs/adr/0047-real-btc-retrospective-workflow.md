# ADR 0047: Guided BTC history test with explicit retrospective assumptions

The user requested a dashboard workflow using six months of real BTC hourly history and
10,000 virtual USDT. Historical public candles do not establish when those candles were
actually received. The existing point-in-time gates remain binding and are not relaxed.

The separate `btc-retrospective.v1` runner assumes completed-bar knowledge and next-open
execution. It does not feed the native forward paper broker or the synthetic four-arm
overview. Actual download times, original response bodies and hashes are retained;
historical availability remains UNKNOWN. Exact-decimal hourly candles are also stored in
an immutable Parquet artifact. Download failure cannot substitute fixture data.

The public market-data-only Binance host is fixed. Only GET time/klines requests are used,
without authentication, redirects, private account access or exchange order endpoints.
Requests have response, time and pagination budgets. Consecutive hourly coverage, candle
closure, timestamp units, OHLC envelopes and raw/normalized replay must validate.

The initial fixed MA20/MA50 rule uses ATR14 protective exits and conservative candle
execution assumptions. Initial eligibility permits entry if the first complete MA50
window is already bullish. No training or parameter search occurs. The strategy is spot
long/cash only, with no short exposure or leverage. Exact-decimal risk, allocation,
previous-volume participation and cash caps apply, with quantity rounded down. Fee and
adverse slippage assumptions are explicit. Stops precede targets in ambiguous candles;
gap exits may exceed planned risk. Intrabar execution and liquidity remain assumptions.

Strategy, cash and costed buy-and-hold share the same history and warm-up boundary.
Comparators have different exposure; open positions are marked without charging a
hypothetical exit. Metrics identify these limitations rather than claim predictive skill.

The runner uses the shared balanced SpotLedger, reconciles every posting and freezes the
full decision/fill report, journal hash, plan fingerprint and engine source fingerprint.
Startup serves a cached report only if it reproduces under the current engine. Older
artifacts are retained; they cannot silently become current results after a code change.

Authenticated local readers may start these bounded research jobs. Existing admin-only
forward paper controls retain their authorization boundary. The BTC jobs are unavailable
in deployment mode. One in-process job runs at a time; restart does not resume a partial
download or replay. Published immutable datasets/reports are recovered and verified.

The new `/market-test` page shares the dashboard shell and automatic local session, with
three steps: source inspection, frozen-assumption review, and candle-level decision/fill
inspection. Charts and calculations come from validated backend artifacts. The page labels
real history and retrospective virtual execution separately from synthetic examples.

See [the walkthrough](../btc-market-test.md) for the first real snapshot and repeatable checks.
