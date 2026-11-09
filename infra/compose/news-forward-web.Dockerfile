ARG APP_BASE=crypto-trader:news-v6-ui1
FROM ${APP_BASE}
COPY packages/contracts/src/news-forward.ts /app/packages/contracts/src/
COPY apps/web/app/news-paper /app/apps/web/app/news-paper
COPY apps/web/app/news-engine/workspace.tsx /app/apps/web/app/news-engine/
COPY apps/web/app/research-console.tsx /app/apps/web/app/
RUN cd /app/apps/web && NEWS_BUILD_NO_CACHE=1 node --max-old-space-size=512 node_modules/next/dist/bin/next build --webpack && rm -rf /app/apps/web/.next/cache
