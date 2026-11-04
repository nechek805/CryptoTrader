# ADR 0043: Fixture-only optional extension, production deferred

2026-11-03 · Module 16 Iterations 1–3 · Accepted

RFC 0016 selects multilingual entity matching within Option D. The subsequent detached
prototype has local versioned schemas, synthetic-only input, temporal alias/article gates,
conservative ambiguity/confusable handling and no production imports or network/execution
capability. Evaluation labels are separate from matcher inputs. Independent reproduction
and boundary tests pass; known common-noun/company false positives remain in the report.

The evidence supports DEFER. docs/module16-decision.md records the exact future contract,
schema/replay, labelled-data/rights and new-experiment changes needed for adoption. Current
master contracts and frozen trials remain unchanged. All optional exploration iterations
are fulfilled; this is not a decision to implement all optional commercial/derivatives/ML
tracks. A real-money connector cannot be enabled by a flag and remains outside this project.
