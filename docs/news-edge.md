# Conditional news return hypotheses

Module 10 Iteration 2 estimates conditional direction, horizon and return magnitude from
the existing event-study engine, with chronological training and validation. It exports
`trainNewsEdge`, `EstimatedNewsSignalProvider`, semantic model verification and immutable
model files. Canonical candidates remain in NEWS_ONLY with execution DISABLED. No model
or source-support grade establishes event truth or authorizes trading.

## Commands

Use the pinned runtime from README.md:

```sh
pnpm news-edge fixture --out data/news-edge
pnpm news-edge verify --model <printed-model-path>
pnpm news-edge report --model <printed-model-path>
pnpm news-edge infer --model <printed-model-path> --request data/news-edge/fixture-query-1.json
pnpm news-edge reproduce --model <printed-model-path> --out data/news-edge-reproduced
pnpm news-edge train --input <input.json> --out data/news-edge-built
```

The fixture command writes a self-contained model and two separate synthetic future
inference requests. Export the model's `input` field to use `train`. Reproduction preserves
the stored software version; training records the current source hash. CLI flags and JSON
are strict; there are no live, credential, endpoint, execution or model-promotion options.
Model/input files are bounded to 32 MiB and decoded as strict UTF-8.

## Frozen research design

`news-edge-plan.v1` declares taxonomy/series/recurrence hypotheses, candidate horizons,
training and validation ranges, a fixed decision delay from first-known time, the
benchmark, pre-news window, non-news control anchors, matching caliper, sample minima,
cost, uncertainty buffer, multiplicity family and seed. Declaration must precede
training; periods are disjoint and chronological; model availability follows the complete
validation cutoff. These are asserted clocks, not authenticated preregistration.

The input uses Module 06's `hypothesis-dataset.v1`: semantically validated news snapshots,
point-in-time observation pointers, explicit descriptive archives and original MarketBar
provenance. The fitter materializes only news prefixes, observations and price receipts
known by `analysisAsOf`; future records cannot become fitting inputs. Each observation
rebuilds its own news context. Available outcomes must lie entirely within their phase,
including the pre-news window. Missing, estimated, stale, conflicting or late-published
price closes never supply labels. Descriptive archives retain an explicit exclusion row
with null returns and never enter estimates or intervals.

The conservative Module 10 Iteration 1 rules also gate measured observations: direct
curated exposure, source corroboration, reliable publication/receipt time, reported
severity and conflict/withdrawal checks remain in force. First-seen versus repeated
patterns are separate predeclared strata; they are not pooled to repair a thin sample.
The fixture disables the quantity-expectation requirement explicitly in its plan; it
does not reinterpret a missing expectation as market surprise.

## Outcomes and historical controls

Let A be the event asset's forward price return and B the benchmark's return over the
same exact-close horizon. Unit benchmark beta is predeclared; no market model or
estimated factor is fed into the news producer. For every historical non-event anchor,
calculate its pre-window A minus B and its forward A minus B. Match the nearest
pre-window relative moves within the declared caliper, then use temporal proximity and
stable IDs as deterministic tie breakers. The declared minimum controls is also the
fixed number selected; unmatched events retain missing excess return.

Controls must have complete pre/outcome windows inside the same phase. Their windows
cannot touch the observed eligible news calendar's pre/outcome blackout in that phase.
Unknown descriptive incident times do not become blacklist evidence. This identifies
non-event windows only relative to the observed corpus; undetected news remains a bias.
Controls and event labels may be analyzed together once their phase is complete; they
are not live features. Training never uses the validation phase's control calendar.

The controlled label is `excess = A - B - mean(matched control A-B)`. Reports retain A,
B, pre-news relative move, every matched control return, baseline mean, original bar
IDs, lineage/source IDs and exclusion reasons. Baseline reports give unique-control
count, minimum, median and maximum. Recurrence conditioning, pre-move matching and
benchmark subtraction address specific confounders; none proves causal identification.

## Selection, uncertainty and cost gates

Connected event lineage, intersecting pre/outcome windows, shared original bar IDs or
shared matched controls form one sampling block. Each block gets equal weight. Reprints,
repeated observation pointers or reused controls cannot inflate independent-unit counts.
Complete training/validation rows may not share lineage or original price/control
evidence. Disjoint blocks still need not be independent across dates or regimes.

Direction is the sign of the TRAIN block-mean excess return. For each predeclared horizon,
seeded block bootstrap draws jointly resample gross and excess block means. Intervals
are two-sided percentile intervals with nominal Bonferroni family
`hypotheses * horizons * 2 metrics * 2 phases`. The tail index is
`floor((resamples-1)/(40*family))`; an index below one or too few units leaves intervals
missing and forces abstention. Conditional bootstrap intervals do not guarantee family
coverage, protect against unreported searches or forecast an individual event's return.

