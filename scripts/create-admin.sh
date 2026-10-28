#!/usr/bin/env bash
# Creates (or promotes) the first ADMIN user inside the running production stack.
# Usage: ./scripts/create-admin.sh admin@example.com 'Full Name' ['Branch name'] ['Branch address']
# The password is read from the terminal (not echoed, not stored in shell history).
# Set ADMIN_RESET_PASSWORD=true to change the password of an existing user.
set -euo pipefail

cd "$(dirname "$0")/.."
ENV_FILE=${ENV_FILE:-.env.production}
EMAIL=${1:?usage: $0 <email> <name> [branch name] [branch address]}
NAME=${2:?usage: $0 <email> <name> [branch name] [branch address]}
BRANCH=${3:-Head Office}
ADDRESS=${4:--}

read -rsp "Password for $EMAIL (min 10 chars, letters + digits): " PASSWORD; echo
read -rsp "Repeat password: " PASSWORD2; echo
[[ "$PASSWORD" == "$PASSWORD2" ]] || { echo "Passwords do not match" >&2; exit 1; }

docker compose -f docker-compose.prod.yml --env-file "$ENV_FILE" exec -T \
  -e ADMIN_EMAIL="$EMAIL" -e ADMIN_NAME="$NAME" -e ADMIN_PASSWORD="$PASSWORD" \
  -e ADMIN_BRANCH_NAME="$BRANCH" -e ADMIN_BRANCH_ADDRESS="$ADDRESS" \
  -e ADMIN_RESET_PASSWORD="${ADMIN_RESET_PASSWORD:-false}" \
  api node dist/seed/create-admin.js
