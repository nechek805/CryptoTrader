# Persistent simulated paper broker

Module 12 implements four isolated virtual spot portfolios. Public market data is read-only.
No exchange account, key, trade submission, withdrawal or private SDK capability exists.
Balances and fills are SIMULATED; virtual execution does not establish real fill quality.

## Commands

Use Node 24.22.2 / pnpm 10.34.9 and the local runtime setup in README.

```powershell
pnpm paper start --feed synthetic --directory data/paper/my-synthetic-day
pnpm paper status --directory data/paper/my-synthetic-day
pnpm paper replay --directory data/paper/my-synthetic-day
pnpm paper snapshot --directory data/paper/my-synthetic-day
pnpm --silent paper export --directory data/paper/my-synthetic-day
pnpm paper stop --directory data/paper/my-synthetic-day
```

Synthetic startup advances one virtual day immediately and stops. It is not a 24-hour
wall-clock production observation. Initialization requires an empty directory. Evidence
is never replaced. `start --resume true` resumes an interrupted matching manifest.
Changed code/configuration or a killed/stopped trial requires a new experiment.

Public mode requires an explicit reviewed paper-config.v1 file, current code hash,
PUBLIC_READ_ONLY origin, approved adapter/license review and valid instrument metadata:

```powershell
pnpm paper start --feed public --manifest paper-config.json --directory data/paper/new-public-run
pnpm paper pause --directory data/paper/new-public-run
pnpm paper resume --directory data/paper/new-public-run
pnpm paper kill --directory data/paper/new-public-run
pnpm paper stop --directory data/paper/new-public-run
```

Fixture commands do not launch public runs. Module 10/11 adapters can enqueue computed
DecisionRecord proposals; absence of an admitted candidate remains cash/HOLD. Public data
is never replaced by fixtures. The adapter supports one BTC/USDT, ETH/USDT or SOL/USDT
spot instrument per service. Other providers/instruments require review and a new freeze.

## Accounting and execution

Reuse Module 08's balanced SpotLedger and canonical simulated orders/fills. Each arm owns
independent free/reserved cash and inventory. Validate manifest, risk policy, code, current
own-account state, source origin, quote evidence, clocks, precision and fee ceilings before
reserving funds. Signal identity includes strategy/portfolio/signal/version. Retries never
reserve or fill twice. Lifecycle includes proposal, risk rejection, acceptance, open,
partial, filled, cancelled, expired and unknown states with canonical transition history.

Delayed pre-order observations cannot fill. Market fills require later bid/ask evidence,
modeled slippage, known quantity and participation limits. Independent arms receive the
same hypothetical capacity; orders within one arm share it. Limits require strict trade-
through, opposing aggressor and exhaustion of a frozen assumed queue. Price touch is
insufficient. Queue priority remains unknown and modeled, never guaranteed.

Stops/targets create inventory-backed child orders. Their next eligible quote supplies
the execution price after modeled latency; a gap can fill below the stop. Fees use exact
decimals and conservative rounding, including per-lot reservation allowance. Every fill
references market evidence and journal postings. Cash plus holdings reconciles with cost
basis, realized/unrealized net PnL, exposure and drawdown. Invalid/stale prices leave held-
asset equity null. Pause/kill cancels entry reservations; eligible protective exits may
still reduce risk. Stop retains holdings. A killed manifest cannot resume.

## Persistence and operations

The versioned store has immutable config.json, synced event files under events/, exact-
prefix snapshots under snapshots/ and operator/producer requests under requests/. An
exclusive hard link publishes each complete staging file. Torn staging is ignored;
altered committed events fail semantic replay. One writer lock serializes changes.
`paper recover --directory ...` requires proving its recorded PID no longer exists.
Snapshots must match a committed prefix; the current restore deliberately replays the
authoritative event log. Filesystem hashes do not defeat an owner rewriting all evidence.
Off-host backup and power-loss behavior require deployment-filesystem validation.

News TTLs, market/trade outages, skew, bad content, source validation, metadata and license
changes create content-free alerts. Invalid license/metadata kills new risk. Daily
reconciliation and transaction exports retain exact hashes. Source exhaustion pauses.

The frozen sampling policy is IDLE_30S_ACTIVE_100MS_RELEVANT_TRADES_V1: idle quotes/timers
every 30 seconds, faster quotes during active orders, and trade packets relevant to
outstanding limits. This is a sampled broker stream, not a full exchange tick archive.
Retries/queues are bounded. A run halts before 200,000 events, 10,000 orders or 50,000 fills;
snapshots cap at 256 MiB. Review coverage/storage before a long trial. Budget exhaustion
is an interrupted experiment, never a secret restart. Perpetuals/funding/borrowing remain
disabled. The public grammar follows the provider's
[official specification](https://github.com/binance/binance-spot-api-docs/blob/master/web-socket-streams.md).
Trade IDs retain exact integer tokens and explicit millisecond clocks. An operator review
hash does not itself grant rights to public data.

## Acceptance and handoff

Twenty-three focused tests pass. The persisted CLI soak at data/paper/module12-soak has
1,477 events, nine fills, 14 alerts and a reconciled ledger. Baseline ends at 10,000 USDT;
each active arm ends at 9,938.90306767 after the synthetic gap and costs. No profitable
result is fabricated. Status, replay and snapshot agree.

Log head: sha256:7f083d0deef47f84d3d41eef4533a8110c2d68b0b8943ad526b6cc82be51f85d.
Report hash: sha256:d1b088e7283b885c879a151b589e7417a91b94bf0d9d9d5a445c628ffb36f2ff.
Module 13 receives exact fills, decisions, journal, equity and source alerts. See ADRs
0031–0033. Real forward observation remains a separately eligible experiment.
