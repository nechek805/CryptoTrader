# SOL/XRP source expansion with a bounded licensed index adapter

Date: 2026-11-07. Status: accepted.

Register every source in the owner's `xrp_solana_news_sources.txt`, preserving
existing operator settings with insert-only seeding. Five collectors are enabled;
six entries retain visible setup notes rather than fabricated live data.

Use advertised Atom feeds for XRPLF releases, Anza Agave releases and Solana
status. These start as headline/link notifications with AI disabled. Helius's
public Atom feed and crawler policy permit metadata collection and AI input; its
large transient body has an endpoint-specific 8 MiB cap and hourly cadence.

Add `XRPL_BLOG` as an explicit adapter, restricted by Zod and the parser to the
official MIT-licensed blog index and origin. Extract heading-linked titles only,
never execute JavaScript or fetch article bodies. Missing layout entries fail
visibly. Listing dates without exact time/timezone remain unknown. Undated
initial snapshots require manual AI; later undated observations can be queued
using actual availability for recency, without inventing publication times.

Ripple terms restrict automated extraction. Amendment tables and metrics need
separate state/telemetry adapters. Solana news and SolanaFloor need verified
permitted collection endpoints. Robots allowance alone is not a license for
article copying or AI use. Shared publisher groups do not count as independent
confirmation, and releases/proposals do not establish mainnet activation.

No SQL table migration is required. Existing RSS/Atom configurations and article
versions remain valid. To roll back to the previous news image, first disable
`xrpl-blog` and save its adapter as `SETUP_REQUIRED` through the new API so the
old schema can parse the source directory. Keep all article and source-history
records. The market API, paper worker, strategy bytes and run deadline stay
independent of this news deployment.

Access references and operational details: [live news engine](../live-news-engine.md).
