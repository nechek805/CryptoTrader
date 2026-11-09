# ADR 0064: free public archives and token-specific news V4

Date: 2026-11-08. Status: accepted.

The six-month V3 archive lacks sufficient material events and historical economist
consensus. Several public primary sources need no additional keys, but public
access does not establish historical article availability or a return edge.

Add fixed-endpoint Bybit announcement, Statuspage incident, GDELT discovery, XRPL
validated amendment and government archive adapters. Preserve source history and
insert-only defaults. Keep LLM processing off for notification metadata; V4 allows
documented factual metadata rules separately. GDELT remains discovery-only.

Define a new 36-month study: 24 training, six validation and six final evaluation.
All ten current tokens and USDT cash remain included. Hash-verified hourly prices
use six legacy six-month chunks per token; a new manifest/internal price view
avoids weakening legacy dataset bounds. Rerun V1/V2/V3 on common long inputs;
preserve original code, reports and six-month results separately.

V4 estimates token-specific signed event reactions. Macro features compare actuals
with the median of three earlier original releases, explicitly not market consensus.
Opposite feature signs share a token/event-type relationship; ten token responses
do not increase event counts. Keep 12/20 observations, approximate 95% uncertainty,
twice costs, 72-hour purging and five validation trades. Preserve negative outcomes
and cash fallback; do not tune against final P&L or force activity.

Separate V4 PostgreSQL tables freeze the seed, corpus, progress and reports. The
concurrency-one BullMQ worker routes V4 jobs explicitly. Retain compressed captures,
byte/parser hashes, real receipt times, pagination limits and source failures.
Bound requests/payloads and honor access denials. No extra keys or AI calls.

All results remain descriptive and unqualified for live use. Disclose previously
inspected final prices, current-universe selection, retrospective instrument
filters, unknown article revisions and assumed financing. Financial engine code
and live market worker containers are outside this change.
