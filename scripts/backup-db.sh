#!/usr/bin/env bash
# Writes a compressed pg_dump of the production database to ./backups (keeps the last 14).
# Schedule it with cron, e.g.:  0 3 * * * /opt/stockpulse/scripts/backup-db.sh
# Restore: gunzip -c backups/<file>.sql.gz | docker compose -f docker-compose.prod.yml \
#          --env-file .env.production exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
set -euo pipefail

cd "$(dirname "$0")/.."
ENV_FILE=${ENV_FILE:-.env.production}
KEEP=${KEEP:-14}
mkdir -p backups
FILE="backups/stockpulse-$(date +%Y%m%d-%H%M%S).sql.gz"

docker compose -f docker-compose.prod.yml --env-file "$ENV_FILE" exec -T db \
  sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --clean --if-exists' \
  | gzip > "$FILE"
chmod 600 "$FILE"
echo "Backup written to $FILE"

ls -1t backups/stockpulse-*.sql.gz | tail -n +"$((KEEP + 1))" | xargs -r rm --
