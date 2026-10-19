#!/usr/bin/env bash
# Full backup of the database (schema + data) in pg_dump custom format, restorable with pg_restore.
# Supabase Free has no automatic backups: run this at least weekly and keep the file OFF Supabase
# (encrypted drive, S3, etc.). The dump contains patient data: treat it as sensitive.
#
#   scripts/db/backup.sh "<DATABASE_URL>" [DIR]
#
# Restore (into an empty database):  pg_restore --no-owner --no-privileges -d "<DATABASE_URL>" <file>
set -euo pipefail
URL="${1:?DATABASE_URL required}"; DIR="${2:-backups}"
mkdir -p "$DIR"
OUT="$DIR/praxia-$(date +%Y%m%d-%H%M).dump"
pg_dump "$URL" --format=custom --no-owner --no-privileges \
  --schema=public --schema=auth --file "$OUT"
echo "wrote $OUT ($(du -h "$OUT" | cut -f1))"
