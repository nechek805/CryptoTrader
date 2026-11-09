# ADR 0051 — Exclude trading fees from current market strategy tests

Date: 2026-11-04. Status: accepted at the user's request.

The current Market strategy tests comparison defaults to zero trading fees for every
coin and strategy, including the buy-and-hold comparator. Adverse slippage remains
0.05% per side plus price-tick rounding. No short, leverage, funding or account fees
exist in this spot simulator.

Replay all decisions with the effective zero fee, including entry sizing, cash debit,
realized returns and the v2/v3 reward-to-cost gate. Adding previously charged fees back
to a completed P&L is insufficient because eligibility, quantities and later positions
can change. Fee postings and fill fees are zero; the ledger must still reconcile.

Record optional `feeMode` in existing versioned market plans and matrices. New plans
use ZERO by default; absent metadata on historical v1 artifacts denotes STANDARD.
This additive optional field leaves old artifact content hashes intact. New source,
plan, report and matrix hashes identify the current research run. Raw data, dates,
starting capital and the signal parameters stay the same. Preserve all previous
paid-fee reports and the original BTC engines and reports.

Retain STANDARD mode for original-BTC compatibility checks. Verify that mode against
each frozen BTC engine separately from the current zero-fee BTC run. The dashboard
labels that reference check accurately, displays the active fee setting and keeps
slippage visible. Exact report verification uses the saved fee mode.

This request applies to the current multi-market research page. Historical BTC tests
and native frozen paper experiments keep their original cost assumptions and records.
The change does not establish a profitable strategy or relax forward availability gates.
