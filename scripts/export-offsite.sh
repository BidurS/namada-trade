#!/usr/bin/env bash
# The weekly copy of the production database kept off Cloudflare: all of namada-trade-db, schema and rows, read with
# `wrangler d1 export --remote` (a read: nothing in the database changes), gzipped and dated, into a folder the owner
# names outside this repository. D1 Time Travel goes back 30 days and lives inside Cloudflare; this copy is the one
# that survives the account.
# usage: scripts/export-offsite.sh [--dry-run] <folder>     e.g. scripts/export-offsite.sh /Volumes/Backup/namada-trade
#   The folder must already exist: it is never created, so a typing slip or a disk that is not mounted does not leave
#   the copy somewhere else. A folder inside this repository, or inside any git working tree, is refused, so the copy
#   is never where it could be committed (*.sql is ignored here, *.gz is not).
#   --dry-run (or DRY_RUN=1) checks the folder and prints the file it would write, without reading the database.
#
# What the file holds: every table, kv included, so every user's settings sealed under SETTINGS_KEY (which is kept in
# no file; never store it beside these copies), session and API key hashes, Telegram connect rows and the alert
# claims. It is written with mode 600 (umask 077) and never printed.
# Cloudflare's docs (D1, import and export): "A running export will block other database requests", and wrangler
# warns that the database "will be unavailable to serve queries" meanwhile: the site's reads and the minute's writes
# wait or fail until it ends. Run it at a quiet hour; how long a full export of this database takes has not been
# measured. Export refuses a database with a virtual table; this one has none by design
# (migrations/0008_nav_search.sql, label_tokens).
set -euo pipefail
cd "$(dirname "$0")/.."
repo=$(pwd -P)
DRY=0
case "${DRY_RUN:-0}" in 0|'') ;; *) DRY=1 ;; esac
if [ "${1:-}" = "--dry-run" ]; then DRY=1; shift; fi
usage() { echo "usage: scripts/export-offsite.sh [--dry-run] <an existing folder outside this repository>"; exit 2; }
[ $# -eq 1 ] && [ -n "$1" ] || usage
case "$1" in -*) usage ;; esac
[ -d "$1" ] || { echo "FAIL $1 is not an existing folder (it is never created: mount the disk or make the folder first)"; exit 1; }
dir=$(cd "$1" && pwd -P)
case "$dir/" in "$repo/"*) echo "FAIL $dir is inside this repository ($repo): a copy of the database never goes there"; exit 1 ;; esac
if git -C "$dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "FAIL $dir is inside the git working tree of $(git -C "$dir" rev-parse --show-toplevel): a copy of the database never goes where it could be committed"; exit 1
fi
[ -w "$dir" ] || { echo "FAIL $dir is not writable"; exit 1; }
case "$dir/" in "$HOME/Desktop/"*|"$HOME/Documents/"*|"$HOME/Library/Mobile Documents/"*)
  echo "note: $dir may be synced to iCloud; the copy then leaves this machine too" ;;
esac

stamp=$(date -u +%Y-%m-%dT%H%MZ)
out="$dir/namada-trade-db-$stamp.sql.gz"
[ ! -e "$out" ] || { echo "FAIL $out already exists"; exit 1; }
if [ "$DRY" = 1 ]; then
  echo "dry run, not run: npx wrangler d1 export namada-trade-db --remote --skip-confirmation --output=<a part file in $dir>, then gzip -9 to $out (mode 600)"
  exit 0
fi

umask 077
part="$dir/.namada-trade-db-$stamp.sql.part"
trap 'rm -f "$part" "$out.part"' EXIT
echo "== export (a read; the database serves no other request while it runs)"
# --skip-confirmation answers wrangler's own warning (the database "will be unavailable to serve queries"), which is
# the reason for the quiet hour; the line naming the export's download link is dropped: that link opens the whole
# database to anyone who has it for an hour, and this output may end up in a log
npx wrangler d1 export namada-trade-db --remote --skip-confirmation --output="$part" 2>&1 | sed '/following URL manually/d'
# a whole export: the schema of the tables the site cannot do without (an export writes `CREATE TABLE flows (`, and
# `CREATE TABLE IF NOT EXISTS "d1_migrations"(` for wrangler's own), and rows
for t in flows kv holders metrics; do grep -Eq "CREATE TABLE (IF NOT EXISTS )?[\"'\`]?$t[\"'\` (]" "$part" || { echo "FAIL the export has no table $t: not kept"; exit 1; }; done
tables=$(grep -c '^CREATE TABLE' "$part" || true)
inserts=$(grep -c '^INSERT INTO' "$part" || true)
gzip -9 -c "$part" > "$out.part"
gzip -t "$out.part"
mv "$out.part" "$out"
chmod 600 "$out"
rm -f "$part"
trap - EXIT
echo "ok   $out"
echo "     $tables tables, $inserts insert statements, $(du -h "$out" | cut -f1) gzipped, sha256 $(shasum -a 256 "$out" | cut -d' ' -f1)"
