# Historical news research without backdating availability

Date: 2026-11-07. Status: accepted.

The owner requested six-month news-only LONG/SHORT research for the full market
universe, targeting +100 virtual USDT per 10,000. Existing free feeds provide
archived content but not historically observed versions or dependable coverage
of all crypto events. No article publication date can replace its actual receipt.

Add a separate descriptive research page and bounded worker, preserving the
strict existing point-in-time news-fit API and active market-only forward run.
Use deterministic taxonomy and chronological development splits, retain all
36 candidate outcomes per token, and select only on validation. Record prior
inspection of final periods. Keep failing or cash-only results. Never search
indefinitely against final returns until a desired number appears.

Research models cannot qualify for forward use from these archives, regardless
of descriptive P&L. Publication-time proxy trades explain potential associations
only. Missing timestamps, source permissions, incomplete markets, borrow/fill
assumptions and low sample counts remain visible. New evidence is required to
claim a tradable historical edge.

Use the existing news PostgreSQL database for frozen requests, immutable reports
and progress events, and a dedicated BullMQ queue/container for bounded work.
Retain raw market captures and Parquet in a separate persistent bind mount.
Source collection, AI budgets, financial strategy files and the running paper
experiment are unchanged. New schema tables are additive.

Details and validation: [historical news research](../news-strategy-tests.md).
