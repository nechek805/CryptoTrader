# Reuse the pinned dependencies and frozen financial engine of the deployed base.
ARG APP_BASE=crypto-trader:compose-v1
FROM ${APP_BASE}
COPY packages/contracts/src/live-news.ts packages/contracts/src/news-research.ts /app/packages/contracts/src/
COPY packages/contracts/src/news-research-v3.ts /app/packages/contracts/src/
COPY packages/contracts/src/news-research-v4.ts packages/contracts/src/news-research-v5.ts /app/packages/contracts/src/
COPY packages/contracts/src/news-research-v6.ts /app/packages/contracts/src/
COPY packages/db/src/live-news-store.ts packages/db/src/news-research-store.ts /app/packages/db/src/
COPY packages/research/src/news-history-study.ts /app/packages/research/src/
COPY packages/research/src/news-events-v3.ts packages/research/src/news-minute-windows.ts /app/packages/research/src/
COPY packages/research/src/news-events-v4.ts packages/research/src/news-long-history.ts packages/research/src/free-news-history.ts /app/packages/research/src/
COPY packages/backtest/src/news-history-replay.ts /app/packages/backtest/src/
COPY packages/backtest/src/news-history-v3.ts /app/packages/backtest/src/
COPY packages/backtest/src/news-history-v4.ts packages/backtest/src/news-history-v5.ts /app/packages/backtest/src/
COPY packages/backtest/src/news-history-v6.ts /app/packages/backtest/src/
COPY packages/research/src/news-frozen-markets-v5.ts /app/packages/research/src/
COPY packages/connectors/src/live-news-fetch.ts packages/connectors/src/live-news-feed.ts packages/connectors/src/live-news-xrpl.ts /app/packages/connectors/src/
COPY packages/connectors/src/free-news-sources.ts /app/packages/connectors/src/
COPY packages/news/src/live-source-catalog.ts packages/news/src/live-news-ai.ts packages/news/src/live-news-collector.ts /app/packages/news/src/
COPY apps/api/src/live-news-api.ts apps/api/src/live-news-queue.ts apps/api/src/news-main.ts apps/api/src/news-worker-main.ts apps/api/src/maintenance-main.ts /app/apps/api/src/
COPY apps/api/src/news-research-api.ts apps/api/src/news-research-jobs.ts apps/api/src/news-research-main.ts /app/apps/api/src/
COPY apps/api/src/news-research-v3-job.ts /app/apps/api/src/
COPY apps/api/src/news-research-v4-job.ts apps/api/src/news-research-v5-job.ts /app/apps/api/src/
COPY apps/api/src/news-research-v6-job.ts /app/apps/api/src/
COPY apps/web/next.config.ts /app/apps/web/
COPY apps/web/app/research-console.tsx /app/apps/web/app/
COPY apps/web/app/news-engine /app/apps/web/app/news-engine
COPY apps/web/app/news-strategy-tests /app/apps/web/app/news-strategy-tests
COPY infra/compose/healthcheck.mjs /app/infra/compose/
# Production mounts a fresh runtime cache; discard disposable compilation cache in this same layer.
RUN cd /app/apps/web && NEWS_BUILD_NO_CACHE=1 node --max-old-space-size=512 node_modules/next/dist/bin/next build --webpack && rm -rf /app/apps/web/.next/cache
