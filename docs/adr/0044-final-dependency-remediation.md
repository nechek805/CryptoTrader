# ADR 0044: Final development-dependency remediation

2026-11-03 · Module 14 security/final integration follow-up · Accepted

The production-only scan was clean. A subsequent full dependency scan found two moderate
advisories: fflate 0.8.2 ZIP64 malformed-input looping and minimatch 10.2.6 glob preprocessing
amplification. Update the direct development ZIP fixture dependency to 0.8.3. The current
ESLint/TypeScript toolchain still requests minimatch 10.x, while the advisory's patched
line starts at 11.0.1; use an exact workspace override only for minimatch@10.2.6 to 11.0.4.
The fixed package supports pinned Node 24.22.2. Keep Node/pnpm pins unchanged.

Validate the override through lint, typecheck, the full regression and production build;
do not suppress advisories. Re-run both scans and retain their output. Any future upstream
dependency change requires a fresh audit; the override does not silently match other
versions. The lockfile/software hash changes, so prepare a new example protocol/ID and
retain prior frozen manifests and results. No historical evidence is rewritten.

Primary references:

- https://github.com/101arrowz/fflate/releases/tag/v0.8.3
- https://github.com/isaacs/minimatch/security/advisories/GHSA-g3hv-75wg-m249
- https://github.com/isaacs/minimatch/releases/tag/v11.0.4
