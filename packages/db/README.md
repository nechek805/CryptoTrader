# @crypto/db

Versioned SQL migrations, immutable raw/revision/run/experiment repositories, causal
history queries, transactional provenance, keyset pagination, archival and hash-chained audit.

Use `ResearchDatabase` with scoped `transaction` / `read` callbacks. See the root
`docs/persistence.md` for setup, interfaces and limits; `pnpm test:integration` requires an
explicit local `TEST_DATABASE_URL`. No market/news provider or trading code is implemented.
