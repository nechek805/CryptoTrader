FROM node:24.22.2-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm install --global pnpm@10.34.9 --ignore-scripts --no-audit --no-fund
COPY . .
RUN pnpm install --frozen-lockfile --network-concurrency 4 --child-concurrency 1
RUN NODE_OPTIONS=--max-old-space-size=512 pnpm web:build

# PostgreSQL 17 clients provide matching-version pg_dump/pg_restore for queue backups.
FROM postgres:17-bookworm AS runtime
COPY --from=build /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOME=/tmp
ENTRYPOINT []
CMD ["node", "--max-old-space-size=384", "--import", "tsx", "apps/api/src/operations-main.ts"]
