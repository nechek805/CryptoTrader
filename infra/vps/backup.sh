#!/bin/sh
set -eu
umask 077
if [ "${BACKUPS_ENABLED:-0}" != "1" ]; then
  echo 'Database backups disabled'
  exit 0
fi
target=/var/backups/crypto-trader
mkdir -p "$target"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
tmp="$target/$stamp.dump.partial"
docker exec crypto-trader-postgres pg_dump -U cryptotrader -d cryptotrader -Fc > "$tmp"
docker exec -i crypto-trader-postgres pg_restore --list < "$tmp" > /dev/null
mv "$tmp" "$target/$stamp.dump"
# This directory belongs only to this deployment; never touch unrelated backups.
find "$target" -maxdepth 1 -type f -name '*.dump' -mtime +7 -delete
