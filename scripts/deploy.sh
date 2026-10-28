#!/usr/bin/env bash
# Builds the image, applies migrations and (re)starts the production stack.
# Usage: ./scripts/deploy.sh            (run from anywhere; uses .env.production)
set -euo pipefail

cd "$(dirname "$0")/.."
ENV_FILE=${ENV_FILE:-.env.production}
COMPOSE=(docker compose -f docker-compose.prod.yml --env-file "$ENV_FILE")

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE. Create it from .env.production.example first." >&2
  exit 1
fi
if grep -qE '=CHANGE_ME|example\.com' "$ENV_FILE"; then
  echo "$ENV_FILE still contains placeholder values (CHANGE_ME / example.com)." >&2
  exit 1
fi
chmod 600 "$ENV_FILE"

echo "==> Building image"
"${COMPOSE[@]}" build api

echo "==> Starting database"
"${COMPOSE[@]}" up -d --wait db

echo "==> Applying migrations"
"${COMPOSE[@]}" run --rm migrate

echo "==> Starting API and proxy"
"${COMPOSE[@]}" up -d --no-deps --wait api
"${COMPOSE[@]}" up -d caddy

echo "==> Status"
"${COMPOSE[@]}" ps
echo
echo "Done. Health check: curl -fsS https://\$API_DOMAIN/api/health"
echo "First deploy? Create the admin:  ./scripts/create-admin.sh"
