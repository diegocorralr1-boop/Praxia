#!/usr/bin/env bash
# Builds a throwaway database with a stand-in for Supabase's auth schema, applies every migration
# in order, then runs each tests/sql/test_*.sql. Any failed assertion stops the run with exit 1.
#
#   PGURL=postgres://postgres:postgres@localhost:5432/postgres npm run test:sql
#
# Locally without Postgres installed:  docker run --rm -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16
set -euo pipefail
cd "$(dirname "$0")/.."
PGURL="${PGURL:-postgres://postgres:postgres@localhost:5432/postgres}"
DB="praxia_test"
ADMIN_URL="${PGURL%/*}/postgres"
TEST_URL="${PGURL%/*}/$DB"
psql "$ADMIN_URL" -q -X -v ON_ERROR_STOP=1 -c "drop database if exists $DB" -c "create database $DB"
P=(psql "$TEST_URL" -q -X -v ON_ERROR_STOP=1)
"${P[@]}" -f tests/sql/mock_supabase.sql
for f in [0-9][0-9][0-9][0-9]_*.sql; do echo "migration $f"; "${P[@]}" -f "$f" > /dev/null; done
"${P[@]}" -f tests/sql/harness.sql
fail=0
for t in tests/sql/test_*.sql; do
  echo "== $t"
  # each test runs inside begin/rollback, so files never see each other's data
  if { echo "begin;"; cat "$t"; echo "rollback;"; } | "${P[@]}" -f - > "/tmp/$(basename "$t").out" 2>&1; then echo "   ok"; else echo "   FAILED"; tail -30 "/tmp/$(basename "$t").out"; fail=1; fi
done
exit $fail
