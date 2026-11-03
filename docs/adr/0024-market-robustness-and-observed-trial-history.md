# ADR 0024: Market robustness and observed trial history

Date: 2026-11-01

Status: Accepted

## Decision

Use a frozen, bounded producer/scenario plan and log the complete matrix before the
first execution. Preserve failed cells in reports, family accounting and the synced
hash-chain journal. Storage failure interrupts publication and retains its stage;
refuse to bypass unfinished local history. Changes create new plan/model identities.
Continuations verify their parent receipt, retain its observed family floor, and use
a new experiment version. Keep the development experiment as an actual parent rather
than pretending its already observed results were never tried.

Evaluate rules, parameter perturbations and genuinely retrained feature ablations on
one fixed synthetic stress design. Reuse independent immutable cash/buy-and-hold
evidence per scenario. Preserve raw model candidates and expire them at their original
horizon; use a separately identified long-only execution projection. A two-bar forecast
can expire before a full-window spot fill. Retain that failure and train a distinct
three-bar/band version instead of silently lengthening its lifetime.

Rank by mean net return less worst sampled drawdown and downside empirical cell tail.
Publish every cell, negative outcome, parent/variant disagreement and uncertainty.
Use joint circular time blocks for conditional mean-net diagnostics, preserve serial
and cross-series alignment, and apply Holm adjustment with conservative padding for
prior, failed and imported calibration attempts. Block/sample/resolution gates remain
explicit. No unconditional FWER, calibration or alpha guarantee is claimed.

Select at most two research candidates under a frozen rule; allow zero. Synthetic
evidence cannot promote a model. Archive every discarded version with source/model/
feature fingerprints and require a new forward experiment for any later promotion.
Publish separate Module 11 handoff/archive receipts in bundle v2 while preserving
semantic verification of the recorded development v1 bundle.

Export a structural MarketSignalProvider interface with the compatible constructor
value. Add a strictly content-addressed, byte-bounded cache for small immutable feature
rows so repeated frozen trials avoid redundant calculations. Cache hits cannot bypass
input parsing, identity validation, replay prefix visibility, query budgets or traces.

## Consequences

The default 96-cell experiment is a sparse counterfactual BTC/ETH/SOL fixture, not
independent historical evidence. Twelve forward bars cannot satisfy the minimum-block
inference gate. Positive average returns do not override negative risk-adjusted scores,
and inactive zero-return controls are not eligible candidates. All versions can be
archived without selecting a winner. External undeclared research attempts cannot be
authenticated. No new third-party version, SQL migration or execution endpoint is needed.
News research, fusion, broad risk and paper promotion remain later modules.
