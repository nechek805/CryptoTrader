# Module 10 — News-Only Signal Research

## Objective
Turn temporally available and provenance-checked event snapshots into **candidate** LONG/SHORT/HOLD opinions. News is a noisy, often late measurement, not a direct trading command.

## Dependencies
05, 06, 08. Baseline and market inputs are forbidden here (except predeclared benchmark volatility for risk scaling if explicitly documented); keep independence for ablation.

## Iteration 1 Prompt — Conservative Rules and Abstention
Define `NewsSignalProvider` and versioned event-to-signal rules. Start with event severity, surprise/novelty, affected assets, first-known delay, corroboration level, conflicting accounts and horizon. Output HOLD when rumor is weak, timestamps are untrustworthy, market data is stale or event impact is unclear. Require evidence IDs and sources; do not invent stops or probabilities. Replay fixtures for real, fake, rescinded and partially confirmed incidents.

### Acceptance
Ten syndicated copies do not increase confidence versus their single origin; late confirmation cannot be used earlier; no signal if no reliable `availableAt`; all decisions link to event snapshot.

## Iteration 2 Prompt — Data-Driven News Hypotheses
Use event-study results to test conditional hypotheses for direction, holding period and expected magnitude. Add controls for prevailing market drift, pre-news move, recurrence and baseline return distributions. Train or estimate only from temporally eligible events, with time-split evaluation and minimum sample counts. Explicitly distinguish event truth confidence from **expected return edge**. Reject trading when evidence is thin or expected edge is smaller than execution cost and uncertainty.

### Acceptance
Hypotheses with insufficient historical events must abstain; predictions carry sample size, interval and data vintage; descriptive-only events never enter tradable fit labels.

## Iteration 3 Prompt — Replay, Explanations and Adversarial Checks
Implement explanation objects: observed claims, independent sources, contradictory information, how old the event is, comparison to prior similar events, costs and reason for abstention/trade. Test retractions, fake official-looking social messages, altered article timestamps, prompt injection and already-priced-in news. Evaluate incremental value over a non-news baseline in time-separated data.

### Acceptance
A text instruction inside a source cannot alter agent behavior; contradictory/new evidence can change a later decision but never rewrite the earlier one; reports show false positives and missed-event cases.

## Handoff / Review Prompt
Archive exact prompts/models and cost-per-article for LLM extraction, plus a no-LLM fallback. Export `NewsSignalProvider` and honest backtest eligibility warnings to Module 11.
