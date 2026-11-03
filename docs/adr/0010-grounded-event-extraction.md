# ADR 0010: Grounded, unverified event extraction with a constrained adapter seam

Date: 2026-10-31 (Europe/Moscow). Status: accepted for Module 05, Iteration 1.

## Context

Module 04 supplies source-attributed, policy-restricted article versions and point-in-time
review snapshots. Extraction must retain exact support, negation, quantities and unknowns
without promoting repeated text or model output to facts. No external model/content
processing rights or provider credentials have been configured.

## Decision

Add a versioned configurable ontology and an offline English/Russian literal grammar.
Represent exact UTF-16 spans, typed quantities/units, entities, mentioned assets, temporal
granularity, polarity and unknown fields in new strict schemas. Preserve existing
EventClaim v1 with an unverified compatibility projection; no calibrated confidence or
corroboration is invented. Each event ID is explicitly unclustered.

Expose an injected structured-adapter interface but ship only deterministic execution.
Restrict injected adapters to synthetic inputs, validate bounded unknown responses, and
reconcile every proposed candidate against the supported grammar. This deliberately
constrains interpretation rather than claiming that exact quotations prove arbitrary model
semantics. Record model/prompt/config/software versions and hashes, external cost 0 for
the local parser and unknown cost for the seam.

Keep text inert, quarantine known instruction-like patterns, provide no tools/credentials,
and never accept a model-controlled verified status. Reserve finite in-memory attempts,
enforce timeouts/intervals/response bounds, and stop the session on timeout. There are no
automatic retries or live provider endpoints. A future external integration needs a separate
source-processing permission and provider-policy implementation.

Extract only permitted title or approved-snippet fields from verified news snapshots or
separate synthetic fixtures. Enforce source/version hashes, licensing and data cutoffs.
Knowledge time begins at extraction completion. Estimated/unknown historical input remains
descriptive in canonical claims. Persist new result payloads through existing append-only
raw evidence/audit storage, preserving synthetic flags and parent hashes.

## Consequences

Denials remain negated/unverified, different currencies remain separate, and invalid model
responses yield review-needed without accepted claims. Results are reproducible for fixed
input, config, adapter response and clock. The grammar is limited, non-exhaustive and can
overflag complex negation; zero candidates on real news is an honest unsupported result.
Prompt keyword checks and file hashes are not complete security or authenticity proofs.

No paid model behavior or model accuracy is claimed. Review diagnostics live in result
payloads; existing manual review/correction contracts remain unchanged. Clustering, source
independence, corroboration and event-time snapshots remain subsequent iterations. No
trading behavior or financial result is added.
