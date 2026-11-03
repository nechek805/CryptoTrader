# Module 16 — Optional Extensions and Formal Live-Trading Gate

## Status
**Not part of the initial MVP.** This file records possible development tracks and strict decision gates, not permission to execute real-money trades.

## Option A — Dedicated ML Training Service
Only after credible rule-based baselines and enough clean point-in-time training records exist. Start with features frozen in TypeScript. An isolated Python process may train scikit-learn/LightGBM/PyTorch and export ONNX/JSON model metadata. Use explicit training snapshots, artifact hashes, calibration, out-of-sample tests, retraining cadence and rollback. The rest of the application remains TypeScript. Prefer a simpler interpretable model when performance is comparable.

## Option B — Derivatives Research
Add simulated perpetual long/short positions with mark price, index price, funding rates and precise application times, initial/maintenance margin, liquidation fees, borrow or market-specific constraints, auto-deleveraging scenarios and basis tracking. Validate against venue documentation and stress incidents. Do not imply `1x` futures eliminates liquidation or counterparty risk.

## Option C — Higher Frequency / Order Book Research
Research L2 market data, event-driven replay and inventory-aware market making. Requires stronger exchange timestamp semantics, sequence gaps, queue models, high-frequency execution assumptions, higher storage/network spend and realistic maker-fill simulation. Do not use candle data to claim tick-level fill certainty.

## Option D — Source-Graph and Causal Impact Research
Improve quotation-chain detection and multilingual entity matching. Track first-public reporting, revisions and market anticipation. Perform case-control event studies, time-to-recovery survival analysis, robust null comparisons and cross-asset lag tests. Do not claim causal effects from raw co-movement alone.

## Option E — Multi-Exchange Research
Add public data adapters, provider quality rankings, exchange-specific costs and instrument metadata. A replay with signals on one venue may not be executable on another due to spreads, latency or regional availability. Respect each API's terms.

## Option F — Commercial SaaS
Potentially offer research dashboards, backtest infrastructure and risk monitoring to customers. Before any managed automatic trading, paid signal products or handling client funds, obtain an appropriate jurisdiction-specific legal review, security audit, vendor/data licensing review and consumer disclosure plan.

## Hypothetical Live-Trading Readiness Gate — Separate Future Approval Required
No live connector should be implemented as a mere feature flag in the MVP. A distinct project authorization is required, including: regulatory/access eligibility, exchange terms, independent security review, disaster recovery, encrypted least-privilege trading keys (no withdrawals), human-controlled kill switch, reconciliation against the venue, max-loss limits, paper-to-live execution mismatch analysis, funding/liquidation tests, incident response and explicit risk owner sign-off. A month of good paper results is insufficient.

## Optional Iterative Prompt — Exploration Only
1. Draft an RFC comparing expected research value, cost, legal exposure and failure modes of a selected option. Do not implement.
2. Build a detached prototype using fixtures with an explicit boundary; independently test reproducibility and safety.
3. Present evidence for `ADOPT`, `DEFER` or `REJECT`, with exact changes needed to master contracts and experiment controls. Do not silently alter the current frozen protocol.
