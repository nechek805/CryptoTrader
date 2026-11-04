# ADR 0040: Hashable thirty-day protocol

2026-11-03 · Module 15 Iteration 1 · Accepted

Strict bounded YAML 1.2 produces a new forward-experiment-manifest.v1 wrapping the
unchanged canonical ExperimentManifest v1. Four model artifacts, their availability and
training cutoffs, adapter/right-review evidence, three spot instruments, equal virtual
capital, risk, costs, confirmation/delay rules, fixed opportunity calendar, uncertainty
and failure criteria are frozen. Alias/tag/duplicate-key/document-stream attacks fail.
The outer hash binds the protocol; the paper config replaces an explicit unbound
template sentinel with that hash, avoiding a circular hash. Changed code/parameters
produce a new ID; CLI freeze and launch compare the actual working-tree version.

Thirteen protocol acceptance/failure cases cover hash mutation, missing/future models,
unreviewed adapters/rights, time order, risk/calendar changes and synthetic/public
confusion. A hash verifies integrity, not authenticity of a provider's legal permission.
Manual rights evidence remains required; synthetic reviews never authorize public use.
YAML parser options follow https://eemeli.org/yaml/ (pinned yaml 2.9.1).
