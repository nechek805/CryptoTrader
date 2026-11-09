# Live news collection and AI analysis

The independent [news-only forward paper test](news-forward-paper.md) is available
at `/news-paper`, alongside this source/AI workspace. It uses the frozen V6
deterministic categories and per-token rules with actual post-start availability;
collection and AI extraction continue independently.

The [V4 expansion](news-strategy-v4.md) adds nine public JSON/archive sources,
bringing the directory to 46 entries. Bybit, incident and XRPL metadata use
deterministic research with LLM processing off; GDELT is discovery-only. Existing
settings are preserved, and collection/backfill limitations remain visible.

Open `/news-engine` in the authenticated dashboard. **Collected news** displays
real RSS/Atom and permitted XRPL blog metadata, publisher links, first-seen/publication times, revision
history and AI interpretation. Filter by publisher, asset, text or analysis status;
sort by collection/publication time and export matching records as JSON or CSV.
Exports contain at most 5,000 matching articles and protect CSV formula cells.

**Manage sources** supports adding RSS/Atom sources, editing feed URLs, permitted
article origins, publisher groups, poll cadence and permissions, enabling/disabling
collection, and requesting a bounded manual collection. The source configuration
uses optimistic revisions and an immutable change history. Disabling or editing
a source fences stale queued/in-flight jobs. Every account with website operator
access can manage sources; API READ credentials cannot mutate them.

## Initial source directory

All candidates from the owner's `crypto_news_sources.txt` are retained. BLS is
split into employment and CPI feeds. The initial catalog has 26 entries, with
six public feeds enabled:

| Source                   | Feed                                                 | Retained material / AI                                                     |
| ------------------------ | ---------------------------------------------------- | -------------------------------------------------------------------------- |
| Federal Reserve          | `https://www.federalreserve.gov/feeds/press_all.xml` | Titles, links, up to 400 excerpt characters; AI enabled                    |
| SEC                      | `https://www.sec.gov/news/pressreleases.rss`         | Titles, links, up to 300 excerpt characters; AI enabled                    |
| BLS Employment           | `https://www.bls.gov/feed/empsit.rss`                | Titles, links, up to 300 excerpt characters; AI enabled                    |
| BLS CPI                  | `https://www.bls.gov/feed/cpi.rss`                   | Titles, links, up to 300 excerpt characters; AI enabled                    |
| Coinbase Exchange Status | `https://status.exchange.coinbase.com/history.atom`  | Headlines and links only; AI enabled                                       |
| Ethereum Foundation      | `https://blog.ethereum.org/en/feed.xml`              | Titles, links, up to 400 excerpt characters; CC BY attribution, AI enabled |

