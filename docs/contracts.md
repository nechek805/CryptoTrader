# Domain contracts and deterministic primitives — v1

Module 02, Iteration 2. These contracts validate research records; they do not implement
a collector, strategy, risk engine, broker, database or experiment launcher. The operational
bootstrap/doctor/health v1 interfaces from Iteration 1 remain unchanged.

## Versions and exports

All schemas and inferred TypeScript types are exported from `@crypto/contracts`.
Domain objects are strict: unknown fields and unsupported `schemaVersion` values fail.
Use `.parse(unknown)` at trusted application boundaries or `.safeParse(unknown)` to obtain
validation issues without throwing. Never cast provider JSON to a domain type.

| Schema / inferred type                            | Version                  | Principal fields and constraints                                                                                                                                              |
| ------------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EventEnvelopeSchema` / `EventEnvelope<T>`        | `event-envelope.v1`      | IDs/provider, distinct event/observation/ingestion times, payload, raw hash, provenance; normalized payload availability cannot be promoted by its envelope                   |
| `MarketBarSchema` / `MarketBar`                   | `market-bar.v1`          | Exchange/instrument, market type, explicit interval, half-open bar times, positive OHLC, nonnegative volume, availability, quality and provenance                             |
| `NewsDocumentSchema` / `NewsDocument`             | `news-document.v1`       | URL, source chain, language, optional publication time, observation/availability, licensing, content hash, title and permitted snippet                                        |
| `EventClaimSchema` / `EventClaim`                 | `event-claim.v1`         | Subject/predicate/object, uncertainty, evidence/contradiction IDs, status and revision times                                                                                  |
| `SignalCandidateSchema` / `SignalCandidate`       | `signal-candidate.v1`    | Strategy/version, portfolio, symbol, decision/cutoff/horizon, required LONG/SHORT/HOLD, score/calibration uncertainty, rationale, expiry and reproducibility                  |
| `RiskDecisionSchema` / `RiskDecision`             | `risk-decision.v1`       | Candidate, portfolio, rules, allowed flag, decimal sizing, expiry, stop/target policy and frozen audit with frozen reasons                                                    |
| `SimulatedOrderSchema` / `SimulatedOrder`         | `simulated-order.v1`     | SIMULATED execution only, order/client/candidate/risk IDs, portfolio, side/type/quantity/limit, lifecycle times, fill constraints and transition history                      |
| `SimulatedFillSchema` / `SimulatedFill`           | `simulated-fill.v1`      | SIMULATED execution only, order/client/portfolio references, exact price/quantity/notional, fee/currency, liquidity, price availability and fill times                        |
| `LedgerEntrySchema` / `LedgerEntry`               | `ledger-entry.v1`        | SIMULATED execution only, unique client reference, portfolio, signed decimal asset amount, nonnegative spot balance, order/fill/correction references and audit hash          |
| `ExperimentManifestSchema` / `ExperimentManifest` | `experiment-manifest.v1` | Dataset/config/code/model hashes/versions, seed/algorithm, freeze/range/calendar, symbols, equal virtual starting capital, four isolated arms, costs and spot exposure limits |

`eventEnvelopeSchema(payloadSchema)` creates a typed payload validator. The default
`EventEnvelopeSchema` accepts JSON-compatible transport payloads; adapters must select a
specific payload schema before handing records to research code. A hash field validates
its syntax; verification against preserved bytes/data is the caller's responsibility.

## UTC and explicit epoch units

`UtcTimestampSchema` produces branded `UtcTimestamp` strings. It accepts real calendar
instants from 1970 through 9999 with a literal `T`, seconds, optional 1–9 fractional digits,
and a literal `Z`. It rejects timezone offsets, local timestamps, leap seconds, impossible
dates, hour 24 and more than nine fractional digits. Output always has nine fractional
digits, for example `2026-01-01T00:00:00.100000000Z`. Normalize before comparisons/hashing.
Operational health/doctor/bootstrap schemas retain their existing ISO format for compatibility.

Core helpers exported from `@crypto/core`:

```ts
const t = utc('2026-01-01T00:00:00.000000001Z');
const ns = toEpoch(t, 'nanoseconds'); // bigint, no Number conversion
const same = fromEpoch(ns, 'nanoseconds');
const clock = new SyntheticClock(same); // also exported as MockClock
clock.advanceBy(1n, 'microseconds');
```

`fromEpoch` requires a nonnegative bigint and an explicit unit: `seconds`, `milliseconds`,
`microseconds` or `nanoseconds`. `toEpoch` requires the same explicit unit and rejects a
conversion that would discard fractional precision. Nothing infers units from digit count.
For JSON, preserve raw provider epochs as `{ value: "1767225661000", unit: "milliseconds" }`
using `ProviderTimestampSchema`; convert with `fromEpoch(BigInt(value), unit)` when needed.
Bigints themselves are not JSON values. Only bounded whole calendar milliseconds pass
through JavaScript Date; all fractional arithmetic and epoch conversions use bigint.

`compareTimes` compares validated instants. `SyntheticClock`/`MockClock` advances only
when explicitly told to, permits equal timestamps, and rejects backwards moves and
negative increments. It never reads wall time or runs timers.

## Meaning of time fields

| Field                                      | Meaning                                                                                               |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `occurredAt`                               | Provider/event occurrence time; nullable if unknown; scheduled events may refer to future occurrence  |
| `observedAt`                               | First receipt/observation of an envelope by its attributed observer                                   |
| `firstObservedAt`                          | First defensible observation/capture of a news document                                               |
| `publishedAt`                              | Source-asserted publication time; optional and never used to infer availability                       |
| `availableAt`                              | Earliest defensible instant this exact record/revision was usable; nullable if unknown                |
| `ingestedAt`                               | Local ingestion/storage acceptance time; later historical imports do not erase original capture times |
| `processedAt`                              | Optional completion of local processing, at or after ingestion                                        |
| `capturedAt`                               | Provenance capture of the attributed input; cannot follow the record's declared availability          |
| `firstKnownAt`                             | Earliest known observation of a claim                                                                 |
| `lastUpdatedAt`                            | Creation time of this claim revision; its availability cannot precede this revision                   |
| `openAt`, `closeAt`                        | Inclusive bar start and exclusive end; duration must equal the declared interval                      |
| `decisionAt`                               | Logical strategy/risk decision instant, including in synthetic replay                                 |
| `dataCutoff`                               | Latest allowed input availability for a candidate; must not follow its decision                       |
| `validUntil`, `expiresAt`                  | Exclusive expiration instant, after creation/decision                                                 |
| `createdAt`                                | Simulated order creation time                                                                         |
| `submittedAt`, `orderSubmittedAt`          | Simulated submission time; null on an unsubmitted order                                               |
| `updatedAt`                                | Order snapshot time, at or after all recorded transitions                                             |
| `priceDataAvailableAt`, `priceAvailableAt` | Availability of price evidence constraining the simulated order/fill                                  |
| `earliestFillAt`                           | Lower fill-time bound after submission, creation and required price availability                      |
| `filledAt`                                 | Simulated fill event time, at or after its causal lower bounds                                        |
| `effectiveAt`, `recordedAt`                | Ledger economic event time versus append/record time; recording cannot predate effect                 |
| `generatedAt`                              | Artifact generation time; a signal cannot be generated before its logical decision                    |
| `frozenAt`                                 | Manifest freeze time, after generation and no later than experiment start                             |
| `startAt`, `endAt`                         | Experiment's half-open UTC range, with positive duration                                              |
| `fixtureAsOf`, `checkedAt`                 | Existing synthetic inventory time versus current operational health-check time                        |

For an eligible envelope, availability cannot predate observation. Historical imports can
be ingested much later than the defensible archived availability; the archive's capture is
recorded as provenance. A live provider adapter must never backdate observation/availability
to publication time. Derived records must carry availability after all inputs become usable;
the derivation modules will enforce their cross-record dependencies.

## Eligibility and model access

Temporal records have `availableAt`, `availabilityBasis` and `researchUse`.

- `ELIGIBLE` requires non-null availability with `OBSERVED` or `ARCHIVED_CAPTURE` evidence.
- `ESTIMATED` and `UNKNOWN` availability require `DESCRIPTIVE_ONLY` use.
- `DESCRIPTIVE_ONLY` records are excluded even when their publication or estimated
  availability is older than the decision. Unknowns are not replaced by convenient dates.

```ts
const view = decisionView(MarketBarSchema, untrustedRecords, utc(decisionTime));
// Pass view to the model. Only validated records with availableAt <= decisionAt remain.
const closes = view.records.map((bar) => bar.close);
```

`decisionView` validates JSON and the supplied domain schema, detaches input objects, filters
eligibility, then freezes the view, record array and every nested record/array. Caller mutations
and later revisions cannot rewrite that snapshot. `isAvailableAt` exposes the same temporal
gate for already validated records; malformed eligibility metadata throws instead of passing.
An instant exactly equal to `decisionAt` is eligible; one nanosecond later is excluded.

This is a data-access contract for trusted application code, not a sandbox for malicious
models or closures. Models must receive the view rather than raw repositories. The library
cannot prove a provider's availability assertion is honest or independently verify cited
evidence. Source attestation and derived-dependency validation belong to subsequent modules.
Quality flags preserve observations; stale-data/risk policy is implemented later.

## Money and quantities

`DecimalStringSchema` produces branded `DecimalString` values. Money/quantities/prices and
cost rates are decimal strings, never JavaScript numeric JSON values. Inputs allow a sign,
80 total digits and up to 36 fractional places; exponents, whitespace, leading-zero integers,
NaN and Infinity are rejected. Trailing fractional zeros are preserved in parsed records.
Separate positive/nonnegative/unit-interval schemas constrain the relevant domain fields.
Scores, probabilities and seeds are non-monetary numbers with explicit bounds.

`decimal`, `addDecimal`, `subtractDecimal`, `multiplyDecimal`, `equalDecimal`, and
`divideDecimal` use a private decimal.js context with 256 significant digits. This preserves
exact finite addition/subtraction/multiplication for bounded inputs. Outputs outside the
80-digit/36-place contract fail rather than silently round. Division requires a scale from
0–36 and an explicit rounding policy (`DOWN` toward zero, `UP` away from zero, `HALF_EVEN`).
Arithmetic outputs remove unnecessary trailing zeros; use `equalDecimal` for numeric equality.

```ts
addDecimal(decimal('0.1'), decimal('0.2')); // "0.3"
divideDecimal(decimal('1'), decimal('3'), 6, 'UP'); // "0.333334"
```

Currency/asset labels accompany ledger amounts, fee amounts and risk notional limits.
There is no implicit currency conversion, leverage, fee rounding or tick-size policy here.

## Provenance, uncertainty and simulated lifecycle

`ProvenanceSchema` retains origin (`FIXTURE`, `PUBLIC_READ_ONLY`, `DERIVED`), source IDs,
parent IDs, source version, capture time and explicitly unit-labelled raw timestamps.
News source chains retain original/citation/syndication/rewrite/unknown relationships.
Article count is not treated as independent confirmation. Claims retain evidence and
contradictions; disputed claims must include contradiction IDs. No verification algorithm
is implemented here. News contracts permit bounded titles/approved snippets, not full text;
snippets require an explicit permission flag and licensing reference. A URL is metadata;
the schemas do not grant permission to fetch it or implement SSRF protection for fetching.

`uncertainValueSchema(valueSchema)` represents one of `KNOWN` with a value, `UNCERTAIN`
with value/reason/confidence, or `MISSING` with a reason and no invented value.
Quality flags explicitly retain synthetic data, gaps, stale/missing values, corrections,
uncertain timestamps and conflicting evidence.

Denied risk decisions have zero quantity and zero notional; allowed sizing must be positive.
Risk audit objects/reason arrays are frozen. Order states start at CREATED; transitions are
chronological and contiguous. ACCEPTED may partially fill or fill; partially filled orders
may continue, cancel or expire. FILLED/CANCELED/REJECTED/EXPIRED are terminal.
LIMIT orders require a price, while MARKET orders reject a limit price.

`SimulatedFillSchema` requires causal timing and exact `notional = quantity * price`.
`validateFillAgainstOrder(fill, order, alreadyFilled?)` additionally checks identities,
portfolio/side/symbol/model, submission/expiry bounds, remaining quantity, partial-fill policy
and buy/sell limit prices. The caller must supply accurate prior filled quantity. It does not
create orders, grant fills based on OHLCV touches, verify order-book evidence, enforce
slippage against a reference quote, guarantee uniqueness or reconcile a ledger. Those are
execution/broker responsibilities in Modules 08 and 12. Corrections retain original entry IDs.

## Hashes, IDs and randomness

`canonicalJson` defines `canonical-json.v1`: plain JSON objects with UTF-16-sorted keys,
ordered dense arrays, UTF-8 JSON strings, standard finite JSON numbers, and no whitespace.
It rejects undefined, bigint, nonfinite numbers, unsafe numeric integers, custom object
prototypes, getters, symbols, nonenumerable object fields, sparse/extended arrays, cycles
and nesting over 100 levels. Shared acyclic references encode as repeated values. This is
a documented internal format, not a claim of RFC 8785 compliance or Unicode normalization.

`canonicalHash` returns SHA-256 of those canonical UTF-8 bytes as `sha256:<64 lowercase hex>`.
Parse/normalize a domain object before hashing it. Decimal strings with different scales
remain different content, even if `equalDecimal` considers them numerically equal.
`deterministicId(namespace, content)` hashes `{ schemaVersion: "id.v1", namespace, value }`
and prefixes the digest with the validated namespace. Object insertion order does not
change IDs; array order and content do. Raw provider byte hashes must cover preserved
provider bytes rather than an accidentally reformatted object.

`SeededRandom(seed)` implements versioned `mulberry32.v1` with an unsigned 32-bit seed.
`nextUint32` returns a deterministic uint32; `next` returns a number in [0, 1), and
`nextInt(bound)` uses rejection sampling for a uniform integer in [0, bound), with bound
1 through 2^32. It never uses Math.random or wall time. Record both seed and algorithm
along with code/model/data/config/fee hashes and clock semantics. This generator is for
research replay, not secrets, cryptographic signatures or IDs.

## Demonstration and evolution

Run `pnpm demo:contracts`. It validates all ten synthetic examples, gives a decision only
its eligible bar, excludes delayed news, demonstrates exact `0.1 + 0.2`, and prints stable
snapshot/manifest hashes and IDs. The example order/fill/risk records are schema examples
separate from the HOLD candidate, not an executed trading chain or performance result.
Fixture code version/model artifacts are explicitly labelled fixture versions.

The domain v1 schemas remain compatible with Iteration 1 operational interfaces. Iteration 3
now persists them through migration `0001_foundation`, with additional versioned storage,
run/audit wrappers and per-revision `knownAt`. See `docs/persistence.md` for historical read
semantics. Future breaking persisted changes require a new schema/migration version.
Manifest storage/hashing and immutable rows exist; protocol preflight, signing and launch
gates remain Module 15.
