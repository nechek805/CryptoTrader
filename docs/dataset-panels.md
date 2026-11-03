# Dataset panels and leakage audit

Module 07, Iteration 3. Research only; execution is disabled. This module constructs
datasets, not models, forecasts, strategies or execution simulations. The bundled
ETH/SOL/NEW cohort, groups, prices, books and leaking proposal are entirely synthetic.

## Reproduce a panel

Use the pinned Node 24.22.2 and pnpm 10.34.9 runtime from README. No network, database
or credentials are required. Existing technical/cross-feature commands remain compatible.

```powershell
pnpm features dataset-fixture --out data/dataset-panels
# Substitute the printed content-addressed directory in subsequent commands:
pnpm features dataset-verify --directory data/dataset-panels/dataset-panel_HASH
pnpm features dataset-report --directory data/dataset-panels/dataset-panel_HASH
pnpm features dataset-view --directory data/dataset-panels/dataset-panel_HASH --split TRAIN
pnpm features dataset-view --directory data/dataset-panels/dataset-panel_HASH --split TRAIN --horizon 1
pnpm features dataset-replay --directory data/dataset-panels/dataset-panel_HASH --out data/dataset-panels-replay
pnpm features dataset-build --input panel-input.json --request panel-request.json --out data/dataset-panels
```

The fixture command prints the manifest, split counts and directory. Report writes Markdown
to stdout. Build accepts the strict `dataset-panel-input.v1` and `dataset-panel-request.v1`
contracts exported by `@crypto/contracts`; export `artifact.input` and `artifact.request`
from a verified artifact to replay through build. Replay uses the current software hash;
identical software/config/input/writer produces identical manifest and Parquet bytes.
No CLI command accepts execution credentials, live endpoints or arbitrary feature code.

## Source and feature contract

Inputs embed semantically verified `technical-feature-artifact.v1` and/or
`cross-feature-artifact.v1` sources, explicit source/instrument/series bindings, historical
market metadata and versioned group evidence. A technical series needs one binding.
Cross sources must use the same market metadata snapshot as the panel. Source intervals
must match the panel. Binding provenance, historical full-bar listing/mapping/precision
and actually known group evidence gate rows; current classifications never fill old gaps.
Group revisions have effective, observed, available and captured clocks and source lineage.

Columns are an explicit ordered allowlist. Technical names are `technical.<featureId>`;
for example `technical.sma`, `technical.return_1`. Cross columns include
`cross.return`, `relative_to_btc`, `btc_return`, `regime_efficiency`, `regime_volatility`,
`regime_trending`, `high_volatility`, `funding_rate`, `open_interest`, `breadth_advancing`,
`breadth_declining`, `turnover_hhi`, and `correlation_<lag>` (each with the `cross.` prefix).
Definitions fingerprint formula/configuration/interval, not just display names. Different
definitions for one column quarantine the panel candidates even across nonoverlapping
source timestamps. Exact source duplicates are reported and deduplicated; identical
computed cells merge source hashes; conflicting evidence IDs fail loudly.

Predictors carry input IDs, definition/source hashes, missingness status, maximum input
event time and `maxInputAvailableAt`. Every exported row satisfies
`maxInputAvailableAt <= featureAsOf`. Row watermarks include known historical instrument
and group metadata. Cross cells conservatively retain the entire source row's evidence
and watermarks, including universe selection inputs. Labels have separate clocks and
never increase predictor watermarks or become implicit columns.

`proposedFeatures` supports auditing untrusted candidates, including label-derived
features; proposals **never** become training columns. The audit detects explicit label
dependencies, unsupported sources, unknown raw evidence, future event/availability times,
and understated watermarks by checking actual source bars. It does not claim to infer
arbitrary hidden mathematical dependencies from numbers. Only registered, rebuilt
algorithms can supply predictor values. Hashes establish consistency, not authenticity.

## Labels, chronological splits, purge and embargo

Each label is a gross close-to-close return from the row's actual current source bar
to a declared positive forecast horizon in bars. The entry revision is pinned at the
feature cutoff. Every intermediate close must exist, be eligible and respect historical
mapping/listing/precision. No interpolation, zero exit price or alternate survivor exists.
Targets must end strictly after `featureAsOf`.

Each future close is observed at `closeAt + labelPublicationLagSeconds`; select its latest
eligible revision known at that fixed cutoff, not at dataset generation. A later correction
does not rewrite earlier label evidence. The label is finalized only after the declared
end observation window matures and all metadata/price evidence is available. Windows
beyond `labelsAsOf`, missing paths and delisting/mapping failures remain explicit null
statuses. All requested horizons must be complete for an included row.

