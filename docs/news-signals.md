# Conservative news candidates

Module 10 Iteration 1 exports `NewsSignalProvider`, `defaultNewsSignalConfig` and
`deriveNewsFreshness` from `@crypto/strategies`. Strict versioned Zod contracts live in
`@crypto/contracts`; bounded replay and immutable artifacts live in `@crypto/backtest`.
There is no account, order, sizing, stop, probability, expected return or PnL output.

## Run and reproduce

Use the pinned Node 24.22.2 and pnpm 10.34.9 runtime from README.md:

```sh
pnpm news-signal fixture --out data/news-signals
pnpm news-signal run --manifest <bundle>/manifest.json --out data/news-signals-built
pnpm news-signal verify --directory <bundle>
pnpm news-signal report --directory <bundle>
pnpm news-signal reproduce --directory <bundle> --out data/news-signals-reproduced
```

The fixture builds eight fictional incident scenarios through the existing ingestion,
review, deterministic extraction, provenance graph and event services. Confirmed,
fake official-looking, rescinded, partially confirmed with ten reprints, positive listing,
unknown availability, stale-market and scheduled-match cases retain separate provenance.
Fixture truth labels are audit metadata and never enter provider inputs. All quantities,
source roles, mappings, clocks, articles and prices are explicitly synthetic; no source,
LLM or network call occurs. LLM extraction cost is zero; the no-LLM extractor recipe and
its versioned inputs are preserved inside the source snapshots.

## Rules and abstention

Defaults are untrained, conditional policy hypotheses: reported security incidents
suggest SHORT and listing events suggest LONG. Both require at least two independent
affirmative origins, a reported amount of at least 1,000,000 USD, a curated DIRECT asset
mapping, first appearance in the observed corpus and mismatch against a previously
recorded comparable quantity. A quantity mismatch is not measured market surprise.
Event-day precision is retained; no precise incident time is invented.

The provider rebuilds a semantically validated event snapshot at each decision cutoff.
Only known graph and metadata prefixes enter candidates. Unreliable availability,
inactive/reviewed identity, conflict, rescission, weak rumor, unclear impact, missing or
incomparable severity, missing context and undeclared rules force HOLD. First-known
age over 600 seconds or observed publication-to-root-known delay over 300 seconds also
forces HOLD. The latter includes processing latency and does not establish authentic
publication time. Missing/future publication timestamps are not repaired.

The 900-second event horizon starts at first-known time, never at a reprint or later
confirmation. Candidate duration shrinks toward that fixed expiry. HOLD validity is
30 seconds. An unchanged admitted material opinion cannot repeatedly re-arm; a genuinely
new independent root or recorded correction may change a later decision. State is
isolated by provider hash, event and symbol, and must advance monotonically. Freshness
vetoes do not consume an opinion. Returned decisions and state are immutable.

One representative affirmative root per independence group supplies support. Adding ten
dependent reprints preserves origin count, support grade and material identity, while
retaining every source/evidence ID in the audit. Official attribution and declared source
independence can be wrong. `ATTRIBUTED_SUPPORT` describes provenance, not event truth
or return probability. Score and calibration are explicitly MISSING.

## Market independence and the operational veto

News-direction rules cannot read prices, returns, technical indicators, baseline or
market-strategy output. The separate `deriveNewsFreshness` adapter validates existing
market source/metadata eligibility and known bar timestamps, then exports only a minimal
timestamp/source-ID receipt. A missing, stale (over 60 seconds), ineligible or future
receipt vetoes admission. It cannot strengthen an opinion or change LONG to SHORT.
Changing prices with identical valid timestamps and metadata leaves that receipt and
news opinion unchanged. Hashes prove receipt content identity, not trusted issuance;
callers must derive the receipt through the validated adapter.

## Evidence and bounds

Every candidate, including HOLD, links its exact immutable event snapshot, source and
evidence IDs and freshness proof. Provider identity binds config/software/source policies;
per-decision dataset hashes bind only the known prefix. Appending future confirmation or
correction cannot alter earlier candidate identities. Declared fixture clocks are
fictional and do not establish actual historical publication or preregistration.

Bundles contain `manifest.json`, `report.json`, `report.md`, `decisions.jsonl`, all unique
`snapshots/<hash>.json` and an indexed `bundle.json`. Writes finish the bounded replay
before staging, sync files and atomically rename the directory. Existing immutable bundles
must match byte hashes. Verification rebuilds every prefix, decision, journal hash and
report; repairing checksums alone cannot disguise a forged artifact. Reproduction retains
the stored software version. Hashes do not prove provider authenticity or corpus completeness.

Limits are ten cases, four symbol bindings, 32 decision times per case, 32 graph records,
16 event metadata records, 16 source events, 256 bars per case, 512 decisions and 320
snapshot hashes. The provider caches at most 32 prefixes. Replay accepts explicitly
synthetic input only; this iteration does not add real historical signal backtests.
It is a decision-time event-snapshot replay, separate from Module 08's raw-input scheduler.
No SQL migration or earlier artifact format changes are required. Workspace dependencies
add existing news/connectors packages without new third-party versions.

## Handoff

The acceptance fixture yields 144 decisions and 72 snapshots: two LONG, three SHORT and
139 HOLD. These counts demonstrate conditional rules and vetoes, not profitability.
Validation passes 778 offline tests (42 new), 28 isolated PostgreSQL tests, doctor and
frozen offline installation. Actual CLI run/verify/report/reproduce yields byte-identical
76 indexed files plus bundle metadata across three roots. The final local bundle is
`data/news-signals/news-signals_986e6978bbb122145975a4a27ae928cdefe4d8062472d0832a31f5d8b7be311d/`;
`data/news-signals/handoff-summary.json` records exact identities and compatibility checks.
SHORT is a diagnostic candidate and does not authorize short execution. Costs and returns
are unmodeled. Fusion, general risk, promotion and execution remain outside this iteration.
Next is exactly Module 10 Iteration 2: eligible historical event-study hypotheses,
minimum samples, time splits, magnitude/holding-period estimation and cost/uncertainty gates.
See [ADR 0025](adr/0025-conservative-news-signals-and-freshness-veto.md).
