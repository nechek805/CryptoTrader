# Module 16 exploration decision: DEFER

2026-11-03 · Option D multilingual entity subtrack · All three exploration iterations
completed. RFC 0016 was reviewed before the detached prototype. No current model,
strategy, source-graph schema or frozen experiment was changed by this exploration.

The fixture matcher found four true positive entity mentions and retained two false
positives (a company name and a chemistry common noun), with zero false negatives in
this ten-document hand-authored synthetic set. It abstained on ambiguous aliases and
preserved future-alias and script-confusable exclusions. This set cannot estimate corpus
precision/recall, factual truth, independent confirmation, causal impact or profit.

Two independent process invocations produced identical output. Four independent tests
cover temporal/boundary behavior, malicious prose, rejected public-origin/oversize input,
label separation, reproducibility and absence of imports from production apps/packages.
Local report: data/research-prototypes/source-entities.json. Evaluation hash:
`sha256:774761f181c8013da638c9942f10b073e1525c00ce80b7974ff0d0da83e95e3c`.
The report retains the source/article-version and alias hashes for each occurrence.

Decision: **DEFER production adoption**. Exact aliases are an error-discovery tool; the
two deliberately retained false merges and untested languages/context do not justify
altering source independence or any candidate producer. Keep the prototype detached.

Exact future work before an ADOPT decision:

1. Propose a new EntityResolution contract containing cutoff, immutable vocabulary/model
   hash, source/article-version hashes, occurrence spans, ambiguity/abstention reasons
   and correction lineage. Review a new news-graph algorithm/schema version with explicit
   migration and original-versus-new replay comparison. Do not rewrite v1 artifacts.
2. Obtain an independently labelled point-in-time multilingual corpus with source/language
   rights, ambiguous-company/common-noun strata, dependency-chain labels and negative/null
   controls. Freeze training/calibration/test dates and report uncertainty/missingness.
3. Bind that artifact, algorithm hash and changed source-confirmation assumptions into a
   **new** experiment protocol/ID; predeclare comparisons and multiplicity. Re-run all
   isolation, risk, execution, provenance and source-coverage gates before a future study.

No changes to the supplied master contracts or current frozen protocol are applied now.
Other options A/B/C/E/F remain future research tracks, not implementation requirements
or an authorization to handle funds. No live connector or live-mode switch exists. The
hypothetical live project still requires separate explicit authorization, jurisdiction
and exchange review, independent security/DR/reconciliation and a named human risk owner.
One synthetic month or one positive public month would not satisfy that gate.
