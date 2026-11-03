# Hypothesis registry and time validity

Module 06, Iteration 3 completes the descriptive event-research handoff. Cards record
thesis, taxonomy, expected direction/horizon, source/instrument, assumptions, first-seen
eligibility, periods, biases, predeclared tests and author state. Evaluations add actual
sample counts, conditional uncertainty, contradictory examples and a computed final
status. No card or event label generates a trading signal, SHORT rule or order.

## Reproducible commands

Use pinned Node 24.22.2 / pnpm 10.34.9 as described in the README:

```powershell
pnpm study hypothesis-fixture
pnpm study hypothesis-verify --artifact 'data/hypothesis-registry/hypothesis-registry_<printed hash>.json'
pnpm study hypothesis-report --artifact 'data/hypothesis-registry/hypothesis-registry_<printed hash>.json'
pnpm study hypothesis-inputs --artifact 'data/hypothesis-registry/hypothesis-registry_<printed hash>.json' --at 2026-01-25T00:00:00Z --purpose NEWS_STRATEGY_RESEARCH
```

`hypothesis-fixture` writes a self-contained, content-addressed machine-readable registry
and prints its absolute path. `hypothesis-report` semantically verifies it before
printing a notebook-style Markdown report. For clean redirected JSON use the Node entry
point, which omits pnpm's command banner:

```powershell
node --import tsx apps/cli/src/event-study.ts hypothesis-inputs --artifact 'data/hypothesis-registry/hypothesis-registry_<hash>.json' --at 2026-01-25T00:00:00Z --purpose TRADABLE_BACKTEST_INPUT | Set-Content 'data/hypothesis-registry/news-strategy-inputs.json' -Encoding utf8
```

This produces temporally eligible **research inputs**, not a backtest, strategy or trade.
The existing operational health and study/control APIs remain unchanged.

To reproduce or modify a local design, export the registry's `input` and `request`:

```powershell
$registry = Get-Content 'data/hypothesis-registry/hypothesis-registry_<hash>.json' -Raw | ConvertFrom-Json
$registry.input | ConvertTo-Json -Depth 100 | Set-Content 'data/hypothesis-registry/input.json' -Encoding utf8
$registry.request | ConvertTo-Json -Depth 20 | Set-Content 'data/hypothesis-registry/request.json' -Encoding utf8
pnpm study hypothesis-build --input 'data/hypothesis-registry/input.json' --request 'data/hypothesis-registry/request.json'
```

The dataset includes verified news snapshots, existing strict MarketBar records, optional
market snapshot manifests and explicit observation pointers. Public interfaces live in
`packages/contracts/src/hypotheses.ts`. No provider is contacted; real local evidence is
optional and must retain its original provenance and availability. Unknown availability
must use the historical descriptive record variant. Files are limited to 64 MiB; request
and revision JSON are limited to 16 KiB. Analysis bounds are 250,000 price points and
500,000 resampled unit draws. Split larger designs into explicitly recorded studies.

## Versioned cards and period policies

Each `hypothesis-card.v1` has an ID, sequential revision, previous hash, recording time,
author, revision reason and full content hash. Registry histories reject mutation,
forks, missing parents, duplicate revisions and recording-clock reversals. Changing a
card creates a new immutable registry; prior files are never replaced. Publication uses
a synced staging file and atomic no-replace link. Verification rebuilds news semantics,
card history, every sample, interval, finding and input/config hash. Artifacts record the
working-tree software hash, seeded random algorithm, generation/cutoff and clock version.
Old study/control contracts and artifacts remain compatible. No SQL migration is needed.

To revise a card, create JSON containing `expectedPreviousHash`, `author`, `reason` and
the new complete `content`, then run:

```powershell
pnpm study hypothesis-revise --artifact 'data/hypothesis-registry/hypothesis-registry_<hash>.json' --revision 'revision.json'
```

The CLI assigns revision number, previous hash and current recording time; the request
cannot backdate them. An expected-head mismatch rejects stale writes. Imported card
histories still contain author assertions: local hashes are integrity checks, not
externally authenticated proof of historical pre-registration. Synthetic chronology is
explicitly fictional. Any real prospective-registration claim needs independent evidence.

Selection and final-validation periods are explicit half-open ranges. A decision must
lie in its phase and its complete response must end by the phase boundary. The card's
latest recording time must precede validation start for a separate-period evaluation.
Overlapping periods, event lineage shared between phases, or a freeze after validation
starts require a nonempty `reuseDisclosure`; otherwise registry construction fails.
Disclosed reuse is always `EXPLORATORY_REUSE`, never independent validation. Reports keep
the exact reasons and disclosure. Revising a thesis after seeing validation cannot reset
the clock or erase an earlier version.

Every card predeclares gross or assumed-cost net as the primary metric, minimum units
(at least three) and a nonnegative directional threshold. Author state is DRAFT,
REGISTERED or RETIRED; computed final statuses are separate. Synthetic support remains
`SYNTHETIC_ONLY`. Contradicted direction/threshold tests retain `NEGATIVE_FINDING` and
observation IDs for contradictory examples; insufficient data and inconclusive intervals
are explicit. Net here means price return less an assumed round-trip cost, not simulated
PnL or evidence that a fill was available.