For LONG, use each interval's lower bound; for SHORT, negate its upper bound. The gate
margin is the worse directional gross/excess bound minus round-trip cost and the fixed
uncertainty buffer. Both metrics must clear that hurdle. Relative outperformance alone
cannot rescue a negative raw-return bound. Training chooses the largest positive margin,
with the shorter horizon breaking ties. No eligible TRAIN margin means HOLD.

Only that fixed sign/horizon is checked on later validation. A failed validation gate
cannot select another horizon, reverse direction or refit. Every attempted horizon and
negative result stays in the model. Expected magnitudes and intervals on inference are
the reported VALIDATION cohort's conditional means and mean intervals, with separate
TRAIN/VALIDATION sample and block counts. Validation is an explicit gate, not a final
untouched test set or evidence of future profitability. A later time-separated evaluation
remains necessary. No factual probability is inferred from observed price responses.

## Inference and compatibility

`EstimatedNewsSignalProvider` implements the existing structural NewsSignalProvider port
and extends the evaluate result with `news-edge-prediction.v1`. It reads the frozen model,
the exact as-of news snapshot and Module 10 Iteration 1's separate operational freshness
receipt. It accepts no current market returns, prices, baseline outputs or features.
Model-before-availability queries are rejected before estimating anything. The event
taxonomy, series, observed-corpus recurrence and exact first-known decision delay must
match the fitted opportunity set. Unknown scope or changed delay abstains.
Training snapshots must share the same grouping/novelty policy fingerprint; an inference
snapshot with different policy definitions is rejected.

Predictions carry model hash, vintage/availability, sample and independent-unit counts,
tested horizon, conditional gross/excess means and intervals, net margin, separate event
support grade and reasons. A non-selected sparse hypothesis reports its first tested
horizon's diagnostics and HOLD. Candidate score/calibration remain explicitly MISSING;
`eventTruthProbability` is always null. No stop, target or position size is invented.

Inference uses the higher of frozen cost and supplied cost. Both TRAIN and VALIDATION
bounds must still clear that cost and uncertainty buffer. News quality and stale-data
vetoes can only weaken admission. A statistical veto does not consume admission state;
unchanged admitted evidence cannot repeatedly emit candidates. Candidates link model,
prediction and prefix snapshot hashes, source evidence, software, costs and seed.
Expiry equals the fitted horizon at the exact declared decision delay.

Model files publish by synced staging file and an atomic no-replace hard link. Verification
rebuilds frozen inputs, every outcome/control row, all estimates, selection and cost gates;
changing a checksum or filename alone cannot disguise a forged fit. A private weak set
avoids refitting only already constructed, deeply frozen local instances. Imported objects
always receive full semantic verification. Existing Module 06 registries, I1 candidates,
ML, replay and execution artifact formats remain unchanged; no migration is required.

Bounds are eight news snapshots, 32 graph records/16 metadata records/16 events per
snapshot, 128 observations, 20,000 bars, four hypotheses, three horizons, 128 control
anchors, 100,000 path points and 1,000,000 bootstrap unit draws. Larger research requires
explicit separately declared studies; limits do not silently truncate evidence.

## Synthetic handoff

The fixture authors two taxonomies with six TRAIN and three VALIDATION first-seen
events each, one sparse repeated event each, two descriptive archives and future query
events after model availability. Both sources per event and all return paths, source
roles, timestamps and declared exposure are fictional. Two controls per event match
alternating pre-news relative moves. All source extraction is deterministic, with zero
LLM calls/cost; source extraction inputs/versions remain in snapshots.

All eight hypothesis/horizon attempts are retained. Five-minute SHORT incident and LONG
listing diagnostics clear the synthetic gates. One-minute alternatives fail costs and
uncertainty; repeated-event strata lack enough units. Any synthetic or mixed fixture
evidence is labelled diagnostic only and cannot promote a strategy. Costs are assumptions,
SHORT is unexecuted, and no filled-price PnL or real historical edge is claimed.

Final verification passes **821 offline tests in 27 files**, including 43 new tests,
plus 28 isolated PostgreSQL tests, doctor, frozen offline installation and byte-identical
original/retrained/reproduced model files. Actual CLI inference verifies both directions
and high-cost/sparse-cohort HOLD cases. Earlier news, hypothesis, market and replay
artifacts remain compatible. The final local model is
`data/news-edge/news-edge_41c7640ee7e6aaab7ed52ef734cc7a18ccf30c393d52da48548e72efe61710ee.json`;
exact results are in `data/news-edge/handoff-summary.json`.

Next is exactly Module 10 Iteration 3: explanations, adversarial replay and incremental
value against a non-news baseline on later separated data. See
[ADR 0026](adr/0026-conditional-news-edge-and-historical-controls.md).
