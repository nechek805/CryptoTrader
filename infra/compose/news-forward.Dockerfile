ARG APP_BASE=crypto-trader:news-v6
FROM ${APP_BASE}
COPY packages/contracts/src/news-forward.ts packages/contracts/src/telegram.ts /app/packages/contracts/src/
COPY packages/connectors/src/news-forward-exchanges.ts /app/packages/connectors/src/
COPY packages/paper/src/news-forward-engine.ts /app/packages/paper/src/
COPY packages/db/src/news-forward-store.ts packages/db/src/telegram-store.ts /app/packages/db/src/
COPY apps/api/src/news-forward-service.ts apps/api/src/news-forward-api.ts apps/api/src/news-forward-main.ts apps/api/src/news-forward-alerts-main.ts /app/apps/api/src/
COPY apps/api/src/telegram-client.ts apps/api/src/telegram-jobs.ts /app/apps/api/src/
COPY infra/compose/healthcheck.mjs /app/infra/compose/
