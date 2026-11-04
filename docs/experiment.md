# Pre-registered paper experiment

All balances, orders and fills are SIMULATED. The accelerated exercise covers thirty
virtual UTC days; it is not a claim that a real thirty-day public study has elapsed.
Licensed/eligible sources and a future UTC calendar are required for a real forward run.

Use the pinned runtime, then:

```powershell
pnpm experiment template --output experiment-next.yaml
pnpm experiment freeze --protocol experiment-next.yaml --directory data/experiment-next-freeze
pnpm experiment dry-run --manifest data/experiment-next-freeze/manifest.json
pnpm experiment exercise --output data/experiments
pnpm experiment verify --directory data/experiments/trial_HASH
```

The committed experiment.yaml is a clearly labelled SYNTHETIC acceptance protocol. Its
sparse opportunity calendar deliberately leaves statistical evidence insufficient. A
new template refuses to overwrite an existing file. Freeze refuses changed software,
future/unversioned model artifacts, missing adapter/license reviews, unequal common
settings, unsafe risk ceilings and time/calendar violations. The native manifest and
outer protocol hash are immutable; hashes establish integrity, not provider authenticity.
After any code/parameter change, prepare and freeze a new protocol/experiment ID.

Operator checklist before a public study:

1. Finish backend/dashboard checks and review capacity against the frozen opportunity
   and acquisition cadence. Native limits remain 200,000 events, 10,000 orders and
   50,000 fills; reaching a limit invalidates completeness and stops the worker. Do not
   promise a month of tick retention within these budgets. Freeze a feasible sampling
   policy/capacity or implement a separately versioned storage change before launch.
   The public study policy uses 120-second idle quote/tick sampling and relevant active
   execution evidence; three independent idle streams fit below the event ceiling.
   Active bursts still have a hard work-budget stop. The original 30-second policy
   remains supported for earlier single-instrument sessions.
2. Supply actual versioned model artifacts and pre-freeze training/availability cutoffs.
   BASELINE remains cash; NEWS_ONLY, MARKET_ONLY and FUSION retain isolated input policy.
   Retain all producer bundles and decision snapshots. No predictive vector is invented.
3. Review each market/news adapter and permitted research use, region, expiry, quotas
   and retention. Bind the review evidence hash and adapter version/hash to the actual
   source worker. Synthetic rights cannot be relabelled into public eligibility.
4. Freeze UTC midnight start and exactly thirty days end, equal virtual capital, at least
   three eligible instruments, risk/cost/fill rules, latest-required-confirmation timing,
   delayed-news HOLD treatment, opportunity calendar, failure and uncertainty thresholds.
5. Run dry-run validation. Check working-tree equality at launch/resume, source clocks,
   health coverage, operator access, backup/restore and content-free alerts. Keep the
   original frozen protocol even if it performs badly.

The coordinator is independent from acquisition/strategy workers. Those workers use
the existing allowlisted public market/news adapters and isolated candidate producers;
they publish validated PaperEvent JSON atomically into a private local inbox, named
`SHA256_OF_CANONICAL_JSON.json` (hex only). This is a receipt interface, not permission
to backfill historical data into a forward run. No URLs, modules or shell code are
executed from inbox files. Source bindings are a JSON array of sourceId, adapterHash,
adapterVersion, exactly matching every frozen provider. Source observations/heartbeats
must come from successful eligible acquisition; supervisor ticks never fabricate them.

```powershell
pnpm experiment launch --manifest data/experiment-freeze/manifest.json --directory data/trial-store --inbox data/trial-inbox --bindings data/runtime-bindings.json
pnpm experiment status --directory data/trial-store
pnpm experiment submit --directory data/trial-store --event data/candidate.json --news-snapshot data/native-news-snapshot.json
pnpm experiment launch --manifest data/experiment-freeze/manifest.json --directory data/trial-store --inbox data/new-session-inbox --bindings data/runtime-bindings.json --resume true
pnpm experiment report --directory data/trial-store --output data/experiments
```

Launch waits for the frozen start, then requires unchanged code, public-origin artifacts,
valid rights and exact source bindings. The initial window is bounded by the frozen clock
lag. Invalid/future/backdated inputs fail closed. Candidate news/fusion entries require
an exact native snapshot with sufficient independent origins available at the decision;
later corrections never backdate an entry. Evidence snapshots must be retained before
submission. Acquisition and strategy workers remain separately operated: this command
does not silently substitute fixtures or mint news confirmations. Missing arm slots are
explicit in daily QA, not converted to fabricated candidate decisions.

Use a fresh session inbox after restart; retain the old inbox as immutable raw evidence.
The committed ledger/manifest remain unchanged. Stop, pause or kill through existing
paper controls using the trial store's `paper/` directory. A killed run needs a new
manifest. Every start/restart appends an annotation, with prefix provenance. Unknown
restart downtime is labelled UNKNOWN_NOT_ZERO. Annotations are single-writer, hash-named
and chained in assessment; stale annotation writer locks use the same PID review/recovery
procedure as the paper writer. Never erase or merge history manually.

Daily outputs include all four equity/return rows, declared versus observed arm slots,
HOLD/veto/fill counts, reconciliation and alert/log hashes. Weekly QA retains partial
weeks, missing slots and source uncertainty. Rebuild current daily/weekly reports with
`experiment report` (each changed snapshot creates a different report bundle).

After-action bundles contain manifest.json, run.json (raw ledger, corrections and source
snapshots), assessment.json, findings.md, and a nested verified evaluation evidence bundle.
Reports retain fees, gap outcomes, paired uncertainty, declared-search correction,
cost/latency stress, calendar/asset decomposition, cash and passive endpoints. Source/news
uncertainty and unmeasured corroboration delay remain explicit. Positive PnL, a sparse
cohort, one outlier or profit erased by sensitivity cannot establish robust alpha.
Recommendations are CONTINUE_FORWARD_TEST, REVISE_AND_RESET, or STOP. Even a successful
month cannot authorize real trading. Ranked post-hoc hypotheses apply only to a new test.

Actual licensed-provider operation, a continuous elapsed public month, external alert
delivery and production capacity are not established by the synthetic acceptance run.
