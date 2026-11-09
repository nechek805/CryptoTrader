# ADR 0066: V2 reproduction and independent news V6 ablations

Status: accepted, 2026-11-08.

V5 changed event taxonomy, eligible/control samples and validation gates
together. Its reduced activity and merged Fed categories removed profitable
V2 positions while retaining losing ones. V5 therefore did not establish a
profit improvement and cannot identify the individual effects of its changes.

Start V6 by reproducing the entire frozen V2 model exactly. Reconstruct the
original event set from the same immutable corpus and keep Fed easing,
tightening and other decisions separate. Preserve all V1–V5 model objects and
history/cost settings.

Compare three standalone changes: a 1.28 uncertainty margin, positive normal-cost
per-category validation, and a largest-validation-winner ranking penalty on the
same 36 candidates. Every case starts from V2; changes are never combined. Keep
all outcomes visible. Choose one case with a declared validation score and cash
fallback, never by final-period P&L. Show chronological validation diagnostics
with frozen training rules and separate capital.

Version storage, queue/API dispatch and contracts separately. Check an exact
parent projection and fail on V2 reproduction/input mismatches. Export all cases
and preserve negative results. Historical availability, current-universe bias,
multiple comparisons and the already-viewed final period still prevent live
qualification. The experiment may select unchanged V2 or underperform it.

See [V6 protocol](../news-strategy-v6.md).
