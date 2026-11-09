ARG APP_BASE=crypto-trader:paper-worker-v1
FROM ${APP_BASE}
COPY packages/contracts/src/telegram.ts /app/packages/contracts/src/
COPY packages/db/src/telegram-store.ts /app/packages/db/src/
COPY apps/api/src/telegram-client.ts apps/api/src/telegram-jobs.ts apps/api/src/telegram-main.ts /app/apps/api/src/
COPY infra/compose/healthcheck.mjs /app/infra/compose/
