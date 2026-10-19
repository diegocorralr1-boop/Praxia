#!/usr/bin/env bash
# Applies the numbered migrations in order to a Postgres database, stopping at the first error.
#
#   scripts/db/apply.sh "<DATABASE_URL>" [FROM]
#
#   DATABASE_URL  Supabase → Project Settings → Database → Connection string (URI). Never commit it.
#   FROM          first migration number to apply, e.g. 0006 (default: all). Migrations are not
#                 idempotent, so pass the first one that is NOT yet applied in that database.
#
# Example: scripts/db/apply.sh "$DATABASE_URL" 0006
set -euo pipefail
cd "$(dirname "$0")/../.."
URL="${1:?DATABASE_URL required}"; FROM="${2:-0000}"
for f in [0-9][0-9][0-9][0-9]_*.sql; do
  n="${f%%_*}"
  if [[ "$n" < "$FROM" ]]; then echo "skip  $f"; continue; fi
  echo "apply $f"
  psql "$URL" -v ON_ERROR_STOP=1 -q -f "$f"
done
echo "done"
