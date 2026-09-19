#!/usr/bin/env bash
# Generic MariaDB/MySQL restore, the counterpart to backup-db.sh. Same
# .env-driven design so this exact file works unmodified for the sibling
# skinet-auth-api too — see docs/deployment-vps.md.
#
# DELIBERATELY interactive and NOT wired into cron: restoring OVERWRITES the
# live database with the dump's contents. This script forces the operator to
# type the exact database name back before it touches anything, and refuses
# to run non-interactively (no stdin) so it can never be triggered by
# automation or by a stray script by accident.
#
# Usage:
#   ./restore-db.sh <path-to-dump.sql.gz> [compose-project-dir]

set -euo pipefail

DUMP_FILE="${1:-}"
PROJECT_DIR="${2:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

if [ -z "$DUMP_FILE" ]; then
  echo "Usage: $0 <path-to-dump.sql.gz> [compose-project-dir]" >&2
  exit 1
fi

if [ ! -f "$DUMP_FILE" ]; then
  echo "ERROR: dump file not found: $DUMP_FILE" >&2
  exit 1
fi

if [ ! -t 0 ]; then
  echo "ERROR: this script must be run interactively (no piped/redirected stdin)." >&2
  echo "       Restores are destructive and are not meant to be automated." >&2
  exit 1
fi

cd "$PROJECT_DIR"

if [ ! -f .env ]; then
  echo "ERROR: .env not found in $PROJECT_DIR" >&2
  exit 1
fi

DB_NAME=$(grep -E '^DB_NAME=' .env | head -1 | cut -d= -f2-)
DB_ROOT_PASSWORD=$(grep -E '^DB_ROOT_PASSWORD=' .env | head -1 | cut -d= -f2-)

if [ -z "$DB_NAME" ] || [ -z "$DB_ROOT_PASSWORD" ]; then
  echo "ERROR: DB_NAME or DB_ROOT_PASSWORD missing/empty in $PROJECT_DIR/.env" >&2
  exit 1
fi

echo "=============================================================="
echo " DESTRUCTIVE OPERATION"
echo "  Project:   $PROJECT_DIR"
echo "  Database:  $DB_NAME"
echo "  Dump file: $DUMP_FILE"
echo ""
echo " This will DROP/OVERWRITE existing tables in '$DB_NAME' with the"
echo " contents of the dump above. This cannot be undone."
echo "=============================================================="
read -r -p "Type the database name ($DB_NAME) to confirm, anything else cancels: " CONFIRM

if [ "$CONFIRM" != "$DB_NAME" ]; then
  echo "Confirmation did not match — aborted, nothing was touched."
  exit 1
fi

echo "[$(date -Iseconds)] Restoring '$DB_NAME' from $DUMP_FILE ..."
gunzip -c "$DUMP_FILE" | docker compose exec -T db mariadb -u root -p"$DB_ROOT_PASSWORD" "$DB_NAME"
echo "[$(date -Iseconds)] Restore complete."