Reference pages: [Federal Reserve feeds](https://www.federalreserve.gov/feeds/feeds.htm),
[SEC feeds](https://www.sec.gov/about/rss-feeds), [BLS feeds](https://www.bls.gov/feed/),
[Coinbase subscriptions](https://status.exchange.coinbase.com/),
[Ethereum terms and CC BY license](https://ethereum.org/terms-of-use/).
These are public feed reads; full article pages are never scraped.

## SOL and XRP additions (2026-11-07)

All eleven entries from `xrp_solana_news_sources.txt` are now included, bringing
the catalog to 37 sources and the default enabled set to eleven collectors.
Existing sources, operator edits, history and queues are retained; startup seed
only inserts missing IDs. There is no database table migration. `XRPL_BLOG` is an
additive source-adapter enum; old RSS/Atom records remain compatible.

| Source                    | Collection                                    | AI / retained content                                                | Cadence |
| ------------------------- | --------------------------------------------- | -------------------------------------------------------------------- | ------- |
| XRP Ledger Community Blog | Fixed `https://xrpl.org/blog` listing adapter | Headlines/links; AI permitted, undated initial archive manual only   | 15 min  |
| XRPLF rippled releases    | GitHub `/XRPLF/rippled/releases.atom`         | Headline notifications; AI off pending additional content-use review | 5 min   |
| Solana Network Status     | `https://status.solana.com/history.atom`      | Headline notifications; AI off                                       | 5 min   |
| Anza Agave releases       | GitHub `/anza-xyz/agave/releases.atom`        | Headline notifications; AI off pending additional content-use review | 5 min   |
| Helius Blog               | `https://www.helius.dev/blog/rss.xml`         | Headlines/links and at most 300 excerpt characters; AI enabled       | 60 min  |

XRPL's [official documentation](https://xrpl.org/resources/contribute-documentation)
identifies its [MIT-licensed source repository](https://github.com/XRPLF/xrpl-dev-portal/blob/master/LICENSE).
The collector reads only heading-linked blog entries from the public index, never
executes scripts, follows pagination or fetches article pages. It rejects an
unexpected origin/URL or empty changed layout, and caps input at 2 MiB. The listing
has dates without exact time/timezone; no publication instant is invented.
Helius explicitly allows `ai-input` for the default crawler in its
[robots policy](https://www.helius.dev/robots.txt) and advertises its RSS distribution
in its [guest author program](https://www.helius.dev/blog/guest-blog). Its large Atom
body may be up to 8 MiB only for this exact endpoint; bodies remain transient.
The GitHub and status feeds are notification-only defaults. Enabling collection
does not automatically grant AI permission. A release/prerelease does not establish
mainnet deployment; an archived incident does not establish an active outage.
XRPL blog/releases share `xrplf`; Ripple press/insights share `ripple`; Solana
foundation news/status share `solana-foundation`. None imply independent confirmation.

Six entries remain visible as **Needs setup**, with reasons in the dashboard:

- Ripple press releases and Insights: [terms section 3](https://ripple.com/legal/terms-of-use/)
  restrict robots/data extraction; an authorized feed/written permission is needed.
- Known Amendments: requires a separate amendment-state/network adapter; a changing
  reference table must not be ingested as invented breaking news.
- XRPScan metrics: separate authorized telemetry adapter, not an RSS news feed.
- Solana Foundation news: discovery received HTTP 429; no verified usable feed yet.
- SolanaFloor: no verified working RSS feed; crawling allowance does not itself
  grant article reuse/AI rights. Needs an authorized feed and permission review.

For the earlier directory candidates, public webpage parsing is not assumed to be
an API substitute: [CertiK terms](https://www.certik.com/company/terms-of-use) sections
3/5 prohibit automated access; [Whale Alert terms](https://whale-alert.io/terms-and-conditions.html)
article 4 restrict copying/publishing data. [CryptoPanic terms](https://cryptopanic.com/terms/)
do not provide an explicit scraping license; its [documented API](https://cryptopanic.com/developers/api/)
requires a provider token/plan. No login, access-control or paywall bypass is implemented.

CoinDesk, The Block, Cointelegraph and Decrypt remain candidates pending suitable
permissions. [The Block terms](https://www.theblock.co/terms-service) explicitly
restrict automated collection and AI processing; [CoinDesk terms](https://www.coindesk.com/terms)
and [Decrypt terms](https://decrypt.co/terms-of-service) restrict automated access.
CryptoPanic needs a separate provider API credential/plan. Telegram needs authorized
client/channel access. Exchange announcement sites, GDELT, FRED, security products,
and on-chain APIs need their specific adapters/access configuration; their website
URLs are not treated as RSS. The management page explains each case. No source is
silently replaced by fixtures when access fails. A reachable endpoint alone is
not permission to collect or process its content.

## Collection, timing and analysis

Two independent BullMQ queues run in separate containers. The collector reconciles
the registry every 30 seconds and maintains one persisted schedule per enabled
source, initially every five minutes. Manual requests still obey a one-minute
minimum request gap, daily request quota and provider backoff. Three attempts,
exponential backoff, Retry-After, and bounded completed/failed job retention prevent
hot loops. Sources expose last attempt/success, error, item counts and next eligible
request. Provider errors and access denials remain visible.

HTTPS targets require registered public origins, public DNS answers and a pinned
address; redirects, URL credentials, nonstandard ports and private addresses are
rejected. RSS/Atom parsing is bounded to 2 MiB (8 MiB for the registered Helius feed), 1,000 entries, XML depth/node limits,
and no DTD/entities. Feed bodies are discarded after parsing; only hashes and
permitted metadata/excerpts are stored.

Canonical URL plus source identifies an article. Content or permission changes
create immutable versions, while unchanged polls preserve the original first-seen
time. Initial feed snapshots can contain years-old articles: collecting them today
does not establish historical availability. Missing, ambiguous and future publisher
dates stay unknown/uncertain. `availableAt` records ingestion of the version, never
the publisher's historical date. Similar headlines are possible dependencies,
not additional verified facts or independent confirmations.

The analyzer queues recent pending versions (seven-day publication lookback) and
supports manual analysis of retained versions. Undated initial snapshots are manual-only; new undated
`LIVE_POLL` observations may use their actual collection availability time for queue
recency, without treating it as publication time. It sends only the headline and
permitted short excerpt. The response schema requires summary, assets, event type,
direction, severity, negation, exact supporting quotes and uncertainties. Invented
quotes/numbers, invalid JSON, truncation and inconsistent negation require review.
This validation cannot prove the model's interpretation is true. Official sources
are attributed as OFFICIALLY_STATED, never independently verified.

Model output is untrusted extraction, not a trading instruction. Models have no
tools and cannot fetch URLs or place orders. This addition does not change the
frozen market-only strategy, source hash or active paper-run deadline.

## Private AI settings

DeepSeek uses the compatible Chat Completions endpoint. The defaults are
`NEWS_AI_BASE_URL=https://api.deepseek.com` and `NEWS_AI_MODEL=deepseek-flash`.
`NEWS_AI_API_KEY` exists only in ignored local settings and protected server env
files, never in source, Docker images, browser responses, prompts or job payloads.
The deployed collector/API do not receive the AI key.

The local default budget is **100 outbound attempts per UTC day**, including
failed/uncertain calls. Every call reserves a durable PostgreSQL receipt before
sending. Budget exhaustion delays work until the next UTC day; duplicate successful
versions/profile requests reuse the stored result without another provider call.
Provider cooldown persists across analyzer restarts. A crash after the provider
accepts a request can still incur a repeated external charge; OpenAI-compatible
providers do not share a universal exactly-once billing contract. The local budget
counts these reservations conservatively. Usage is null when the provider's token
usage could not be obtained, rather than reported as zero.

To change provider, edit the private `/etc/crypto-trader/compose/news-analyzer.env`
values for base URL, model and key, then restart only `news-analyzer`. Compatible
public HTTPS providers accept the same request shape; DeepSeek-only thinking
options are omitted for other hosts. Prior analysis records retain model,
prompt/profile/input/response hashes, timestamps and reported usage. The UI shows
whether a credential is configured, never its value.

## Deployment and recovery

`news-api`, `news-collector`, and `news-analyzer` use an independent image layer over
the pinned existing runtime. The API listens privately on port 3103 and shares the
authenticated website boundary; gateway `/api/news/` routes to it. The main market
API and paper worker continue independently. Build `news-api` to produce the common
news/web image; use the existing Compose env file and production YAML.

`infra/compose/prepare-news.py` provisions database `crypto_news` and restricted
role `crypto_news_app` in the existing persistent PostgreSQL cluster. They are
separate from the paper ledger database. Article versions, polls, source history,
AI reservations and AI results are append-only. No credentials are stored in the
news tables. Server backups were disabled and removed at the user's request on
2026-11-08, including news dumps. The maintenance queue is paused and unscheduled;
do not recreate backups during deployments unless the user changes this policy.
Live article versions and frozen research reports remain in PostgreSQL.

```sh
docker compose --env-file /etc/crypto-trader/compose/project.env -f compose.production.yaml build news-api
docker compose --env-file /etc/crypto-trader/compose/project.env -f compose.production.yaml up -d --no-deps --wait news-api news-collector news-analyzer web
docker compose --env-file /etc/crypto-trader/compose/project.env -f compose.production.yaml logs --tail 60 news-collector news-analyzer
```

For local finite/integration development use isolated PostgreSQL/Redis fixtures,
`TEST_DATABASE_URL` and `TEST_REDIS_URL`. Run the new unit and integration tests,
then `pnpm check` and `pnpm run doctor`. The original local fixture dashboard still
works; its live-news page needs a configured news service/proxy. No real AI calls
are made by the automated fixture tests.
