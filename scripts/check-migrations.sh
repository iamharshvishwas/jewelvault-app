#!/usr/bin/env bash
# T-F04 (BUILD): the migrations, checked as spec S9 and H5 ask.   npm run db:check
#
#   1. the rules of the files (names, versions, row-level security in the file that creates a table, and that a merged
#      migration was only ever added to);
#   2. the migrations applied to an empty database, and a fingerprint of the schema taken (the whole schema as pg_dump
#      writes it, the event triggers and default privileges included, plus the role settings, buckets and extensions a
#      dump leaves out);
#   3. the same again on a second empty database: the two fingerprints must be identical;
#   4. the Supabase advisor on the result must find no warning (local, security and performance).
# Dev and prod use these same files: there is one supabase/migrations folder and no seed in it (the seeds are local only).
#
#   scripts/check-migrations.sh                full check on the lane's stack (needs LANE)
#   scripts/check-migrations.sh --static [dir] the file rules only, no Docker (dir defaults to supabase/migrations)
#   scripts/check-migrations.sh --fingerprint  print the fingerprint of the lane's database as it is now
set -euo pipefail
cd "$(dirname "$0")/.."

lane() { node scripts/lane.mjs "$@"; }

case "${1:-}" in
  --static)
    shift
    exec node scripts/lane.mjs lint-migrations "$@"
    ;;
  --fingerprint)
    exec node scripts/lane.mjs fingerprint
    ;;
  "") ;;
  *)
    echo "usage: scripts/check-migrations.sh [--static [dir] | --fingerprint]" >&2
    exit 2
    ;;
esac

: "${LANE:?LANE is not set. Pick one of main, a, b, c, for example: LANE=a npm run db:check}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "== 1/4 the migration files"
lane lint-migrations

echo "== 2/4 first application to an empty database"
lane reset --no-seed
lane fingerprint > "$work/first.txt"
echo "   fingerprint: $(wc -l < "$work/first.txt" | tr -d ' ') lines"

echo "== 3/4 second application to an empty database"
lane reset --no-seed
lane fingerprint > "$work/second.txt"
if diff -u "$work/first.txt" "$work/second.txt" > "$work/diff.txt"; then
  echo "   the two schemas are identical"
else
  echo "FAILED: the migrations gave two different schemas on two empty databases (- the first, + the second):" >&2
  head -n 80 "$work/diff.txt" >&2
  exit 1
fi

echo "== 4/4 the advisor on the result"
lane advisors

echo "db:check passed"
