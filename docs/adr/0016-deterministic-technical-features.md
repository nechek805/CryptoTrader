# ADR 0016: Point-in-time technical features with explicit warm-up

Status: accepted, 2026-11-01. Scope: Module 07, Iteration 1.

Add a strict, reusable technical feature query over frozen MarketBar evidence. The
declared history start fixes grid phase and recursive seed origin. At each as-of instant,
select only completed, eligible bars available by that instant and their latest known
revision. A bad latest revision invalidates the slot rather than resurrecting an older
price. Historical query values are reproducible even when later evidence is supplied.

Version each formula/config and define warm-up, input fields, variable source latency
and missing/NaN policy. Use an SMA-seeded EMA, population log-return volatility, an
actual preceding close for true range, mean-seeded Wilder ATR, prior-only relative-volume
and z-score references, and prior-only breakout bands. Reset recursive seeds after gaps.
Opening-price gaps and missing candle slots are separate. Keep null with explicit status
for warm-up, gaps, unavailable current candles and zero denominators/variance.

Private decimal arithmetic includes log/sqrt and explicit half-even output rounding.
Every value and row retains source/input IDs and close/availability watermarks bounded
by the feature timestamp. The input watermark is not a historical publication timestamp;
computation latency remains unmodeled. Coverage diagnostics and snapshot hashes remain
audit metadata rather than silently becoming features.

OHLCV supports candle-volume quality proxies only. Always disclose absent order-book
liquidity; do not infer spread, depth or executable size from candles. Immutable,
content-addressed JSON artifacts retain the feature catalog, input manifests, config and
software hash and are verified by semantic replay. Existing persisted schemas remain
unchanged; no new dependencies, SQL tables or provider fetches are needed.

This iteration provides single-series deterministic measurements. Cross-asset joins,
universe/regime logic and train/validation/test panels remain their numbered iterations.
No strategy, order, fill or performance claim is introduced.
