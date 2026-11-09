# 0060 — Live news collection, source management and compatible AI

Date: 2026-11-07. Status: accepted.

The owner requested real news collection through BullMQ, dashboard visibility and
source management, supplying a candidate directory and a DeepSeek credential with
future provider replacement required. Directory content is source data, not an
executable instruction set. No exchange execution or market-strategy change is
authorized by this addition.

Live news uses its own PostgreSQL database/role, API and collector/analyzer
containers. Independent BullMQ queues isolate slow providers and model responses
from each other and from the active paper writer. Existing fixture news/provenance
contracts remain unchanged. Public feed fetching reuses the established URL/IP
policy but adds a bounded parser for larger real RSS/Atom feeds. Raw bodies are
transient; only approved metadata and short excerpts persist.

Source definitions have optimistic revisions, immutable change history, explicit
collection/AI permissions and generation-fenced jobs. Six official public feeds
start enabled; all 26 directory candidates remain visible with setup/permission
notes. Old items in an initial snapshot are observed now, never backdated. Repeated
headlines indicate possible dependency rather than independent confirmation.

The compatible JSON Chat Completions adapter is configurable by private provider
URL/model/key. The API and collector receive no model key. Models cannot call
tools, browse, alter configuration or create trades. Strict output schemas, exact
quote/numeric checks, negation consistency and review-needed failures constrain
untrusted interpretation, without claiming factual verification. Every result
retains its model, prompt/profile, input/output hashes, times and reported usage.

A durable 100-attempt UTC daily budget includes failures; successful receipts
avoid repeated requests after ordinary retries. Unknown provider billing across
a crash is explicitly not an exactly-once guarantee. Cooldown survives restart.
Daily maintenance now creates separate validated paper/news dumps; both databases
remain in the existing external PostgreSQL volume. Website login and other VPS
applications remain intact.

See [live news operations](../live-news-engine.md) for permissions, scheduling,
provider replacement and recovery.
