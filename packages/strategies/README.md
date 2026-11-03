# @crypto/strategies

Market-only interpretable providers and fixed target sizing are implemented in Module 09
Iteration 1. Exports include MarketSignalProvider, createMarketStrategy, MarketOnlyContext,
MarketStrategy and sizeMarketTarget. Public inputs are validated by @crypto/contracts.

Providers emit immutable candidates through the causal replay kernel. News access and
execution accounts are absent from their context. Symmetric short targets are synthetic
diagnostic signals only; all costed execution remains owned, unlevered spot.

Iteration 2 adds trainMarketModel, inferMarketModel and createMarketMlStrategy, plus
immutable model bundles. Training consumes verified frozen Parquet; scaling uses only
TRAIN and calibration only VALIDATION. Earlier historical predictions are retrospective,
and candidate inference rejects decisions before the model's declared availability.

See [market baselines](../../../docs/market-baselines.md), [market ML](../../../docs/market-ml.md)
and ADRs 0022/0023. Iteration 3 exports the structural MarketSignalProvider port while
preserving its constructor API; see [market robustness](../../../docs/market-robustness.md)
and ADR 0024 for observed-trial accounting, rankings and archive/handoff rules.
Module 10 Iteration 1 adds NewsSignalProvider, defaultNewsSignalConfig and the separate
deriveNewsFreshness veto adapter. News rules read only known event evidence; the adapter
exports timestamp/source eligibility without market prices or direction. See
[news signals](../../../docs/news-signals.md) and ADR 0025. Iteration 2 adds trainNewsEdge
and EstimatedNewsSignalProvider over frozen, controlled event-study estimates with
chronological validation and cost/uncertainty abstention. See
[conditional news hypotheses](../../../docs/news-edge.md) and ADR 0026.
Iteration 3 adds explainNewsSignal/explainNewsDecision, immutable evidence descriptions
and an offline adversarial/held-out evaluation handoff. See
[news replay and handoff](../../../docs/news-audit.md) and ADR 0027.
Fusion, general risk and forward promotion remain later work.
