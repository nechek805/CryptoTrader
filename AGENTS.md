# Project instructions

Read `project_roadmap/01_MASTER_PROMPT.md` and the active numbered module before editing.
The master is the binding specification. Follow dependencies and implement one complete
iteration at a time, stopping after its acceptance checks and handoff.

Use `docs/progress.md` for current implementation status and `docs/adr/` for decisions.
Never introduce real-money execution, private wallet keys or live trading endpoints.
Fixtures must be labelled synthetic; future research inputs must obey point-in-time gates.
Validate public interfaces with Zod, preserve source provenance and add meaningful failure tests.

Use the pinned Node and pnpm versions. Run `pnpm check` and `pnpm run doctor` for changes
to the foundation. Do not rewrite `project_roadmap/` files or their recorded checksums.
The Windows `.tools/` runtime is ignored; setup instructions are in `README.md`.

Production backups were disabled at the user's request on 2026-11-08. Do not
create server-side backups (including pre-deployment database dumps or `.before`
configuration copies), or re-enable backup schedules, unless the user explicitly
asks to change this policy. Preserve the live databases and research datasets.
