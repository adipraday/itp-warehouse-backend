#!/usr/bin/env bash
# Generic MariaDB/MySQL backup for a docker-compose (app + db) project laid out
# like this one: a `db` service, a `.env` with DB_NAME/DB_ROOT_PASSWORD, run
# from a VPS via `docker compose`. Written for warehouse-system-api but
# deliberately reads everything from .env instead of hardcoding — see
# docs/deployment-vps.md "Menerapkan pola ini ke service lain" for how this
# exact script is reused for the sibling skinet-auth-api with zero edits,
# just a different PROJECT_DIR.
#
# What this does NOT do: copy the dump off this VPS. A dump sitting on the
# same disk as the live database does not survive a disk/VPS failure — see
# the OFFSITE_UPLOAD_CMD hook below and docs/deployment-vps.md's backup
# section for why that's still a separate, open decision (needs a storage
# target — S3/R2/B2/etc. — that hasn't been chosen yet).
#
# Usage:
#   ./backup-db.sh [compose-project-dir]
#   Defaults to this script's own parent's parent (assumes deploy/backup-db.sh).
#
# Cron (daily at 02:15, writing its own log — crontab does NOT get PATH/env
# from your login shell):
#   15 2 * * * /opt/warehouse-system-api/deploy/backup-db.sh >> /opt/warehouse-system-api/backups/backup.log 2>&1

set -euo pipefail

PROJECT_DIR="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
BACKUP_DIR="${BACKUP_DIR:-$PROJECT_DIR/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"

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

mkdir -p "$BACKUP_DIR"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
OUT_FILE="$BACKUP_DIR/${DB_NAME}-${TIMESTAMP}.sql.gz"
TMP_FILE="${OUT_FILE}.partial"

echo "[$(date -Iseconds)] Backing up '$DB_NAME' (project: $PROJECT_DIR) -> $OUT_FILE"

# --single-transaction: consistent InnoDB snapshot without locking tables
# (safe for a live app to keep writing during the dump). Written to a
# .partial name first and renamed only on success, so a failed/killed dump
# never leaves a half-written file that looks like a real backup.
docker compose exec -T db mariadb-dump -u root -p"$DB_ROOT_PASSWORD" \
  --single-transaction --quick --routines --triggers "$DB_NAME" \
  | gzip > "$TMP_FILE"
mv "$TMP_FILE" "$OUT_FILE"

SIZE=$(du -h "$OUT_FILE" | cut -f1)
echo "[$(date -Iseconds)] Done — $SIZE"

# Optional off-VPS copy — set OFFSITE_UPLOAD_CMD (e.g. in this script's cron
# environment or a wrapper) to something like:
#   OFFSITE_UPLOAD_CMD='rclone copy "$OUT_FILE" remote:warehouse-backups/'
# Left unset by default — see docs/deployment-vps.md, this is a real,
# currently-open gap, not solved by this script alone.
if [ -n "${OFFSITE_UPLOAD_CMD:-}" ]; then
  echo "[$(date -Iseconds)] Running OFFSITE_UPLOAD_CMD..."
  eval "$OFFSITE_UPLOAD_CMD"
else
  echo "[$(date -Iseconds)] NOTE: OFFSITE_UPLOAD_CMD not set — this backup only exists on this VPS's disk."
fi

# Rotation — delete this database's OWN backups older than RETENTION_DAYS.
# Scoped to "${DB_NAME}-*.sql.gz" so this is safe to point at a BACKUP_DIR
# shared by more than one database/project.
DELETED=$(find "$BACKUP_DIR" -maxdepth 1 -name "${DB_NAME}-*.sql.gz" -mtime "+$RETENTION_DAYS" -print -delete)
if [ -n "$DELETED" ]; then
  echo "[$(date -Iseconds)] Rotated out (older than ${RETENTION_DAYS}d):"
  echo "$DELETED"
fi

echo "[$(date -Iseconds)] Current backups for $DB_NAME:"
ls -lh "$BACKUP_DIR"/"${DB_NAME}"-*.sql.gz 2>/dev/null || echo "(none)"