Train, validation and test use chronological, nonoverlapping half-open periods `[from,to)`.
Purge is global across all symbols and groups: a training label whose end, observation
deadline or final availability touches/reaches validation start is excluded; validation
is purged against test start. Boundary equality is excluded. The maximum of all configured
horizons therefore controls inclusion. This also prevents train/test contamination when
validation spans no candidates. Post-boundary embargo excludes validation/test feature
timestamps in `[partition.from, partition.from + embargoSeconds)`. No random/group split
or later-period training is supported. Purge/embargo do not prove statistical independence.

Statuses are INCLUDED, PURGED, EMBARGOED, QUARANTINED and OUTSIDE_SPLITS. Invalid metadata,
conflicts and leakage take quarantine priority. Missing label reasons are retained even
when a row is already purged. Feature `KEEP_NULLS` preserves explicit unknowns;
`DROP_ROW` quarantines rows with any missing requested feature. No imputation or scaling
is fitted; downstream consumers must fit preprocessing on TRAIN only.

## Audit and survivorship limits

Artifacts retain all candidate rows and report per-split inclusion, missingness/statuses,
duplicate/conflict identities, leakage issues and per-instrument source coverage. Coverage
includes explicitly requested instruments with zero candidates. Point-in-time listed
membership is the default; optional liquid membership requires actual cross-feature
universe evidence. Missing historical books cannot become candle-derived liquidity.

The cohort is explicitly declared with mandatory disclosure. This prevents silently
claiming a current list represents the historical market, but cannot recover absent
delisted instruments or prove a complete exchange inventory. Missing metadata, future
prices and label windows remain auditable selection effects. Complete-case label
selection can still introduce bias; report the excluded candidates before modeling.

Warm-up/history gaps, missing BTC, unknown historical group/listing data, unavailable
book metrics and unpublished/unsupported derivatives make the corresponding candidates
unavailable in real time. Spot derivatives are not applicable. Availability describes
input knowability; actual feature computation/publication latency is unmodeled. Raw gross
labels are research targets without fees, fills, slippage or causal/performance claims.

## Immutable Parquet and TypeScript client

Each content-addressed directory contains:

| File            | Contents                                                                                 |
| --------------- | ---------------------------------------------------------------------------------------- |
| `artifact.json` | Inputs/config/catalog, all candidate rows, source provenance and audit                   |
| `panel.parquet` | Included rows only, sorted by feature time/instrument/row ID                             |
| `manifest.json` | Writer/software versions, input/config/artifact/rows/file hashes and ordered column maps |

DuckDB 1.4.4 uses one thread, Parquet V1, uncompressed fixed row groups and deterministic
ordering. Decimal values remain exact nullable VARCHAR strings; timestamps are canonical
UTC with nanoseconds, not lossy floats or assumed timestamp units. Manifest `feature_i`
and `label_h` mappings preserve names/horizons. `record_json` retains typed evidence.
Use Zod schemas to validate JSON; a future Python consumer must preserve these decimal,
null, clock and manifest semantics. No Python worker is introduced.

Writes sync private staging files and atomically publish without replacing valid existing
panels. Existing artifacts must pass full verification for reuse. Verification checks
bounded regular files, directory/manifest identity, all byte/content hashes, semantic
source/panel rebuilds, exact Parquet schema, every flat column against its record, and
the complete included-row set. Recomputed hashes cannot conceal an altered flat predictor.
Synthetic evidence can still be fabricated; hashes are not signatures or licensing proof.

```ts
import { readDatasetPanel } from '@crypto/research';
const panel = await readDatasetPanel(directory); // verifies before exposure
const train = panel.features('TRAIN'); // ordered nullable decimal strings, no labels
const supervised = panel.supervised('TRAIN', 2); // explicit target horizon
// panel.columns, panel.featureCatalog, panel.manifest, panel.audit
```

Both interfaces return immutable values and validate split/horizon selections. Symbol,
group, row ID and input watermark are metadata, not numeric predictor columns. Unknown
splits/horizons fail. No training, strategy selection or execution is performed.

## Review and next boundary

`tests/dataset-panel.test.ts` covers hand labels, leaked proposals, nanosecond boundaries,
global purge/embargo, late groups/listings/corrections, missingness, delisting paths,
cohort coverage, source/config conflicts, stable exports, modified files and poisoned
Parquet predictors with recomputed hashes. The existing technical/cross feature tests
preserve original artifact identities.

This completes Module 07's catalog, source-coverage and training-manifest handoff to
Modules 09/11. Proceed in roadmap order to Module 08, Iteration 1 — Deterministic Replay
Kernel. No later backtester, fills, ledger, strategy or ML work belongs to this iteration.
