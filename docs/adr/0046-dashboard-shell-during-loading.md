# ADR 0046: Keep the dashboard layout during loading

2026-11-03 · User-requested Module 14 UX follow-up · Accepted

The console rendered the welcome panel whenever session state was initially unknown.
Every route mount and hard refresh therefore briefly replaced the dashboard with that
panel. Render the normal sidebar/header/page layout while checking the session and
loading validated data. Only confirmed token-based access that actually needs sign-in
renders the authentication form. No account data is shown before API authorization.

The content area exposes its busy state and supplies retry after a failed initial load.
The synthetic demo has no welcome/splash transition. Existing authentication, API checks,
source provenance and frozen experiment records are unchanged. Changed application code
still requires a new experiment freeze before a future study.

Verification: frontend/backend TypeScript, targeted ESLint and formatting pass. Browser
observation recorded no welcome panel during a hard refresh with a delayed readiness
request or client-side navigation. A simulated failed overview request preserved the
layout and exposed retry; retry restored the actual virtual trades data successfully.
