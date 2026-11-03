# Module 05 — Claim Extraction, Event Clustering and Corroboration

## Objective
Turn news articles into **evidence-linked, uncertain event claims**. Never promote a rumor to truth merely because many outlets repeat one origin.

## Dependencies
04, 02. Text extraction may use a structured-output LLM behind a replaceable, rate-limited adapter; provide a deterministic fixture parser for tests and offline usage.

## Iteration 1 Prompt — Event Ontology and Extraction
Define a configurable ontology including security incident, insolvency, regulatory action, exchange outage, listing/delisting, ETF decision, token unlock, rate announcement and macro shock. Extract subject, predicate, value/amount, timestamp granularity, affected assets, named entities, negation, language and supporting exact snippet offsets. Use structured Zod validation and explicitly mark ambiguous/unknown fields. Treat the LLM as an untrusted extractor; raw content may include adversarial prompt injection. Build deterministic unit fixtures and document model version, prompt version and cost per document.

### Acceptance
A sentence claiming an event **did not happen** is not classified as a confirmed event; numeric amounts with different currencies are not merged; empty/invalid LLM response safely returns review-needed.

## Iteration 2 Prompt — Source Independence Graph
Cluster near-duplicate events without merging distinct incidents. Build a DAG/graph of origin articles, quoted official sources, wire reprints, attribution links and inferred syndication. Implement `evidenceIndependenceScore` with transparent rules. Maintain statuses `UNVERIFIED`, `CORROBORATED`, `OFFICIALLY_STATED`, `DISPUTED`, `RETRACTED`; an official statement is attributable evidence, not unconditional factual truth. Include contradiction groups, a human review queue and an evidence timeline.

### Acceptance
Three rewrites of one wire story count as one origin; two independently sourced reports are distinct corroboration; a contradictory report triggers dispute state; retraction does not erase the initial public belief timeline.

## Iteration 3 Prompt — Temporal Confidence and Impact Metadata
Generate immutable event snapshots **as of a requested timestamp**. Expose a conservative event confidence assessment with explanations and no invented probabilities. Store first rumor, first independent corroboration, official statement and later corrections separately. Add affected-asset mappings (direct vs second-order exposure), surprise/novelty markers, uncertainty bands and provenance visualizable as a graph.

### Acceptance
Replay at 09:00 cannot use a confirmation published at 10:00; an article published at 08:30 but first received at 09:10 is unavailable at 09:00; event-cluster splits/merges preserve original IDs in audit history.

## Handoff / Review Prompt
Export a time-indexed event fixture with known rumors, reposts, confirmations and corrections. Audit independence logic and LLM hallucination defenses. Supply interfaces for Module 06 event studies and Module 10 news signals.
