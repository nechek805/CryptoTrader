# RFC 0016: Detached multilingual source-entity matching

2026-11-03 · Module 16 Iteration 1 · Reviewed for fixture exploration only

The Module 15 synthetic findings recommend REVISE_AND_RESET: few trades, adverse gap
losses, interrupted operation and no elapsed public month. This RFC selects a bounded
subtrack of Option D: multilingual source-entity matching. No live connector, derivatives,
commercial product, new current strategy or frozen-protocol change is proposed.

Research value: a versioned multilingual alias table can expose missed entity mentions
and false merges in source graphs. Availability-gated aliases permit as-of comparison;
ambiguous aliases should abstain. Better recall is not independent corroboration, factual
truth, causality or profitability. The hypothesis belongs in a new future study only.

| Approach                                                        | Expected value                   | Cost                                                       | Legal exposure                           | Failure modes                                                               |
| --------------------------------------------------------------- | -------------------------------- | ---------------------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------- |
| Exact versioned aliases, NFKC and conservative token boundaries | Interpretable error inventory    | Small TypeScript fixture prototype; no service             | Locally authored synthetic examples only | Common nouns/company names, omitted languages, script/case normalization    |
| Learned multilingual entity linker                              | Potential context disambiguation | Labelled corpus, model/runtime and calibration             | Corpus/model terms and retention review  | Domain shift, hallucinated identity, post-cutoff model knowledge            |
| Production source-graph integration now                         | Potential coverage increase      | Contract migration, replay validation and experiment reset | Provider/language/source review required | Silent provenance changes, retroactive aliases and contaminated comparisons |

Iteration 1 decision: permit an isolated fixture-only exact-alias prototype, with a
separate local schema and executable synthetic tests. Do not import it into apps or
production packages. Do not fetch content or train a model. Keep common-noun/company
false positives in the report; fixture performance cannot justify adoption.

Iteration 2 acceptance: deterministic hashes in two independent invocations; no future
aliases/articles; ambiguous terms abstain; confusable scripts are not silently merged;
malicious prose stays data; public-origin input fails; production imports remain absent.

Iteration 3 will choose ADOPT/DEFER/REJECT from the retained evidence. Future integration
would require a new versioned EntityResolution artifact (alias snapshot/model hash,
cutoff, occurrence source/version hashes, ambiguity/abstention and correction lineage),
an explicit news-graph algorithm/schema version and replay migration, new error-stratified
labels and null controls, provider/language rights review, and a newly frozen experiment
ID. No edit to project_roadmap or the current experiment is authorized by this RFC.

The formal hypothetical live gate remains outside this project. There is no feature flag
that enables real trading. Separate future authorization and all legal/security/ownership
reviews described by Module 16 remain prerequisites to even considering that project.
