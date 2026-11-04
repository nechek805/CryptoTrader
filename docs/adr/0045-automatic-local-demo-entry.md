# ADR 0045: Open the local demo without a token prompt

2026-11-03 · User-requested Module 14 UX follow-up · Accepted

The explicit fixture server advertises demoAutoLogin in its minimal readiness response.
The client reuses an existing session or opens the known synthetic reader session
automatically, showing a loading state instead of a token form. Failure offers retry.
This uses the existing HttpOnly, SameSite session and read role; it grants no admin role.
The constructor rejects demo entry for deployments, public datasets or custom reader
credentials. Deployment sign-in remains available through its existing token form.

Focused tests cover automatic reader access and denied controls, plus the three rejected
configurations and unchanged unauthorized deployment behavior. Historical experiment
manifests remain immutable; changed software requires a new freeze before a future study.