## First-seen quality and price availability

Point-in-time observations reference an event ID and exact decision in a semantically
verified news snapshot. Context and taxonomy are rebuilt at that decision; future
official status, curator decisions or corrections cannot appear in earlier features.
First-seen quality is derived from the canonical source claims, not accepted as a caller's
promotable label. Unavailable, inactive or non-replay-eligible contexts are quarantined;
card quality/verification rules may exclude additional records.

`HISTORICAL_DESCRIPTIVE` has literal `researchUse: DESCRIPTIVE_ONLY` and estimated/unknown
first-seen quality. Its archive provenance and reason remain visible, but no return is
invented and it never enters measured sample means, uncertainty intervals or tradable
backtest inputs. A timestamp printed in an old article is not a defensible receipt time.
Archive records are not visible before capture; future event observations are not shown
at an earlier analysis cutoff.

Price returns reuse the exact-close gate from Iteration 1: source/instrument/interval
must match, each consecutive close must be available at its own simulated decision and
the response must be observable by analysis cutoff. Gaps, stale/estimated prices, a late
endpoint, an unfinished response or a response outside its sample period leave metrics
null. Reports distinguish these cases and preserve evidence IDs and missing closes.

## Counts and statistical uncertainty

Reports show all included records, complete measured responses, quarantined records and
lineage/window units separately for selection and final validation. Connected shared
event lineage or overlapping outcome windows form one block. The estimand is the mean
of equally weighted block means, avoiding extra weight from repeated reports about one
event. Calling these blocks independent units is a sampling assumption, not proof that
separate dates, publishers, assets or market regimes are independent.

With at least the predeclared minimum units, a versioned seeded block bootstrap resamples
unit means with replacement (200–2000 draws). Confidence intervals use sorted percentile
endpoints. Bonferroni nominal levels cover both reported phases across every latest card:
family size `2 * cardCount`, per-interval level `1 - 0.05/familySize`, tail index
`floor((drawCount-1)/(40*familySize))`. The reported family target is nominal; bootstrap
coverage with tiny selected/dependent samples is not guaranteed. Each phase's seed is
the root seed XOR the first 32 bits of the canonical hash of `{cardHash, phase}`.
No interval is produced with insufficient units; its reason is explicit.

These are **conditional resampling intervals**, not causal identification, population
guarantees, calibrated trading probabilities or protection from unreported searches.
Selection biases and contradictory examples remain part of every card/report. Constant
synthetic prices can give a zero-width interval; that says nothing about real-world
population uncertainty. Broader validation across regimes and real event collections is
still required before making any general claim.

Causal claims require an explicit claim type and documented design, identification
assumptions, evidence references and reviewer. A conservative thesis-language guard
also rejects common causal wording in an association-only card; it is not a general
natural-language fact checker. Even with supplied justification, this observational
engine returns `CAUSAL_REVIEW_REQUIRED` and excludes that card from strategy handoff.
It does not certify identification from formatted text or a price correlation.

## Synthetic reports and News Strategy handoff

The fixture has fifteen fictional observed events in three groups plus three archives
with unknown first-available times. Two observed events per group lie in selection and
three in final validation; a fictional card freeze lies between the periods. Each group
has its own RSS ingestion, deterministic extraction, news hash-chain snapshot and
explicit ETH minute-price path. No real imports, model calls or actual pre-registration
are implied.

| Card                            | Validation gross returns | Conditional interval | Result                                          |
| ------------------------------- | ------------------------ | -------------------- | ----------------------------------------------- |
| Exchange outages, expected DOWN | -0.04, -0.02, -0.01      | [-0.04, -0.01]       | Synthetic support only                          |
| Rate announcements, expected UP | 0, 0, 0                  | [0, 0]               | Negative finding: expected positive move absent |
| Listings, expected UP           | -0.01, 0.02, -0.03       | [-0.03, 0.02]        | Inconclusive, with contradictory examples       |

The published fixture uses 1,000 resamples and root seed 42. Each validation report
shows four records, three measured units and one quarantined archive; selection has two
units and an unavailable interval. Costs are ten assumed basis points and remain separate.

`hypothesisNewsStrategyInputs` returns only event context and card versions already known
at **each event's own decision**. Selection events before card registration have no
eligible card. A later revision cannot be applied retrospectively to an earlier event.
The handoff excludes returns, confidence intervals and final findings and retains source
IDs, context hashes, first-seen quality and abstention reasons. Descriptive archives are
always quarantined, including for `TRADABLE_BACKTEST_INPUT`. Default action is HOLD.
Consumers must use `validateHypothesisHandoff(registry, input)` for semantic verification,
not merely parse a caller-supplied row with an optimistic eligibility label.

Module 06 stops here. The next authorized iteration is Module 07, Iteration 1:
deterministic technical features. News Strategy implementation is a later roadmap module;
this handoff does not implement it.
