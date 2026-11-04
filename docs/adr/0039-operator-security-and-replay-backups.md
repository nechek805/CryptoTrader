# ADR 0039: Operator boundary and committed-prefix backups

2026-11-03 · Module 14 Iteration 3 · Accepted

Read and admin tokens have distinct canonical hashes, constant-time digest comparison,
bounded HttpOnly SameSite sessions and logout. Deployment cookies require Secure and
HTTPS origins; the API binds loopback behind a separately operated TLS gateway. Origin
checks, bounded request bodies/maps and per-address rate limits protect controls. API
logging is disabled and errors are content-free. Run controls append events and verify
the unchanged config/log prefix. No endpoint edits historical evidence or orders.

Paper backups replay a committed prefix into a separate empty store and check the exact
report hash, then snapshot. Pending requests are excluded and reported. Restore uses
the existing semantic replay path. Source status uses accepted current replay state,
with historical alerts retained separately.

Five security/reliability tests pass: a 200-request burst, rate limits, malicious control
port, logout/deployment origins, 300 malformed market packets plus 100 hostile RSS
documents, and backup replay. Production dependency audit reports zero findings on
2026-11-03. Existing connector allowlists/DTD rejection/extraction injection quarantine
remain enforced. External notification services, TLS proxy configuration and sustained
production load are not exercised; local alert records/API are the available channels.
