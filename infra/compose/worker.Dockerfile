# Deploy operational queue changes independently of the slow archive-reading API.
ARG APP_BASE=crypto-trader:compose-v1
FROM ${APP_BASE}
COPY apps/api/src/live-paper-queue.ts apps/api/src/queue-command.ts apps/api/src/queue-main.ts /app/apps/api/src/
